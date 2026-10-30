/**
 * Regression tests for durable sync watermark persistence (cursorManager).
 *
 * Bug fixed: the FindItem recovery window was derived from `last_synced_at`
 * (wall clock of the last run) minus a 24h overlap. If ingestion failed or the
 * pipeline was down longer than that overlap, the next run queried a window that
 * started AFTER the missing mail — so those approvals were lost permanently with
 * no error anywhere.
 *
 * The watermark must therefore be the highest item DateTimeReceived that was
 * actually ingested, persisted alongside the token and read back on every run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChain: Record<string, any> = {};
const upsert = vi.fn();
const select = vi.fn();

vi.mock('../src/lib/supabase', () => ({
  supabaseAdmin: {
    from: () => ({
      select: (...args: string[]) => {
        mockChain.selectedColumns = args[0];
        return {
          eq: () => ({ maybeSingle: () => Promise.resolve(select()) }),
        };
      },
      upsert: (payload: any) => upsert(payload),
    }),
  },
  supabase: null,
}));

beforeEach(() => {
  vi.resetModules();
  upsert.mockReset().mockResolvedValue({ error: null });
  select.mockReset().mockResolvedValue({ data: null, error: null });
});

describe('sync checkpoint watermark persistence', () => {
  it('reads watermark_received_at back into the cursor', async () => {
    select.mockResolvedValue({
      data: {
        folder_name: 'InApprovals',
        sync_state_token: 'T1',
        last_synced_at: '2026-10-30T09:00:00Z',
        total_synced_count: 5,
        watermark_received_at: '2026-10-30T07:30:00Z',
      },
      error: null,
    });

    const { loadCursorFromPostgres } = await import('../src/mail/storage/cursorManager');
    const cursor = await loadCursorFromPostgres('InApprovals');

    expect(cursor.token).toBe('T1');
    expect(cursor.watermarkReceivedAt).toBe('2026-10-30T07:30:00Z');
    expect(mockChain.selectedColumns).toContain('watermark_received_at');
  });

  it('persists the ingested watermark alongside the token', async () => {
    const { saveCursorToPostgres } = await import('../src/mail/storage/cursorManager');

    await saveCursorToPostgres(
      {
        folderName: 'InApprovals',
        token: 'T2',
        lastSyncedAt: '2026-10-30T10:00:00Z',
        watermarkReceivedAt: '2026-10-30T09:45:00Z',
        totalSyncedCount: 7,
      },
      2,
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    const payload = upsert.mock.calls[0][0];
    expect(payload.sync_state_token).toBe('T2');
    expect(payload.watermark_received_at).toBe('2026-10-30T09:45:00Z');
  });

  it('never rewinds a stored watermark when a batch yields no newer item', async () => {
    select.mockResolvedValue({
      data: {
        folder_name: 'InApprovals',
        sync_state_token: 'T1',
        last_synced_at: '2026-10-29T10:00:00Z',
        total_synced_count: 5,
        watermark_received_at: '2026-10-29T08:00:00Z',
      },
      error: null,
    });

    const mod = await import('../src/mail/storage/cursorManager');
    await mod.saveCursorToPostgres(
      {
        folderName: 'InApprovals',
        token: 'T2',
        lastSyncedAt: '2026-10-30T10:00:00Z',
        watermarkReceivedAt: undefined,
        totalSyncedCount: 5,
      },
      0,
    );

    // A transient empty/failed batch must not move the recovery anchor backwards,
    // or the gap it just skipped becomes permanent.
    expect(upsert.mock.calls[0][0].watermark_received_at).toBe('2026-10-29T08:00:00Z');
  });

  it('stores null watermark on a first-ever run instead of epoch', async () => {
    const { saveCursorToPostgres } = await import('../src/mail/storage/cursorManager');

    await saveCursorToPostgres({
      folderName: 'InApprovals',
      token: 'T1',
      lastSyncedAt: new Date(0).toISOString(),
      totalSyncedCount: 0,
    });

    expect(upsert.mock.calls[0][0].watermark_received_at).toBeNull();
  });
});
