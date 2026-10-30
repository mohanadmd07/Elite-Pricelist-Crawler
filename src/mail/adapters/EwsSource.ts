/**
 * EWS Source Adapter
 * Connects directly to Exchange Web Services (EWS) over HTTPS/TLS using NTLM authentication.
 * Implements incremental synchronization via SyncFolderItems and batch retrieval via GetItem.
 */

// @ts-ignore
import httpntlm from 'httpntlm';
import { AttachmentMeta, MailCursor, MailSource, MailSyncResult, RawMailMessage } from '../types';
import { parseGetItemsResponse, parseSyncFolderItemsResponse } from './ewsXml';

/** EWS accepts at most 50 items per GetItem call; stay under it with headroom. */
const GETITEM_CHUNK_SIZE = 25;

/** Safety cap on SyncFolderItems pages drained per run, so a huge backlog cannot
 *  turn one invocation into an unbounded loop against a throttling server. */
const MAX_SYNC_PAGES = 10;

/** Overlap subtracted from the durable watermark when recovering via FindItem. */
const FALLBACK_OVERLACK_HOURS = 6;

/** Hard floor for recovery queries; matches the folder's practical retention. */
const FALLBACK_MAX_LOOKBACK_DAYS = 30;

/** Recovery window for a first-ever run with no stored watermark. */
const FALLBACK_DEFAULT_DAYS_BACK = 3;

const DISTINGUISHED_FOLDERS = ['inbox', 'drafts', 'deleteditems', 'sentitems', 'msgfolderroot'];

/** Escapes a value for use inside a double-quoted XML attribute. */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Counts failed response elements so partial batches are visible in logs. */
function countErrorResponses(xml: string): number {
  return (xml.match(/ResponseClass="Error"/g) || []).length;
}

/**
 * Honors Exchange's throttle contract: a 503 carries a mandatory RetryAfter
 * header, and SOAP faults carry BackOffPeriod ("N seconds until retry allowed").
 * Falls back to exponential backoff with jitter when the server gives no hint.
 */
function retryDelayMs(err: any, attempt: number): number {
  const message = `${err?.message || err || ''} ${err?.responseBody || ''}`;

  const backOff = message.match(/(\d+)\s*seconds\s*until\s*retry/i);
  if (backOff) return Math.min(Number(backOff[1]) * 1000, 60_000);

  const retryAfter = message.match(/Retry-After["']?\s*[:=]\s*"?(\d+)/i);
  if (retryAfter) return Math.min(Number(retryAfter[1]) * 1000, 60_000);

  const base = 1000 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * 250);
}

export const EXACT_INAPPROVALS_FOLDER_ID =
  'AAMkAGU5Y2EzNmMxLTIwZDItNDcxOC05ZTk0LTBlODJjZjkxOGU5NgAuAAAAAAA4U9epEFcNRbR5QhtWJDZyAQCVKjW+UMYOTr9U/HR/zy7WAAActvclAAA=';

export interface EwsConfig {
  url: string;
  username: string;
  password: string;
  domain: string;
  folderName: string;
}

export const DEFAULT_OUTLOOK_SIGNATURE_HTML = `
<br><br>
<table class="MsoNormalTable" border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse">
  <tbody>
    <tr>
      <td style="padding: 0cm 5.4pt;">
        <p class="MsoNormal" style="margin: 0cm; font-size: 9.5pt; font-family: 'Maiandra GD', Calibri, sans-serif; color: gray;">
          <b>Mohanad M. El Maamoun</b><br>
          Duty Manager | Elite Hospital<br>
          <b><u>Mob.:</u></b> &nbsp; 01148085552<br>
          <b><u>Email:</u></b> &nbsp; <a href="mailto:Mohanad.elmaamoun@elitehospital.org" style="color: #467886; text-decoration: underline;">Mohanad.elmaamoun@elitehospital.org</a>
        </p>
      </td>
    </tr>
  </tbody>
</table>`;

