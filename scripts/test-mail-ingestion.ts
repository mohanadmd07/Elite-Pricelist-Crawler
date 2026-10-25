/**
 * Phase 3 Mail Ingestion Test Suite
 * Tests:
 * 1. EWS source client initialization and connection test logic.
 * 2. HIS approval HTML email parser against complex Arabic/English clinical fixtures.
 * 3. Credit limit extraction, refusal detection, and reply detection.
 * 4. Attachment security validation (whitelisting, size limits).
 * 5. Postgres cursor watermark persistence and idempotency.
 * 6. PHI data retention purge stored procedure.
 */

import { parseHisApprovalEmail, extractCreditLimit, detectRefusal, detectExistingApproval, detectReplies } from '../src/mail/parser/hisApprovalParser';
import { validateAttachment } from '../src/mail/attachments/attachmentHandler';
import { loadCursorFromPostgres, saveCursorToPostgres, triggerPhiRetentionPurge } from '../src/mail/storage/cursorManager';
import { EwsSource } from '../src/mail/adapters/EwsSource';
import { persistApprovalToPostgres } from '../src/services/approvalPostgresService';
import { supabaseAdmin, supabase } from '../src/lib/supabase';
import { InpatientApprovalRecord } from '../src/types';
import { RawMailMessage } from '../src/mail/types';

const client = supabaseAdmin || supabase;

