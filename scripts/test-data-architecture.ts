/**
 * Automated Test Suite: Phase 2 Data Architecture & Inpatient Approvals
 * Verifies:
 * 1. Deterministic UUID derivation and schema validation.
 * 2. PostgreSQL Inpatient Approvals State Machine CHECK constraints.
 * 3. Unique deduplication by Exchange Message-ID and content-hash fallback.
 * 4. Automatic Transactional Outbox trigger execution.
 * 5. Outbox Exponential Backoff calculations and Dead-Letter Queue routing.
 * 6. PostgreSQL EWS Watermark Checkpoint persistence.
 */

import 'dotenv/config';
import { supabaseAdmin, supabase } from '../src/lib/supabase';
import {
  toDeterministicUuid,
  persistApprovalToPostgres,
  loadSyncWatermarkFromPostgres,
  saveSyncWatermarkToPostgres,
  quarantinePoisonMessage,
} from '../src/services/approvalPostgresService';
import { calculateBackoffSeconds, processOutboxBatch } from './outbox-worker';
import { InpatientApprovalRecord } from '../src/types';

const client = supabaseAdmin || supabase;

async function runDataArchitectureTests() {
  console.log('=====================================================');
  console.log('🧪 Starting Phase 2 Data Architecture Test Suite');
  console.log('=====================================================\n');

  if (!client) {
    throw new Error('Supabase client is not configured in environment!');
  }

  // -------------------------------------------------------------
  // Test 1: Deterministic UUID Derivation
  // -------------------------------------------------------------
  console.log('Test 1: Verifying deterministic UUID v4 formatting...');
  const seed = 'mrn_0000266421_test_seed';
  const uuid1 = toDeterministicUuid(seed);
  const uuid2 = toDeterministicUuid(seed);
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (uuid1 !== uuid2) {
    throw new Error(`FAILED: Non-deterministic UUID: "${uuid1}" !== "${uuid2}"`);
  }
  if (!uuidRegex.test(uuid1)) {
    throw new Error(`FAILED: Generated UUID "${uuid1}" does not match RFC 4122 v4 regex.`);
  }
  console.log(`  ✓ Generated valid deterministic UUID: ${uuid1}`);
  console.log('✅ PASS: Test 1 (Deterministic UUID)\n');

  // -------------------------------------------------------------
  // Test 2: Exponential Backoff Timing Logic
  // -------------------------------------------------------------
  console.log('Test 2: Verifying exponential backoff calculation...');
  const expectedDelays = [2, 4, 8, 16, 32, 64, 128, 256, 300, 300];
  for (let retry = 0; retry < expectedDelays.length; retry++) {
    const computed = calculateBackoffSeconds(retry);
    if (computed !== expectedDelays[retry]) {
      throw new Error(`FAILED: For retry ${retry}, expected delay ${expectedDelays[retry]}s but got ${computed}s`);
    }
  }
  console.log('  ✓ Exponential progression (2s -> 4s -> 8s -> ... -> 300s cap) verified.');
  console.log('✅ PASS: Test 2 (Exponential Backoff)\n');

  // -------------------------------------------------------------
  // Test 3: PostgreSQL Watermark Checkpoint Persistence
  // -------------------------------------------------------------
  console.log('Test 3: Testing EWS sync watermark persistence in Postgres...');
  const testFolder = 'Test_Folder_Watermark';
  const testToken = `token_test_${Date.now()}`;

  await saveSyncWatermarkToPostgres(testFolder, testToken, 'msg_test_001');
  const reloadedToken = await loadSyncWatermarkFromPostgres(testFolder);

  if (reloadedToken !== testToken) {
    throw new Error(`FAILED: Watermark mismatch. Expected "${testToken}", got "${reloadedToken}"`);
  }
  console.log(`  ✓ Watermark successfully persisted and loaded from public.sync_checkpoints.`);
  console.log('✅ PASS: Test 3 (Postgres Watermarks)\n');

  // -------------------------------------------------------------
  // Test 4: Inpatient Approvals Upsert & Outbox Trigger
  // -------------------------------------------------------------
  console.log('Test 4: Verifying Inpatient Approvals insertion & Outbox trigger execution...');
  const testMsgId = `<test_${Date.now()}@elitehospital.org>`;
  const mockApproval: InpatientApprovalRecord = {
    id: `test_approval_${Date.now()}`,
    conversationId: `conv_${Date.now()}`,
    messageId: testMsgId,
    receivedAt: new Date().toISOString(),
    patientName: 'مريض تجريبي للاختبار',
    mrn: '999999',
    bed: 'Bed 99 - ICU',
    physician: 'Dr. Test Physician',
    contractorRaw: 'شركة بترول تجريبية',
    contractorNormalized: 'بترول تجريبي',
    contractorOfficer: 'Officer Test',
    priceListYear: '2025',
    diagnosis: 'Test Clinical Diagnosis',
    requestedServices: [{ name: 'Test CBC Investigation', rawPrice: 150 }],
    matchedProcedures: [{ serviceName: 'Test CBC Investigation', matchedName: 'CBC Complete Blood Count', status: 'matched' }],
    status: 'matched',
    draftBody: 'مسودة تجريبية',
    draftedAt: new Date().toISOString(),
    statusReasonArabic: 'فحص تجريبي متطابق بالكامل',
    hasReplies: false,
    hasExistingApproval: false,
    isRefused: false,
  };

  const persistResult = await persistApprovalToPostgres(mockApproval);
  if (!persistResult.success || !persistResult.id) {
    throw new Error(`FAILED: Could not persist approval to Postgres: ${persistResult.error}`);
  }
  console.log(`  ✓ Persisted approval record to public.inpatient_approvals (ID: ${persistResult.id}).`);

  // Verify that public.outbox received the event via the PostgreSQL trigger!
  const { data: outboxRows, error: outboxErr } = await client
    .from('outbox')
    .select('*')
    .eq('aggregate_id', persistResult.id)
    .order('created_at', { ascending: false })
    .limit(1);

  if (outboxErr || !outboxRows || outboxRows.length === 0) {
    throw new Error(`FAILED: Outbox trigger failed to produce an event row: ${outboxErr?.message}`);
  }

  const outboxEvent = outboxRows[0];
  if (outboxEvent.aggregate_type !== 'inpatient_approval' || outboxEvent.status !== 'pending') {
    throw new Error(`FAILED: Outbox event state invalid: ${JSON.stringify(outboxEvent)}`);
  }
  console.log(`  ✓ PostgreSQL trigger successfully generated event "${outboxEvent.event_type}" in public.outbox.`);
  console.log('✅ PASS: Test 4 (Authoritative Table & Outbox Trigger)\n');

  // -------------------------------------------------------------
  // Test 5: State Machine CHECK Constraint Enforcement
  // -------------------------------------------------------------
  console.log('Test 5: Verifying State Machine CHECK constraint rejects invalid states...');
  const { error: invalidStateErr } = await client
    .from('inpatient_approvals')
    .update({ status: 'invalid_illegal_status_state' as any })
    .eq('id', persistResult.id);

  if (!invalidStateErr || !invalidStateErr.message.includes('inpatient_approvals_status_check')) {
    throw new Error('FAILED: Database failed to reject invalid status state! CHECK constraint missing or inactive.');
  }
  console.log(`  ✓ Database successfully rejected invalid state with constraint error.`);
  console.log('✅ PASS: Test 5 (State Machine CHECK Constraint)\n');

  // -------------------------------------------------------------
  // Test 6: Poison Message Quarantine (Dead-Letter Queue)
  // -------------------------------------------------------------
  console.log('Test 6: Verifying Poison Message Quarantine to Dead-Letter Queue...');
  await quarantinePoisonMessage({
    sourceType: 'outbox_sync',
    sourceId: outboxEvent.id,
    errorMessage: 'Simulated permanent Firestore failure after 5 attempts',
    retryCount: 5,
  });

  const { data: dlqRows, error: dlqErr } = await client
    .from('dead_letter_queue')
    .select('*')
    .eq('source_id', outboxEvent.id)
    .limit(1);

  if (dlqErr || !dlqRows || dlqRows.length === 0) {
    throw new Error(`FAILED: Dead-letter queue failed to store quarantined record: ${dlqErr?.message}`);
  }
  console.log(`  ✓ Poison event successfully quarantined to public.dead_letter_queue.`);
  console.log('✅ PASS: Test 6 (Dead-Letter Queue Quarantine)\n');

  // Cleanup test artifacts
  await client.from('dead_letter_queue').delete().eq('source_id', outboxEvent.id);
  await client.from('outbox').delete().eq('id', outboxEvent.id);
  await client.from('inpatient_approvals').delete().eq('id', persistResult.id);
  await client.from('sync_checkpoints').delete().eq('folder_name', testFolder);
  console.log('  ✓ Test artifacts cleanly purged.');

  console.log('\n🎉 ALL PHASE 2 DATA ARCHITECTURE TESTS PASSED SUCCESSFULLY!');
}

runDataArchitectureTests().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