export const DEFAULT_OUTLOOK_SIGNATURE_TEXT = `

Mohanad M. El Maamoun
Duty Manager | Elite Hospital
Mob.:    01148085552
Email:  Mohanad.elmaamoun@elitehospital.org`;

export interface CreateDraftParams {
  itemId?: string;
  changeKey?: string;
  messageId?: string;
  conversationId?: string;
  subject: string;
  body: string;
  to?: string;
  signatureHtml?: string;
  signatureText?: string;
}

export class EwsSource implements MailSource {
  private config: EwsConfig;

  constructor(config?: Partial<EwsConfig>) {
    const rawUser = config?.username || process.env.EXCHANGE_USER || process.env.IMAP_USER || '';
    const cleanUser = rawUser.includes('@') ? rawUser.split('@')[0] : rawUser;

    this.config = {
      url: config?.url || process.env.EWS_URL || `https://${process.env.IMAP_HOST || 'wmail.elitehospital.org'}/EWS/Exchange.asmx`,
      username: cleanUser,
      password: config?.password || process.env.EXCHANGE_PASSWORD || process.env.IMAP_PASSWORD || '',
      domain: config?.domain || process.env.EXCHANGE_DOMAIN || 'elitehospital',
      folderName: config?.folderName || process.env.EWS_FOLDER || process.env.IMAP_FOLDER || 'InApprovals',
    };
  }

  /**
   * Executes an NTLM-authenticated SOAP request to the EWS endpoint.
   */
  public async ewsRequest(soapBody: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.config.username || !this.config.password) {
        return reject(new Error('EWS credentials (username/password) are not configured.'));
      }