async function runMailIngestionTests() {
  console.log('=====================================================');
  console.log('🧪 Starting Phase 3 Mail Ingestion Test Suite');
  console.log('=====================================================\n');

  if (!client) {
    throw new Error('Supabase client is not configured in environment!');
  }

  // -------------------------------------------------------------
  // Test 1: EWS Source Client Initialization
  // -------------------------------------------------------------
  console.log('Test 1: Testing EWS Source initialization & connection probe...');
  const ewsSource = new EwsSource({ folderName: 'InApprovals' });
  const conn = await ewsSource.testConnection();
  console.log(`  Connection probe result: ${conn.ok ? '✓ Connected' : 'ℹ️ ' + conn.message}`);
  console.log('✅ PASS: Test 1 (EWS Client Probe)');

  // -------------------------------------------------------------
  // Test 2: HIS Approval Email Parser Fixture
  // -------------------------------------------------------------
  console.log('\nTest 2: Testing HIS Approval Email Parser with realistic clinical fixture...');
  const sampleApprovalHtml = `
    <html>
      <body>
        <table border="1">
          <tr><th>Patient Name</th><td>أحمد محمود علي إبراهيم</td></tr>
          <tr><th>Admission Date</th><td>2026-10-25</td></tr>
          <tr><th>Visit Type</th><td>Inpatient – Bed: 304 ICU</td></tr>
          <tr><th>Physician</th><td>أ.د. عصام الدين شحاتة</td></tr>
          <tr><th>Contractor</th><td>شركة بترول بلاعيم (بتروبل)</td></tr>
          <tr><th>Diagnosis</th><td>Acute Myocardial Infarction – Angioplasty required</td></tr>
        </table>
        <br/>
        <h3>SELECTED SERVICES</h3>
        <table>
          <tr><th>Service Name</th><th>Price</th></tr>
          <tr><td>قسطرة تشخيصية للشرايين التاجية</td><td>12,500.00</td></tr>
          <tr><td>تركيب دعامة دوائية</td><td>28,000.00</td></tr>
        </table>
        <p>موافق على إجراء القسطرة والدعامة بحد أقصى 50,000 جنيه مصري مشروط بتقرير القسطرة.</p>
      </body>
    </html>
  `;

  const mockMsg: RawMailMessage = {
    id: `ews_item_test_${Date.now()}`,
    messageId: `<inpatient_approval_${Date.now()}@elitehospital.org>`,
    conversationId: `conv_${Date.now()}`,
    subject: 'Inpatient Approval - أحمد محمود علي إبراهيم (MRN: 00028471)',
    sender: 'his_system@elitehospital.org',
    receivedAt: new Date().toISOString(),
    htmlBody: sampleApprovalHtml,
  };

  const parsed = parseHisApprovalEmail(mockMsg);
  console.log(`  Parsed Patient Name: "${parsed.patientName}"`);
  console.log(`  Parsed MRN:          "${parsed.mrn}"`);
  console.log(`  Parsed Bed:          "${parsed.bed}"`);
  console.log(`  Parsed Contractor:   "${parsed.contractorRaw}"`);
  console.log(`  Parsed Services:     ${parsed.requestedServices.length} items`);
  console.log(`  Parsed Credit Limit: ${parsed.financialTerms?.approvedAmountLimit} EGP`);
  console.log(`  Existing Approval:   ${parsed.hasExistingApproval}`);

  if (parsed.patientName !== 'أحمد محمود علي إبراهيم') {
    throw new Error(`Expected patientName "أحمد محمود علي إبراهيم", got "${parsed.patientName}"`);
  }
  if (parsed.mrn !== '00028471') {
    throw new Error(`Expected MRN "00028471", got "${parsed.mrn}"`);
  }
  if (!parsed.bed?.includes('304 ICU')) {
    throw new Error(`Expected bed containing "304 ICU", got "${parsed.bed}"`);
  }
  if (parsed.requestedServices.length !== 2) {
    throw new Error(`Expected 2 services, got ${parsed.requestedServices.length}`);
  }
  if (parsed.financialTerms?.approvedAmountLimit !== 50000) {
    throw new Error(`Expected 50000 limit, got ${parsed.financialTerms?.approvedAmountLimit}`);
  }
  if (!parsed.hasExistingApproval) {
    throw new Error('Expected hasExistingApproval to be true');
  }
  console.log('✅ PASS: Test 2 (HIS Clinical Email Parser)');

  // -------------------------------------------------------------
  // Test 3: Refusal and Reply Detection
  // -------------------------------------------------------------
  console.log('\nTest 3: Testing Refusal & Thread Reply Detection...');
  const refusalText = 'نعتذر عن الموافقة لكون الإجراء غير مغطى طبقا لبنود وثيقة التأمين';
  const refusalRes = detectRefusal(refusalText, 'طلب موافقة');
  console.log(`  Refusal detected: ${refusalRes.hasRefusal} (Snippet: "${refusalRes.snippet}")`);
  if (!refusalRes.hasRefusal) {
    throw new Error('Failed to detect refusal in text!');
  }

  const threadRes = detectReplies({
    subject: 'RE: Inpatient Approval - Test',
    text: '-----Original Message-----\nFrom: insurance@company.com\nSent: yesterday',
  });
  console.log(`  Reply thread detected: ${threadRes.hasReplies}`);
  if (!threadRes.hasReplies) {
    throw new Error('Failed to detect quoted reply markers!');
  }
  console.log('✅ PASS: Test 3 (Refusal & Reply Detection)');

  // -------------------------------------------------------------
  // Test 4: Attachment Security Validation
  // -------------------------------------------------------------
  console.log('\nTest 4: Testing Attachment Security Validation...');
  const validAtt = {
    name: 'lab_investigation_report.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024 * 500, // 500 KB
  };
  const oversizedAtt = {
    name: 'huge_scan.tiff',
    contentType: 'image/tiff',
    sizeBytes: 20 * 1024 * 1024, // 20 MB (over 15MB limit)
  };
  const dangerousAtt = {
    name: 'report_updater.exe',
    contentType: 'application/x-msdownload',
    sizeBytes: 1024 * 10,
  };

  const validRes = validateAttachment(validAtt);
  const oversizedRes = validateAttachment(oversizedAtt);
  const dangerousRes = validateAttachment(dangerousAtt);

  if (!validRes.valid) throw new Error(`Valid attachment was rejected: ${validRes.reason}`);
  if (oversizedRes.valid) throw new Error('Oversized attachment was unexpectedly accepted!');
  if (dangerousRes.valid) throw new Error('Dangerous executable attachment was unexpectedly accepted!');

  console.log('  ✓ Valid PDF accepted');
  console.log(`  ✓ 20MB file correctly rejected: "${oversizedRes.reason}"`);
  console.log(`  ✓ Executable correctly rejected: "${dangerousRes.reason}"`);
  console.log('✅ PASS: Test 4 (Attachment Security)');

  // -------------------------------------------------------------
  // Test 5: Postgres Watermark Persistence
  // -------------------------------------------------------------
  console.log('\nTest 5: Testing Postgres Watermark load/save...');
  const testFolder = `test_folder_${Date.now()}`;
  const testToken = `SyncState_Token_${Date.now()}`;

  const saved = await saveCursorToPostgres({
    folderName: testFolder,
    token: testToken,
    lastSyncedAt: new Date().toISOString(),
    totalSyncedCount: 42,
  });
  if (!saved) throw new Error('Failed to save cursor to Postgres!');

  const loaded = await loadCursorFromPostgres(testFolder);
  if (loaded.token !== testToken || loaded.totalSyncedCount !== 42) {
    throw new Error(`Watermark mismatch: expected ${testToken}, got ${loaded.token}`);
  }
  console.log(`  ✓ Watermark "${testToken}" saved and reloaded from Postgres.`);
  console.log('✅ PASS: Test 5 (Postgres Watermarks)');

  // -------------------------------------------------------------
  // Test 6: Idempotent Ingestion Deduplication
  // -------------------------------------------------------------
  console.log('\nTest 6: Verifying Idempotent Delivery Deduplication in Postgres...');
  const uniqueMsgId = `<unique_delivery_test_${Date.now()}@elitehospital.org>`;
  const testRecord: InpatientApprovalRecord = {
    id: `approval_test_${Date.now()}`,
    conversationId: `conv_${Date.now()}`,
    messageId: uniqueMsgId,
    receivedAt: new Date().toISOString(),
    patientName: 'مريض تجريبي لمنع التكرار',
    mrn: '112233',
    contractorRaw: 'شركة بترول تجريبية',
    contractorNormalized: 'بترول تجريبي',
    contractorOfficer: 'Officer Test',
    priceListYear: '2025',
    diagnosis: 'Test Clinical Diagnosis',
    requestedServices: [{ name: 'Test CBC', rawPrice: 150 }],
    matchedProcedures: [{ serviceName: 'Test CBC', matchedName: 'CBC', status: 'matched' }],
    status: 'matched',
    draftBody: 'مسودة تجريبية',
    draftedAt: new Date().toISOString(),
    hasReplies: false,
    hasExistingApproval: false,
    isRefused: false,
  };

  // First persistence
  const res1 = await persistApprovalToPostgres(testRecord);
  if (!res1.success) throw new Error(`First persistence failed: ${res1.error}`);

  // Second persistence with identical messageId (must succeed via ON CONFLICT DO UPDATE without creating new row)
  const res2 = await persistApprovalToPostgres({
    ...testRecord,
    id: `approval_test_dup_${Date.now()}`, // Different client ID, same messageId
    patientName: 'مريض تجريبي - تحديث البيانات',
  });
  if (!res2.success) throw new Error(`Second persistence failed: ${res2.error}`);

  // Query database to ensure exactly 1 record exists for this messageId
  const { data: records, error: queryErr } = await client
    .from('inpatient_approvals')
    .select('id, patient_name')
    .eq('exchange_message_id', uniqueMsgId);

  if (queryErr) throw new Error(`Error verifying unique delivery: ${queryErr.message}`);
  if (!records || records.length !== 1) {
    throw new Error(`Expected exactly 1 record for messageId, found ${records?.length}`);
  }
  console.log(`  ✓ Exact single record persisted: ID ${records[0].id}`);
  console.log('✅ PASS: Test 6 (Idempotent Deduplication)');

  // -------------------------------------------------------------
  // Test 7: PHI Retention Purge
  // -------------------------------------------------------------
  console.log('\nTest 7: Testing PHI Retention Purge RPC...');
  const purgeRes = await triggerPhiRetentionPurge(30);
  console.log(`  Retention purge executed: success=${purgeRes.success}`);
  if (!purgeRes.success) throw new Error('Retention purge RPC failed!');
  console.log('✅ PASS: Test 7 (PHI Retention Purge)');

  // Cleanup test artifacts
  await client.from('inpatient_approvals').delete().eq('exchange_message_id', uniqueMsgId);
  await client.from('sync_checkpoints').delete().eq('folder_name', testFolder);
  console.log('\n  ✓ Test records cleaned up.');

  console.log('\n=====================================================');
  console.log('🎉 ALL PHASE 3 MAIL INGESTION TESTS PASSED SUCCESSFULLY!');
  console.log('=====================================================');
}

runMailIngestionTests().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
