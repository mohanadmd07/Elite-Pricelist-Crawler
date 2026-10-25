/**
 * Transactional Outbox Worker Service
 * Synchronizes authoritative PostgreSQL approval events to the derived Firestore read model.
 * 
 * Guarantees:
 * 1. At-least-once delivery with idempotent Firestore document upserts (docId = aggregate_id).
 * 2. Exponential backoff on transient network or Firestore quota failures.
 * 3. Poison message quarantine to public.dead_letter_queue after 5 consecutive failures.
 * 4. Full replayability to completely reconstruct Firestore from scratch.
 */

import 'dotenv/config';
import { doc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../src/firebase';
import { supabaseAdmin, supabase } from '../src/lib/supabase';

const MAX_RETRIES = 5;
const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 2000;

export interface OutboxRecord {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: any;
  status: 'pending' | 'processing' | 'published' | 'failed';
  retry_count: number;
  next_retry_at: string;
  last_error?: string | null;
  published_at?: string | null;
  created_at: string;
}

const client = supabaseAdmin || supabase;

/**
 * Calculates exponential backoff in seconds based on retry count.
 * 2s, 4s, 8s, 16s, 32s (capped at 300s).
 */
export function calculateBackoffSeconds(retryCount: number): number {
  return Math.min(300, Math.pow(2, retryCount + 1));
}

/**
 * Processes a single batch of pending outbox events.
 */
export async function processOutboxBatch(batchSize = 25): Promise<{
  processed: number;
  published: number;
  failed: number;
  quarantined: number;
}> {
  if (!client) {
    console.warn('[Outbox Worker] Supabase client is not configured.');
    return { processed: 0, published: 0, failed: 0, quarantined: 0 };
  }

  const nowIso = new Date().toISOString();

  // 1. Fetch pending or retry-eligible outbox records
  const { data: records, error } = await client
    .from('outbox')
    .select('*')
    .in('status', ['pending', 'failed'])
    .lte('next_retry_at', nowIso)
    .order('created_at', { ascending: true })
    .limit(batchSize);

  if (error) {
    console.error('[Outbox Worker] Error querying outbox table:', error.message);
    return { processed: 0, published: 0, failed: 0, quarantined: 0 };
  }

  if (!records || records.length === 0) {
    return { processed: 0, published: 0, failed: 0, quarantined: 0 };
  }

  let published = 0;
  let failed = 0;
  let quarantined = 0;

  for (const record of records as OutboxRecord[]) {
    try {
      // 2. Lock row into processing state
      await client
        .from('outbox')
        .update({ status: 'processing' })
        .eq('id', record.id);

      // 3. Publish to Firestore derived read model
      if (record.event_type === 'APPROVAL_DELETED') {
        const docRef = doc(db, 'inpatient_approvals', record.aggregate_id);
        await deleteDoc(docRef);
      } else {
        const docRef = doc(db, 'inpatient_approvals', record.aggregate_id);
        // Ensure Firestore timestamp formatting
        const firestorePayload = {
          ...record.payload,
          _syncedFromPostgresAt: serverTimestamp(),
        };
        await setDoc(docRef, firestorePayload, { merge: true });
      }

      // 4. Mark as published
      await client
        .from('outbox')
        .update({
          status: 'published',
          published_at: new Date().toISOString(),
          last_error: null,
        })
        .eq('id', record.id);

      published++;
    } catch (err: any) {
      failed++;
      const currentRetries = (record.retry_count || 0) + 1;
      const errorMsg = err?.message || String(err);
      const stackTrace = err?.stack || '';

      console.error(`[Outbox Worker] Event ${record.id} failed (attempt ${currentRetries}/${MAX_RETRIES}):`, errorMsg);

      if (currentRetries >= MAX_RETRIES) {
        // Quarantine to Dead-Letter Queue
        quarantined++;
        try {
          await client.from('dead_letter_queue').insert({
            source_type: 'outbox_sync',
            source_id: record.id,
            payload: record.payload,
            error_message: errorMsg,
            stack_trace: stackTrace,
            retry_count: currentRetries,
          });

          await client
            .from('outbox')
            .update({
              status: 'failed',
              retry_count: currentRetries,
              last_error: `Quarantined to DLQ: ${errorMsg}`,
            })
            .eq('id', record.id);

          console.warn(`[Outbox Worker] ☣️ Quarantined poison outbox event ${record.id} to Dead-Letter Queue.`);
        } catch (dlqErr: any) {
          console.error('[Outbox Worker] Critical: Failed to insert into dead_letter_queue:', dlqErr);
        }
      } else {
        // Schedule exponential backoff retry
        const backoffSec = calculateBackoffSeconds(currentRetries);
        const nextRetryDate = new Date(Date.now() + backoffSec * 1000).toISOString();

        await client
          .from('outbox')
          .update({
            status: 'failed',
            retry_count: currentRetries,
            next_retry_at: nextRetryDate,
            last_error: errorMsg,
          })
          .eq('id', record.id);
      }
    }
  }

  return {
    processed: records.length,
    published,
    failed,
    quarantined,
  };
}

/**
 * Replays all PostgreSQL approvals to Firestore to rebuild the read model from scratch.
 */
export async function replayAllToFirestore(): Promise<{ totalReplayed: number }> {
  if (!client) {
    throw new Error('Supabase client not configured.');
  }

  console.log('🔄 Replaying all inpatient approvals from PostgreSQL to Firestore...');
  const { data: approvals, error } = await client
    .from('inpatient_approvals')
    .select('*')
    .order('received_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to load approvals from Postgres: ${error.message}`);
  }

  if (!approvals || approvals.length === 0) {
    console.log('No approvals found in PostgreSQL to replay.');
    return { totalReplayed: 0 };
  }

  console.log(`Found ${approvals.length} approvals in PostgreSQL. Replaying into Firestore...`);
  let count = 0;

  for (const app of approvals) {
    const docRef = doc(db, 'inpatient_approvals', app.id);
    const payload = {
      id: app.id,
      exchangeMessageId: app.exchange_message_id,
      contentHash: app.content_hash,
      conversationId: app.conversation_id,
      receivedAt: app.received_at,
      patientName: app.patient_name,
      mrn: app.mrn,
      bed: app.bed,
      admissionType: app.admission_type,
      physician: app.physician,
      contractorRaw: app.contractor_raw,
      contractorNormalized: app.contractor_normalized,
      contractorOfficer: app.contractor_officer,
      priceListYear: app.price_list_year,
      diagnosis: app.diagnosis,
      requestedServices: app.requested_services,
      matchedProcedures: app.matched_procedures,
      financialTerms: app.financial_terms,
      status: app.status,
      statusReasonArabic: app.status_reason_arabic,
      stateTimestamps: app.state_timestamps,
      suggestedDraftReply: app.suggested_draft_reply,
      draftBody: app.suggested_draft_reply,
      cmWhatsappMessage: app.cm_whatsapp_message,
      hasReplies: app.has_replies,
      hasExistingApproval: app.has_existing_approval,
      isRefused: app.is_refused,
      updatedAt: app.updated_at,
      _replayedFromPostgresAt: serverTimestamp(),
    };

    await setDoc(docRef, payload, { merge: true });
    count++;
    if (count % 25 === 0) {
      console.log(`  ✓ Replayed ${count}/${approvals.length} records...`);
    }
  }

  console.log(`✅ Successfully replayed ${count} approvals to Firestore!`);
  return { totalReplayed: count };
}

/**
 * Continuous Outbox Daemon Polling Loop
 */
export async function startOutboxDaemon(): Promise<void> {
  console.log('=====================================================');
  console.log(' Elite Hospital - Transactional Outbox Worker');
  console.log(` Target: Firestore Read Model | Poll Interval: ${POLL_INTERVAL_MS}ms`);
  console.log('=====================================================');

  const poll = async () => {
    try {
      const stats = await processOutboxBatch();
      if (stats.processed > 0) {
        console.log(
          `[Outbox Worker] Batch completed: ${stats.published} published, ${stats.failed} failed, ${stats.quarantined} quarantined.`
        );
      }
    } catch (err) {
      console.error('[Outbox Worker] Unexpected polling loop error:', err);
    }
  };

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

// CLI Execution Entrypoint
if (process.argv[1]?.endsWith('outbox-worker.ts')) {
  if (process.argv.includes('--replay')) {
    replayAllToFirestore()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('Fatal replay error:', err);
        process.exit(1);
      });
  } else if (process.argv.includes('--once')) {
    processOutboxBatch()
      .then((stats) => {
        console.log('One-shot outbox batch finished:', stats);
        process.exit(0);
      })
      .catch((err) => {
        console.error('Fatal outbox batch error:', err);
        process.exit(1);
      });
  } else {
    startOutboxDaemon().catch((err) => {
      console.error('Fatal outbox worker error:', err);
      process.exit(1);
    });
  }
}