      httpntlm.post(
        {
          url: this.config.url,
          username: this.config.username,
          password: this.config.password,
          domain: this.config.domain,
          body: soapBody,
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
          },
          rejectUnauthorized: false,
        },
        (err: any, res: any) => {
          if (err) return reject(err);
          if (res.statusCode !== 200) {
            return reject(new Error(`EWS HTTP ${res.statusCode}: ${res.body?.substring(0, 300)}`));
          }
          resolve(res.body);
        }
      );
    });
  }

  /**
   * Tests connectivity to EWS endpoint.
   */
  public async testConnection(): Promise<{ ok: boolean; message: string }> {
    const testSoap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:FindFolder Traversal="Shallow">
      <m:FolderShape>
        <t:BaseShape>IdOnly</t:BaseShape>
      </m:FolderShape>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="inbox"/>
      </m:ParentFolderIds>
    </m:FindFolder>
  </soap:Body>
</soap:Envelope>`;

    try {
      const response = await this.ewsRequest(testSoap);
      if (response.includes('FindFolderResponse') && response.includes('ResponseClass="Success"')) {
        return { ok: true, message: 'Successfully authenticated with Exchange EWS.' };
      }
      return { ok: false, message: `EWS response: ${response.substring(0, 200)}` };
    } catch (err: any) {
      return { ok: false, message: `Failed to connect to EWS: ${err.message || err}` };
    }
  }

  /**
   * Resolves the FolderId for a named folder or returns distinguished folder id.
   */
  public async resolveFolderId(folderName: string): Promise<string> {
    const raw = folderName || this.config.folderName || 'InApprovals';
    const lower = raw.toLowerCase();
    if (lower === 'inapprovals' || raw.startsWith('AAMk') || raw.startsWith('AQMk')) {
      return EXACT_INAPPROVALS_FOLDER_ID;
    }
    if (['inbox', 'drafts', 'deleteditems', 'sentitems', 'msgfolderroot'].includes(lower)) {
      return lower;
    }

    const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:FindFolder Traversal="Deep">
      <m:FolderShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="folder:DisplayName"/>
        </t:AdditionalProperties>
      </m:FolderShape>
      <m:IndexedPageFolderView MaxEntriesReturned="100" Offset="0" BasePoint="Beginning"/>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="msgfolderroot"/>
      </m:ParentFolderIds>
    </m:FindFolder>
  </soap:Body>
</soap:Envelope>`;

    try {
      const xml = await this.ewsRequest(soap);
      const regex = new RegExp(
        `<t:Folder>[\\s\\S]*?<t:FolderId Id="([^"]+)" ChangeKey="([^"]+)"[\\s\\S]*?<t:DisplayName>${raw}<\\/t:DisplayName>[\\s\\S]*?<\\/t:Folder>`,
        'i'
      );
      const match = xml.match(regex);
      if (match) return match[1];
    } catch (err) {
      console.warn(`[EWS Source] Failed to dynamically resolve folder "${raw}", falling back to default.`, err);
    }

    return EXACT_INAPPROVALS_FOLDER_ID;
  }

  /**
   * Finds recent items in an Exchange folder with date restriction and pagination.
   */
  public async findItemsInFolder(
    folderId: string,
    maxEntries = 100,
    sinceDateIso?: string
  ): Promise<Array<{ id: string; subject: string; dateTimeReceived?: string }>> {
    const isDistinguished = ['inbox', 'drafts', 'deleteditems', 'sentitems', 'msgfolderroot'].includes(folderId.toLowerCase());
    const folderXml = isDistinguished
      ? `<t:DistinguishedFolderId Id="${folderId}"/>`
      : `<t:FolderId Id="${folderId}"/>`;

    const restrictionXml = sinceDateIso
      ? `
      <m:Restriction>
        <t:IsGreaterThanOrEqualTo>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURIOrConstant>
            <t:Constant Value="${sinceDateIso}"/>
          </t:FieldURIOrConstant>
        </t:IsGreaterThanOrEqualTo>
      </m:Restriction>`
      : '';

    const allResults: Array<{ id: string; subject: string; dateTimeReceived?: string }> = [];
    const pageSize = Math.min(maxEntries, 250);

    const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="${pageSize}" Offset="0" BasePoint="Beginning"/>
      ${restrictionXml}
      <m:SortOrder>
        <t:FieldOrder Order="Descending">
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
        </t:FieldOrder>
      </m:SortOrder>
      <m:ParentFolderIds>
        ${folderXml}
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>`;

    try {
      const xml = await this.ewsRequest(soap);
      const itemMatches = xml.matchAll(/<t:Message>([\s\S]*?)<\/t:Message>/g);
      for (const match of itemMatches) {
        const msgBlock = match[1];
        const idMatch = msgBlock.match(/<t:ItemId Id="([^"]+)"/);
        const subjMatch = msgBlock.match(/<t:Subject>([^<]*)<\/t:Subject>/);
        const dateMatch = msgBlock.match(/<t:DateTimeReceived>([^<]*)<\/t:DateTimeReceived>/);
        if (idMatch) {
          allResults.push({
            id: idMatch[1],
            subject: subjMatch ? subjMatch[1] : '',
            dateTimeReceived: dateMatch ? dateMatch[1] : undefined,
          });
        }
      }
    } catch (err) {
      console.warn(`[EWS Source] Error finding items in folder "${folderId}":`, err);
    }

    return allResults;
  }

  /**
   * Fetches full message details in batch for a list of EWS item IDs.
   * Requests only the properties the ingestion pipeline needs (AllProperties pulls
   * attachment payloads and unused MAPI blobs, which is how large batches time out).
   */
  public async getItemsBatch(itemIds: string[]): Promise<RawMailMessage[]> {
    if (itemIds.length === 0) return [];

    const requested = [...new Set(itemIds.filter(Boolean))];
    const collected: RawMailMessage[] = [];

    // EWS caps items per GetItem call; chunk so one oversized request can't fail
    // the whole batch and lose every message behind it.
    for (let i = 0; i < requested.length; i += GETITEM_CHUNK_SIZE) {
      const chunk = requested.slice(i, i + GETITEM_CHUNK_SIZE);
      const messages = await this.getItemsChunk(chunk);
      collected.push(...messages);
    }

    return collected;
  }

  private async getItemsChunk(itemIds: string[]): Promise<RawMailMessage[]> {
    const idsXml = itemIds.map((id) => `<t:ItemId Id="${escapeXmlAttr(id)}"/>`).join('\n');

    const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="item:ConversationId"/>
          <t:FieldURI FieldURI="message:InternetMessageId"/>
          <t:FieldURI FieldURI="message:From"/>
          <t:FieldURI FieldURI="message:Body"/>
          <t:FieldURI FieldURI="message:IsRead"/>
          <t:FieldURI FieldURI="item:Attachments"/>
        </t:AdditionalProperties>
        <t:BodyType>HTML</t:BodyType>
      </m:ItemShape>
      <m:ItemIds>
        ${idsXml}
      </m:ItemIds>
    </m:GetItem>
  </soap:Body>
</soap:Envelope>`;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const xml = await this.ewsRequest(soap);
        const messages = parseGetItemsResponse(xml);

        const failed = countErrorResponses(xml);
        if (failed > 0) {
          console.warn(
            `[EWS Source] GetItem chunk returned ${failed} failed item(s) of ${itemIds.length} requested ` +
              `(moved/deleted/expired). ${messages.length} parsed.`,
          );
        }

        return messages;
      } catch (err: any) {
        const isThrottled = String(err).includes('ErrorServerBusy') || String(err).includes('503');
        if (attempt < 3 && isThrottled) {
          const delay = retryDelayMs(err, attempt);
          console.warn(`[EWS Source] Exchange throttled GetItem; retrying in ${delay}ms.`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }

    return [];
  }

  /**
   * Incrementally fetches messages since the given cursor.
   *
   * Uses SyncFolderItems with `AllItems` scope (NormalItems silently omits
   * meeting-based approvals), drains every page while Exchange signals
   * `IncludesLastItemInRange=false`, separates deletes so moved/deleted items are
   * not re-ingested as new, and falls back to a FindItem window anchored on the
   * durable `watermarkReceivedAt` rather than wall-clock time.
   */
  public async fetchSince(
    cursor: MailCursor,
    maxItems: number = 50
  ): Promise<MailSyncResult & { deletedItemIds?: string[]; highestReceivedAt?: string }> {
    const folderId = await this.resolveFolderId(cursor.folderName || this.config.folderName);
    const isDistinguished = DISTINGUISHED_FOLDERS.includes(folderId.toLowerCase());
    const folderXml = isDistinguished
      ? `<t:DistinguishedFolderId Id="${folderId}"/>`
      : `<t:FolderId Id="${escapeXmlAttr(folderId)}"/>`;

    const pageSize = Math.min(maxItems, 250);
    const collectedIds: string[] = [];
    const deletedIds: string[] = [];
    let syncState = cursor.token;
    let moreAvailable = false;
    let page = 0;

    while (page < MAX_SYNC_PAGES) {
      page += 1;
      const syncStateXml = syncState ? `<m:SyncState>${syncState}</m:SyncState>` : '';

      const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:SyncFolderItems>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
      </m:ItemShape>
      <m:SyncFolderId>
        ${folderXml}
      </m:SyncFolderId>
      ${syncStateXml}
      <m:MaxChangesReturned>${pageSize}</m:MaxChangesReturned>
      <m:SyncScope>AllItems</m:SyncScope>
    </m:SyncFolderItems>
  </soap:Body>
</soap:Envelope>`;

      let xml: string;
      try {
        xml = await this.ewsRequest(soap);
      } catch (err: any) {
        if (String(err).includes('ErrorInvalidSyncStateData')) {
          console.warn('[EWS Source] Invalid SyncState token encountered; resetting token and requesting full sync.');
          return this.fetchSince({ ...cursor, token: undefined }, maxItems);
        }
        throw err;
      }

      const parsed = parseSyncFolderItemsResponse(xml);
      syncState = parsed.syncState || syncState;

      for (const change of parsed.changes) {
        if (change.kind === 'delete') {
          if (!deletedIds.includes(change.id)) deletedIds.push(change.id);
          continue;
        }
        if (!collectedIds.includes(change.id)) collectedIds.push(change.id);
      }

      moreAvailable = !parsed.includesLastItemInRange;
      if (parsed.includesLastItemInRange) break;
    }

    // Drain cap hit with changes still pending: keep the pre-sync token so the
    // next run replays the delta instead of pretending the folder is caught up.
    if (moreAvailable) {
      syncState = cursor.token;
      console.warn(`[EWS Source] ${MAX_SYNC_PAGES} sync pages drained with changes still pending; resuming from the stored token next run.`);
    }

    // Bound the GetItem fan-out to the caller's batch size. The ids we do not
    // fetch this run must be replayed next run, so keep the token from BEFORE
    // this call drained pages — Exchange replays the whole delta from it and the
    // pipeline dedupes on InternetMessageId. Advancing to the post-drain token
    // here would drop the deferred changes permanently.
    const idsToFetch = collectedIds.slice(0, maxItems);
    if (idsToFetch.length < collectedIds.length) {
      moreAvailable = true;
      syncState = cursor.token;
      console.warn(`[EWS Source] Deferring ${collectedIds.length - idsToFetch.length} change(s) beyond batch size ${maxItems}; resuming from the pre-sync token next run.`);
    }

    // If SyncFolderItems returned no items (e.g. initial token or empty delta),
    // fall back to a FindItem rolling window anchored on the durable watermark.
    if (idsToFetch.length === 0) {
      const sinceDateIso = this.fallbackWindowStart(cursor);
      console.log(`[EWS Source] SyncFolderItems returned 0 changes. Running FindItem fallback (since ${sinceDateIso})...`);
      const recentItems = await this.findItemsInFolder(folderId, maxItems, sinceDateIso);
      for (const item of recentItems) {
        if (!collectedIds.includes(item.id) && !deletedIds.includes(item.id)) {
          collectedIds.push(item.id);
        }
      }
      console.log(`[EWS Source] FindItem fallback discovered ${collectedIds.length} candidate items.`);
    }

    const messages = await this.getItemsBatch(idsToFetch);

    const highestReceivedAt = messages.reduce<string | undefined>((max, m) => {
      if (!m.receivedAt) return max;
      return !max || new Date(m.receivedAt) > new Date(max) ? m.receivedAt : max;
    }, cursor.watermarkReceivedAt);

    return {
      messages,
      deletedItemIds: deletedIds,
      highestReceivedAt,
      nextCursor: {
        folderName: cursor.folderName,
        token: syncState,
        lastSyncedAt: new Date().toISOString(),
        watermarkReceivedAt: highestReceivedAt,
        totalSyncedCount: (cursor.totalSyncedCount || 0) + messages.length,
      },
      moreAvailable,
    };
  }

  /**
   * Start of the FindItem recovery window. Prefers the last durably ingested
   * item timestamp (survives multi-day outages) over wall-clock heuristics, and
   * always overlaps backwards to absorb clock skew and late-arriving items.
   */
  private fallbackWindowStart(cursor: MailCursor): string {
    const overlapMs = FALLBACK_OVERLACK_HOURS * 60 * 60 * 1000;
    const anchor =
      cursor.watermarkReceivedAt ||
      (cursor.lastSyncedAt && cursor.lastSyncedAt !== new Date(0).toISOString()
        ? cursor.lastSyncedAt
        : undefined);

    if (anchor) {
      const start = new Date(new Date(anchor).getTime() - overlapMs).toISOString();
      // Never query further back than the retention horizon; that would pull
      // thousands of already-ingested items into every recovery run.
      const floor = new Date(Date.now() - FALLBACK_MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
      return start < floor ? floor : start;
    }

    return new Date(Date.now() - FALLBACK_DEFAULT_DAYS_BACK * 24 * 60 * 60 * 1000).toISOString();
  }

  /**
   * Searches for an email in Exchange by its InternetMessageId or ConversationId
   * to obtain the exact EWS ItemId and fresh ChangeKey required for in-thread Reply-All.
   */
  public async findItemByMessageIdOrConversation(
    messageId?: string,
    conversationId?: string,
    folderId: string = EXACT_INAPPROVALS_FOLDER_ID
  ): Promise<{ itemId: string; changeKey: string } | null> {
    const cleanMsgId = messageId ? messageId.replace(/&lt;|&gt;|<|>/g, '').trim() : '';

    // Step 1: Search by InternetMessageId
    if (cleanMsgId) {
      try {
        const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="message:InternetMessageId"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:Restriction>
        <t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase">
          <t:FieldURI FieldURI="message:InternetMessageId"/>
          <t:Constant Value="${cleanMsgId}"/>
        </t:Contains>
      </m:Restriction>
      <m:ParentFolderIds>
        <t:FolderId Id="${folderId}"/>
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>`;

        const resp = await this.ewsRequest(soap);
        const match = resp.match(/<t:ItemId Id="([^"]+)"(?:\s+ChangeKey="([^"]+)")?/);
        if (match) {
          console.log(`[EWS] Discovered target message by InternetMessageId: ${match[1].substring(0, 30)}...`);
          return { itemId: match[1], changeKey: match[2] || '' };
        }
      } catch (err: any) {
        console.warn(`[EWS] Search by InternetMessageId note:`, err?.message || err);
      }
    }

    // Step 2: Search by ConversationId
    if (conversationId) {
      try {
        const convSoap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:ConversationId"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:ParentFolderIds>
        <t:FolderId Id="${folderId}"/>
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>`;

        const resp = await this.ewsRequest(convSoap);
        const messageBlocks = [...resp.matchAll(/<t:Message>([\s\S]*?)<\/t:Message>/g)];
        for (const mb of messageBlocks) {
          const block = mb[1];
          if (block.includes(conversationId)) {
            const idMatch = block.match(/<t:ItemId Id="([^"]+)"(?:\s+ChangeKey="([^"]+)")?/);
            if (idMatch) {
              console.log(`[EWS] Discovered target message by ConversationId: ${idMatch[1].substring(0, 30)}...`);
              return { itemId: idMatch[1], changeKey: idMatch[2] || '' };
            }
          }
        }
      } catch (err: any) {
        console.warn(`[EWS] Search by ConversationId note:`, err?.message || err);
      }
    }

    return null;
  }

  /**
   * Creates an in-thread "Reply All" draft in Exchange using EWS ReplyAllToItem.
   * - Preserves the entire email thread (same conversation, topic, and quoted history).
   * - Automatically includes all original "To" and "Cc" recipients.
   * - Automatically includes the user's predefined Outlook signature below the draft text.
   */
  public async createDraft(params: CreateDraftParams): Promise<{
    success: boolean;
    mode: 'reply_all' | 'standalone';
    draftId?: string;
    error?: string;
  }> {
    const { itemId, changeKey, messageId, conversationId, body, subject, to, signatureHtml, signatureText } = params;

    // 1. Resolve active Outlook signature
    const activeSignatureHtml = signatureHtml || process.env.OUTLOOK_SIGNATURE_HTML || DEFAULT_OUTLOOK_SIGNATURE_HTML;
    const activeSignatureText = signatureText || process.env.OUTLOOK_SIGNATURE_TEXT || DEFAULT_OUTLOOK_SIGNATURE_TEXT;

    // Format draft HTML body
    const formattedDraftHtml = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');

    const fullDraftHtml = `<div style="font-family: Calibri, Aptos, Arial, sans-serif; font-size: 11pt; color: #000000;">${formattedDraftHtml}${activeSignatureHtml}</div>`;
    const fullDraftText = `${body}\n${activeSignatureText}`;

    // 2. Identify target item for in-thread Reply-All
    let targetItemId = itemId && !itemId.includes('@') && itemId.length > 40 ? itemId : '';
    let targetChangeKey = changeKey || '';

    if (!targetItemId && (messageId || conversationId || itemId)) {
      const found = await this.findItemByMessageIdOrConversation(messageId || itemId, conversationId);
      if (found) {
        targetItemId = found.itemId;
        targetChangeKey = found.changeKey;
      }
    }

    // 3. Attempt in-thread ReplyAllToItem if target item was located
    if (targetItemId) {
      if (!targetChangeKey) {
        try {
          const getXml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
      </m:ItemShape>
      <m:ItemIds>
        <t:ItemId Id="${targetItemId}"/>
      </m:ItemIds>
    </m:GetItem>
  </soap:Body>
</soap:Envelope>`;
          const resp = await this.ewsRequest(getXml);
          const ckMatch = resp.match(/ChangeKey="([^"]+)"/);
          if (ckMatch) targetChangeKey = ckMatch[1];
        } catch (err: any) {
          console.warn('[EWS] Could not retrieve fresh ChangeKey:', err?.message || err);
        }
      }

      if (targetChangeKey) {
        const replySoap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:CreateItem MessageDisposition="SaveOnly">
      <m:Items>
        <t:ReplyAllToItem>
          <t:ReferenceItemId Id="${targetItemId}" ChangeKey="${targetChangeKey}" />
          <t:NewBodyContent BodyType="HTML">${fullDraftHtml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</t:NewBodyContent>
        </t:ReplyAllToItem>
      </m:Items>
    </m:CreateItem>
  </soap:Body>
</soap:Envelope>`;

        try {
          const xml = await this.ewsRequest(replySoap);
          if (xml.includes('ResponseClass="Success"')) {
            const draftIdMatch = xml.match(/<t:ItemId Id="([^"]+)"/);
            const createdDraftId = draftIdMatch ? draftIdMatch[1] : undefined;
            console.log(`[EWS] In-thread Reply-All draft created successfully in same thread with all To/Cc recipients and signature.`);
            return {
              success: true,
              mode: 'reply_all',
              draftId: createdDraftId,
            };
          } else {
            console.warn(`[EWS] ReplyAllToItem non-success, falling back to standalone draft:`, xml.substring(0, 300));
          }
        } catch (err: any) {
          console.warn('[EWS] ReplyAllToItem failed, falling back to standalone draft:', err?.message || err);
        }
      }
    }

    // 4. Fallback: Standalone draft in Drafts folder if thread item was not found
    console.log(`[EWS] Creating standalone draft in Drafts folder...`);
    const standaloneSoap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:CreateItem MessageDisposition="SaveOnly">
      <m:SavedItemFolderId>
        <t:DistinguishedFolderId Id="drafts"/>
      </m:SavedItemFolderId>
      <m:Items>
        <t:Message>
          <t:Subject>${subject.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</t:Subject>
          <t:Body BodyType="HTML">${fullDraftHtml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</t:Body>
          <t:ToRecipients>
            <t:Mailbox>
              <t:EmailAddress>${to || 'corporate@elitehospital.org'}</t:EmailAddress>
            </t:Mailbox>
          </t:ToRecipients>
        </t:Message>
      </m:Items>
    </m:CreateItem>
  </soap:Body>
</soap:Envelope>`;

    try {
      const xml = await this.ewsRequest(standaloneSoap);
      if (xml.includes('ResponseClass="Success"')) {
        const draftIdMatch = xml.match(/<t:ItemId Id="([^"]+)"/);
        const createdDraftId = draftIdMatch ? draftIdMatch[1] : undefined;
        console.log(`[EWS] Standalone draft created in Exchange Drafts folder.`);
        return {
          success: true,
          mode: 'standalone',
          draftId: createdDraftId,
        };
      }
      return { success: false, mode: 'standalone', error: xml.substring(0, 300) };
    } catch (err: any) {
      return { success: false, mode: 'standalone', error: err?.message || String(err) };
    }
  }
}
