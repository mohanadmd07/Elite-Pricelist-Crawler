/**
 * Postgres Cursor and Watermark Management
 * Persists EWS SyncState watermarks to public.sync_checkpoints.
 * Executes scheduled PHI data minimization purges.
 */

import { supabaseAdmin, supabase } from '../../lib/supabase';
import { MailCursor } from '../types';

const client = supabaseAdmin || supabase;
const DEFAULT_FOLDER = 'InApprovals';

/**
 * Loads the stored sync watermark from PostgreSQL for the given folder.
 */
export async function loadCursorFromPostgres(folderName: string = DEFAULT_FOLDER): Promise<MailCursor> {
  const fallbackCursor: MailCursor = {
    folderName,
    token: undefined,
    lastSyncedAt: new Date(0).toISOString(),
    totalSyncedCount: 0,
  };

  if (!client) {
    console.warn('[Cursor Manager] Supabase client unavailable; using fresh cursor.');
    return fallbackCursor;
  }

  try {
    const { data, error } = await client
      .from('sync_checkpoints')
      .select('folder_name, sync_state_token, last_synced_at, total_synced_count')
      .eq('folder_name', folderName)
      .maybeSingle();

    if (error) {
      console.warn(`[Cursor Manager] Failed to load watermark for "${folderName}":`, error.message);
      return fallbackCursor;
    }

    if (!data) {
      return fallbackCursor;
    }

    return {
      folderName: data.folder_name,
      token: data.sync_state_token || undefined,
      lastSyncedAt: data.last_synced_at || new Date(0).toISOString(),
      totalSyncedCount: Number(data.total_synced_count) || 0,
    };
  } catch (err: any) {
    console.error(`[Cursor Manager] Unexpected error reading cursor:`, err.message || err);
    return fallbackCursor;
  }
}

/**
 * Persists an updated sync watermark to PostgreSQL.
 */
export async function saveCursorToPostgres(cursor: MailCursor, itemsIncrement: number = 0): Promise<boolean> {
  if (!client) {
    return false;
  }

  try {
    const newTotal = (cursor.totalSyncedCount || 0) + itemsIncrement;
    const { error } = await client
      .from('sync_checkpoints')
      .upsert(
        {
          folder_name: cursor.folderName,
          sync_state_token: cursor.token || null,
          last_synced_at: new Date().toISOString(),
          total_synced_count: newTotal,
        },
        { onConflict: 'folder_name' }
      );

    if (error) {
      console.error(`[Cursor Manager] Failed to save watermark for "${cursor.folderName}":`, error.message);
      return false;
    }

    return true;
  } catch (err: any) {
    console.error(`[Cursor Manager] Unexpected error writing cursor:`, err.message || err);
    return false;
  }
}

/**
 * Calls PostgreSQL function public.purge_expired_raw_emails to drop raw PHI bodies older than retention threshold.
 */
export async function triggerPhiRetentionPurge(retentionDays: number = 30): Promise<{
  success: boolean;
  purgedCount?: number;
}> {
  if (!client) return { success: false };

  try {
    const { data, error } = await client.rpc('purge_expired_raw_emails', {
      retention_days: retentionDays,
    });

    if (error) {
      console.warn('[PHI Retention Purge] RPC error:', error.message);
      return { success: false };
    }

    const res = data as any;
    const total = (res?.purged_staging_count || 0) + (res?.purged_approvals_count || 0);
    if (total > 0) {
      console.log(`[PHI Retention Purge] 🧹 Purged raw bodies for ${total} records older than ${retentionDays} days.`);
    }
    return { success: true, purgedCount: total };
  } catch (err: any) {
    console.warn('[PHI Retention Purge] Error executing purge:', err.message || err);
    return { success: false };
  }
}
