/**
 * PostgreSQL Service for Inpatient Approvals & Data Architecture
 * Authoritative persistence layer interacting with Supabase PostgreSQL.
 * Enforces:
 * 1. Deterministic UUID generation for idempotent primary keys.
 * 2. Deduplication via Exchange message-id and content-hash fallback.
 * 3. Watermark persistence to public.sync_checkpoints.
 * 4. Poison-message routing to public.dead_letter_queue.
 */

import crypto from 'crypto';
import { supabaseAdmin, supabase } from '../lib/supabase';
import { InpatientApprovalRecord } from '../types';

const client = supabaseAdmin || supabase;

/**
 * Derives a deterministic RFC 4122 v4-compliant UUID from a string seed.
 */
export function toDeterministicUuid(seed: string): string {
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    'a' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

/**
 * Persists or updates an inpatient approval in PostgreSQL.
 * The PostgreSQL trigger automatically enqueues an event to public.outbox
 * within the exact same database transaction for Firestore replication.
 */
export async function persistApprovalToPostgres(record: InpatientApprovalRecord): Promise<{
  success: boolean;
  id?: string;
  error?: string;
}> {
  if (!client) {
    return { success: false, error: 'Supabase client is not configured.' };
  }

  const convKey = record.conversationId;
  const deliveryKey = record.messageId || record.exchangeItemId;
  const rawSeed = convKey || deliveryKey || record.id || record.mrn;
  let uuid = toDeterministicUuid(rawSeed);

  let receivedIso =
    record.receivedAt && (record.receivedAt as any).toDate
      ? (record.receivedAt as any).toDate().toISOString()
      : typeof record.receivedAt === 'string'
      ? record.receivedAt
      : new Date().toISOString();

  // If conversation_id already exists in DB, preserve its existing primary key id and earliest received_at
  if (convKey) {
    try {
      const { data: existing } = await client
        .from('inpatient_approvals')
        .select('id, received_at')
        .eq('conversation_id', convKey)
        .maybeSingle();
      if (existing?.id) {
        uuid = existing.id;
        if (existing.received_at && new Date(existing.received_at) < new Date(receivedIso)) {
          receivedIso = existing.received_at;
        }
      }
    } catch {}
  } else if (deliveryKey) {
    try {
      const { data: existing } = await client
        .from('inpatient_approvals')
        .select('id, received_at')
        .eq('exchange_message_id', deliveryKey)
        .maybeSingle();
      if (existing?.id) {
        uuid = existing.id;
        if (existing.received_at && new Date(existing.received_at) < new Date(receivedIso)) {
          receivedIso = existing.received_at;
        }
      }
    } catch {}
  }

  const contentHash = crypto
    .createHash('sha256')
    .update(
      `${record.conversationId || ''}|${record.messageId || ''}|${record.mrn || ''}|${record.receivedAt || ''}|${record.diagnosis || ''}`
    )
    .digest('hex');

  const mrnHash = crypto
    .createHash('sha256')
    .update(`salt_elite_approvals_${record.mrn || ''}`)
    .digest('hex');

  // Map application status to database state machine constraint
  const allowedStatuses = ['received', 'parsed', 'matched', 'needs_review', 'draft_created', 'answered', 'refused'];
  const dbStatus = allowedStatuses.includes(record.status || '') ? record.status : 'received';

  const payload: Record<string, any> = {
    id: uuid,
    exchange_message_id: record.messageId || record.exchangeItemId || null,
    content_hash: contentHash,
    conversation_id: record.conversationId || `conv_${uuid.slice(0, 8)}`,
    received_at: receivedIso,
    patient_identifier_hash: mrnHash,
    patient_name: record.patientName || 'مريض غير محدد',
    mrn: record.mrn || '000000',
    bed: record.bed || null,
    admission_type: record.admissionType || 'Inpatient',
    physician: record.physician || null,
    contractor_raw: record.contractorRaw || null,
    contractor_normalized: record.contractorNormalized || null,
    contractor_officer: record.contractorOfficer || null,
    price_list_year: record.priceListYear || '2025',
    diagnosis: record.diagnosis || null,
    requested_services: record.requestedServices || [],
    matched_procedures: record.matchedProcedures || [],
    financial_terms: {
      patientSharePercentage: record.patientSharePercentage ?? -1,
      approvedAmountLimit: record.approvedAmountLimit ?? record.creditLimit ?? -1,
      creditLimitText: record.creditLimitText ?? null,
      coverageConditions: record.coverageConditions ?? '',
    },
    status: dbStatus,
    status_reason_arabic: record.statusReasonArabic
      ? record.statusReasonArabic
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      : null,
    state_timestamps: {
      received_at: receivedIso,
      updated_at: new Date().toISOString(),
      ...(record.draftedAt ? { drafted_at: record.draftedAt } : {}),
      ...(record.answeredAt ? { answered_at: record.answeredAt } : {}),
    },
    suggested_draft_reply: record.draftBody || (record as any).suggestedDraftReply || null,
    cm_whatsapp_message: record.cmWhatsappMessage || null,
    has_replies: Boolean(record.hasReplies),
    has_existing_approval: Boolean(record.hasExistingApproval),
    is_refused: Boolean(record.isRefused),
    updated_at: new Date().toISOString(),
  };

  try {
    const { data, error } = await client
      .from('inpatient_approvals')
      .upsert(payload, {
        onConflict: 'id',
      })
      .select('id')
      .single();

    if (error) {
      console.error('[Postgres Approvals] Upsert error:', error.message);
      return { success: false, error: error.message };
    }

    return { success: true, id: data?.id || uuid };
  } catch (err: any) {
    console.error('[Postgres Approvals] Exception during upsert:', err?.message || err);
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Loads the EWS sync watermark for a given folder from PostgreSQL.
 */
export async function loadSyncWatermarkFromPostgres(folderName = 'InApprovals'): Promise<string> {
  if (!client) return '';

  try {
    const { data, error } = await client
      .from('sync_checkpoints')
      .select('sync_state_token')
      .eq('folder_name', folderName)
      .maybeSingle();

    if (!error && data?.sync_state_token) {
      return data.sync_state_token;
    }
  } catch (err) {
    console.warn('[Postgres Watermark] Could not load sync checkpoint:', err);
  }
  return '';
}

/**
 * Persists the EWS sync watermark for a given folder into PostgreSQL.
 */
export async function saveSyncWatermarkToPostgres(
  folderName = 'InApprovals',
  syncStateToken: string,
  lastMessageId?: string
): Promise<void> {
  if (!client || !syncStateToken) return;

  try {
    await client.from('sync_checkpoints').upsert(
      {
        folder_name: folderName,
        sync_state_token: syncStateToken,
        last_synced_at: new Date().toISOString(),
        last_message_id: lastMessageId || null,
      },
      { onConflict: 'folder_name' }
    );
  } catch (err) {
    console.warn('[Postgres Watermark] Could not save sync checkpoint:', err);
  }
}

/**
 * Quarantines unparseable or poison messages into the dead-letter queue.
 */
export async function quarantinePoisonMessage(params: {
  sourceType: 'ews_email' | 'approval_parse' | 'outbox_sync';
  sourceId?: string;
  payload?: any;
  errorMessage: string;
  stackTrace?: string;
  retryCount?: number;
}): Promise<void> {
  if (!client) return;

  try {
    await client.from('dead_letter_queue').insert({
      source_type: params.sourceType,
      source_id: params.sourceId || null,
      payload: params.payload || {},
      error_message: params.errorMessage,
      stack_trace: params.stackTrace || null,
      retry_count: params.retryCount || 1,
    });
    console.warn(`[Dead-Letter Queue] ☣️ Quarantined poison ${params.sourceType} message: ${params.errorMessage}`);
  } catch (err) {
    console.error('[Dead-Letter Queue] Failed to quarantine poison message:', err);
  }
}
