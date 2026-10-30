/**
 * Regression tests for EWS incremental sync (EwsSource.fetchSince).
 *
 * Bugs fixed:
 * 1. `<m:SyncScope>NormalItems</m:SyncScope>` made Exchange omit meeting/cancel
 *    items entirely, so approvals forwarded as calendar invitations were never
 *    ingested and no error was ever raised.
 * 2. When `IncludesLastItemInRange=false` the adapter returned `moreAvailable`
 *   but never drained the remaining pages, so changes behind page one were
 *    dropped until the next run's (shorter) fallback window missed them.
 * 3. `<t:Delete>` entries were ignored, so a moved/deleted item could be
 *    re-ingested as new on the FindItem fallback.
 */
import { describe, it, expect, vi } from 'vitest';
import { EwsSource } from '../src/mail/adapters/EwsSource';

const success = (inner: string) => `<?xml version="1.0"?><soap:Envelope xmlns:soap="s"><soap:Body>
<m:SyncFolderItemsResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <m:ResponseMessages><m:SyncFolderItemsResponseMessage ResponseClass="Success">
    <m:ResponseCode>NoError</m:ResponseCode>${inner}
  </m:SyncFolderItemsResponseMessage></m:ResponseMessages>
</m:SyncFolderItemsResponse></soap:Body></soap:Envelope>`;

const T = 'xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"';

/** Builds a Create block with globally unique item ids across calls. */
let fixtureIdSeq = 0;
const createBlock = (n: number) =>
  `<m:Create>${Array.from({ length: n }, () => `<t:Message ${T}><t:ItemId Id="ID${(fixtureIdSeq += 1)}" ChangeKey="CK${fixtureIdSeq}"/></t:Message>`).join('')}</m:Create>`;

function makeSource(responses: Array<(soap: string) => string>) {
  const source = new EwsSource({ folderName: 'InApprovals' });
  const seen: string[] = [];
  let call = 0;
  vi.spyOn(source as any, 'ewsRequest').mockImplementation(async (soap: string) => {
    seen.push(soap);
    const fn = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return fn(soap);
  });
  // GetItem payloads are covered by ews-xml-parser.test.ts; stub the fetch here.
  vi.spyOn(source as any, 'getItemsBatch').mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({
      id,
      changeKey: 'CK',
      messageId: `<${id}@x>`,
      conversationId: id,
      subject: `s-${id}`,
      sender: 'a@x',
      receivedAt: '2026-10-30T10:00:00.000Z',
      htmlBody: '<p>x</p>',
    })),
  );
  return { source, seen };
}

describe('EwsSource.fetchSince sync scope and paging', () => {
  it('requests AllItems so meeting-based approvals are not skipped', async () => {
    const { source, seen } = makeSource([
      () => success(`<m:Changes>${createBlock(1)}</m:Changes><m:IncludesLastItemInRange>true</m:IncludesLastItemInRange><m:SyncState>TOKEN1</m:SyncState>`),
    ]);

    await source.fetchSince({ folderName: 'InApprovals', lastSyncedAt: new Date(0).toISOString() }, 50);

    const syncCall = seen.find((s) => s.includes('SyncFolderItems'));
    expect(syncCall).toBeDefined();
    expect(syncCall).toContain('<m:SyncScope>AllItems</m:SyncScope>');
    expect(syncCall).not.toContain('NormalItems');
  });

  it('drains every page while IncludesLastItemInRange is false', async () => {
    const { source, seen } = makeSource([
      () => success(`<m:Changes>${createBlock(3)}</m:Changes><m:IncludesLastItemInRange>false</m:IncludesLastItemInRange><m:SyncState>TOKEN_P1</m:SyncState>`),
      () => success(`<m:Changes>${createBlock(2)}</m:Changes><m:IncludesLastItemInRange>true</m:IncludesLastItemInRange><m:SyncState>TOKEN_P2</m:SyncState>`),
    ]);

    // maxItems is the GetItem budget; MaxChangesReturned is capped separately at
    // 250, so a budget of 10 still lets both pages drain fully in one run.
    const result = await source.fetchSince(
      { folderName: 'InApprovals', token: 'TOKEN0', lastSyncedAt: new Date(0).toISOString() },
      10,
    );

    const syncCalls = seen.filter((s) => s.includes('SyncFolderItems'));
    expect(syncCalls.length).toBe(2);
    // Page two must resume from the token Exchange just handed back.
    expect(syncCalls[1]).toContain('<m:SyncState>TOKEN_P1</m:SyncState>');
    expect(result.messages).toHaveLength(5);
    expect(result.nextCursor.token).toBe('TOKEN_P2');
    expect(result.moreAvailable).toBe(false);
  });

  it('defers changes beyond the batch budget and rewinds the token', async () => {
    const { source } = makeSource([
      () => success(`<m:Changes>${createBlock(6)}</m:Changes><m:IncludesLastItemInRange>true</m:IncludesLastItemInRange><m:SyncState>TOKEN_P1</m:SyncState>`),
    ]);

    const result = await source.fetchSince(
      { folderName: 'InApprovals', token: 'TOKEN0', lastSyncedAt: new Date(0).toISOString() },
      3,
    );

    expect(result.messages).toHaveLength(3);
    expect(result.moreAvailable).toBe(true);
    // Advancing to TOKEN_P1 here would drop ID3-ID5 forever.
    expect(result.nextCursor.token).toBe('TOKEN0');
  });

  it('stops draining at the page cap instead of looping forever', async () => {
    const { source, seen } = makeSource([
      () => success(`<m:Changes>${createBlock(1)}</m:Changes><m:IncludesLastItemInRange>false</m:IncludesLastItemInRange><m:SyncState>LOOP</m:SyncState>`),
    ]);

    const result = await source.fetchSince(
      { folderName: 'InApprovals', token: 'TOKEN0', lastSyncedAt: new Date(0).toISOString() },
      1,
    );

    expect(seen.filter((s) => s.includes('SyncFolderItems')).length).toBeLessThanOrEqual(10);
    expect(result.moreAvailable).toBe(true);
  });

  it('does not re-ingest deleted items', async () => {
    const { source } = makeSource([
      () =>
        success(
          `<m:Changes>${createBlock(1)}<m:Delete><t:ItemGroup ${T}><t:ItemId Id="GONE" ChangeKey="CK9"/></t:ItemGroup></m:Delete></m:Changes>` +
            '<m:IncludesLastItemInRange>true</m:IncludesLastItemInRange><m:SyncState>T2</m:SyncState>',
        ),
    ]);

    const result = await source.fetchSince(
      { folderName: 'InApprovals', token: 'T1', lastSyncedAt: new Date(0).toISOString() },
      10,
    );

    expect(result.messages.map((m) => m.id)).toEqual(['ID23']);
    expect(result.deletedItemIds).toEqual(['GONE']);
  });

  it('reports the highest DateTimeReceived so the caller can persist a durable watermark', async () => {
    const { source } = makeSource([
      () => success(`<m:Changes>${createBlock(1)}</m:Changes><m:IncludesLastItemInRange>true</m:IncludesLastItemInRange><m:SyncState>T3</m:SyncState>`),
    ]);

    const result = await source.fetchSince(
      { folderName: 'InApprovals', token: 'T2', lastSyncedAt: new Date(0).toISOString() },
      10,
    );

    expect(result.highestReceivedAt).toBe('2026-10-30T10:00:00.000Z');
  });
});
