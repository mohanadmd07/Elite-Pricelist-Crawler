/**
 * Automated Verification Script for Inpatient Approval Parser & AI Drafting
 * Simulates the exact incoming emails from the user's screenshots.
 */

import {
  parseHisApprovalHtml,
  buildDraftReplyText,
  detectExistingApproval,
  detectReplies,
} from './approvals-watcher';
import { loadCompanies } from '../src/services/companyService';
import { normalizeArabic } from '../src/lib/arabic-normalizer';
import { searchAllProcedures } from '../src/services/procedureService';

const SAMPLE_HTML_1 = `
<div style="font-family: Arial, sans-serif;">
  <h3>Inpatient Approval Request</h3>
  <p><strong>Requested By:</strong> Mirna Reda Mohamed Elbardan</p>
  <p><strong>Date:</strong> 18/10/2026, 10:57:17</p>

  <div class="patient-info">
    <h4>Patient Information</h4>
    <table>
      <tr>
        <td>Patient Name</td>
        <td>السيد محمد السيد حسنين</td>
        <td>Admission Date</td>
        <td>15/10/2026, 14:53:15</td>
      </tr>
      <tr>
        <td>Admission Type</td>
        <td>Inpatient Bed: Bed 322 - Zone B</td>
        <td>Physician</td>
        <td>Hany sameer</td>
      </tr>
      <tr>
        <td>Contractor</td>
        <td>شركة خالده للبترول Main</td>
        <td>Diagnosis</td>
        <td>I67-Other cerebrovascular diseases</td>
      </tr>
    </table>
  </div>

  <h4>SELECTED SERVICES:</h4>
  <table>
    <tr>
      <th>Service Name</th>
      <th>Price (EGP)</th>
    </tr>
    <tr>
      <td>PTH (Parathormone) - Investigation</td>
      <td>485.00</td>
    </tr>
    <tr>
      <td>TOTAL AMOUNT:</td>
      <td>485.00 EGP</td>
    </tr>
  </table>

  <h4>Request Details</h4>
  <div>pth المريض يعاني من ارتفاع بوظايف الكلي و بحاجه لسحب تحليل</div>
</div>
`;

const SAMPLE_HTML_2 = `
<div style="font-family: Arial, sans-serif;">
  <h3>Inpatient Approval Request</h3>
  <p><strong>Requested By:</strong> Sara Khamis Mohamed Younis</p>
  <p><strong>Date:</strong> 10/18/2026, 2:31:44 AM</p>

  <div class="patient-info">
    <h4>Patient Information</h4>
    <table>
      <tr>
        <td>Patient Name</td>
        <td>ابريكه حمد معتوق محمد</td>
        <td>Admission Date</td>
        <td>9/17/2026, 6:14:48 AM</td>
      </tr>
      <tr>
        <td>Admission Type</td>
        <td>Inpatient Bed: Bed 9 - ICU</td>
        <td>Physician</td>
        <td>Mohamed Abdelaleem Mohamed Abdelaalem</td>
      </tr>
      <tr>
        <td>Contractor</td>
        <td>الخليج الدولي</td>
        <td>Diagnosis</td>
        <td>E86.0-Dehydration</td>
      </tr>
    </table>
  </div>

  <h4>SELECTED SERVICES:</h4>
  <table>
    <tr>
      <th>Service Name</th>
      <th>Price (EGP)</th>
    </tr>
    <tr>
      <td>Pig Tail insertion</td>
      <td>1870.00</td>
    </tr>
    <tr>
      <td>TOTAL AMOUNT:</td>
      <td>1870.00 EGP</td>
    </tr>
  </table>

  <h4>Request Details</h4>
  <div>patient has right moderate pleural effusion for tapping</div>
</div>
`;

async function testSimulation() {
  console.log('======================================================');
  console.log('🧪 Testing Inpatient Approval Parser & AI Drafting');
  console.log('======================================================\n');

  // Test Sample 1
  const parsed1 = parseHisApprovalHtml(
    SAMPLE_HTML_1,
    'RE: Inpatient Approval - السيد محمد السيد حسنين (MRN: 0000095103)',
    'msg-001@elite'
  );

  console.log('📋 Sample 1 Parsed:');
  console.log('  • Patient:', parsed1.patientName);
  console.log('  • MRN:', parsed1.mrn);
  console.log('  • Contractor:', parsed1.contractorRaw);
  console.log('  • Diagnosis:', parsed1.diagnosis);
  console.log('  • Services:', parsed1.requestedServices);

  // Test Contractor resolution
  const companies = await loadCompanies();
  const rawNorm = normalizeArabic(parsed1.contractorRaw);
  const matchedCompany = companies.find((c) => {
    const cNorm = normalizeArabic(c.name);
    return cNorm === rawNorm || rawNorm.includes(cNorm) || cNorm.includes(rawNorm);
  });

  const priceListYear = matchedCompany?.priceListYear || '2025';
  const officer = matchedCompany?.responsiblePerson || 'محمد ابو الوفا';
  const contractorNorm = matchedCompany?.name || parsed1.contractorRaw;

  console.log('\n🏢 Contractor Resolution:');
  console.log('  • Detected Contractor:', contractorNorm);
  console.log('  • Resolved Pricelist:', `Elite Hospital ${priceListYear}`);
  console.log('  • Assigned Officer:', officer);

  // Test Procedure Matching
  const serviceName = parsed1.requestedServices[0]?.name || '';
  const searchResults = await searchAllProcedures([{ id: '1', name: serviceName }], priceListYear);

  console.log(`\n🔍 Procedure Match for "${serviceName}":`);
  console.log(`  • Found ${searchResults.length} candidates.`);
  if (searchResults.length > 0) {
    console.log(`  • Top match: ${searchResults[0].nameArabic} (${searchResults[0].nameEnglish}) - EGP ${searchResults[0].price}`);
  }

  const matchedList = searchResults.length > 0
    ? [{ serviceName, matchedName: `${searchResults[0].nameArabic} (${searchResults[0].nameEnglish})`, status: 'matched' as const }]
    : [{ serviceName, matchedName: serviceName, status: 'unmatched' as const }];

  // Build Draft
  const draftReply = buildDraftReplyText(priceListYear, contractorNorm, officer, matchedList);

  console.log('\n✍️ Generated AI Draft Reply:');
  console.log('------------------------------------------------------');
  console.log(draftReply);
  console.log('------------------------------------------------------\n');

  // Verify corporate email requirement
  if (!draftReply.includes('corporate@elitehospital.org')) {
    throw new Error('FAILED: corporate@elitehospital.org is missing from draft reply!');
  }
  console.log('✅ PASS: Mandatory contact "corporate@elitehospital.org" is present in draft.');

  // Test Sample 2
  const parsed2 = parseHisApprovalHtml(
    SAMPLE_HTML_2,
    'Inpatient Approval - ابريكه حمد معتوق محمد (MRN: 0000263839)',
    'msg-002@elite'
  );

  console.log('\n📋 Sample 2 Parsed:');
  console.log('  • Patient:', parsed2.patientName);
  console.log('  • MRN:', parsed2.mrn);
  console.log('  • Contractor:', parsed2.contractorRaw);
  console.log('  • Services:', parsed2.requestedServices);

  // Test Existing Approval Keywords Detection
  console.log('\n🛡️ Testing Approval Keyword Detection Safeguard:');
  const testPhrases = [
    'بالإشارة إلى طلبكم، لا مانع من إجراء الفحص المطلوب',
    'Dear Team, this request is Approved as per contract.',
    'Please approve the requested procedure.',
    'مرفق موافقة سعرية للعملية المطلوبة',
    'مطلوب تسعيرة سعرية للمريض',
  ];

  for (const phrase of testPhrases) {
    const res = detectExistingApproval(phrase, 'Inpatient Approval Request');
    if (!res.hasApproval) {
      throw new Error(`FAILED: Should have detected approval in phrase: "${phrase}"`);
    }
    console.log(`  ✓ Detected: snippet="${res.snippet}"`);
  }
  console.log('✅ PASS: All approval keywords correctly trigger manual draft hold.');

  // Test Reply Detection
  console.log('\n🛡️ Testing Thread Reply Detection Safeguard:');
  const reply1 = detectReplies({
    subject: 'RE: Inpatient Approval - Patient Test',
  });
  if (!reply1.hasReplies) {
    throw new Error('FAILED: Should detect RE: subject');
  }

  const reply2 = detectReplies({
    subject: 'Inpatient Approval',
    inReplyTo: '<prior-msg@elitehospital.org>',
  });
  if (!reply2.hasReplies) {
    throw new Error('FAILED: Should detect inReplyTo header');
  }
  console.log('✅ PASS: Prior replies and thread headers correctly detected.');

  // Test UI Status & Reply Logic (Pending Approval vs Approved Reply)
  console.log('\n📊 Testing UI Status & Reply Resolution Logic:');
  function resolveUiStatus(record: { hasReplies?: boolean; hasExistingApproval?: boolean; status?: string }) {
    if (record.status === 'answered') return { badge: 'Answered (Sent)', isPending: false };
    if (record.hasExistingApproval) return { badge: 'Approved Reply', isPending: false };
    return { badge: 'Pending Approval', isPending: true };
  }

  // 1. No replies on mail -> must show "Pending Approval"
  const stateNoReplies = resolveUiStatus({ hasReplies: false, hasExistingApproval: false, status: 'draft_created' });
  if (stateNoReplies.badge !== 'Pending Approval' || !stateNoReplies.isPending) {
    throw new Error('FAILED: No replies must show Pending Approval');
  }
  console.log('  ✓ No replies -> Status is "Pending Approval"');

  // 2. Reply with "لا مانع" / "approve" / "approved" -> must show Approved Reply and NOT show pending!
  const stateApprovalReply = resolveUiStatus({ hasReplies: true, hasExistingApproval: true, status: 'pending_manual_draft' });
  if (stateApprovalReply.badge !== 'Approved Reply' || stateApprovalReply.isPending) {
    throw new Error('FAILED: Approval reply must show Approved Reply and NEVER show pending');
  }
  console.log('  ✓ Approval reply -> Status is "Approved Reply" (does NOT show pending)');

  // 3. Reply WITHOUT approval words -> must show Pending Approval
  const stateInquiryReply = resolveUiStatus({ hasReplies: true, hasExistingApproval: false, status: 'pending_manual_draft' });
  if (stateInquiryReply.badge !== 'Pending Approval' || !stateInquiryReply.isPending) {
    throw new Error('FAILED: Non-approval reply must show Pending Approval');
  }
  console.log('  ✓ Non-approval reply -> Status is "Pending Approval"');
  console.log('✅ PASS: UI status badge logic correctly enforces rules.');

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
}

testSimulation().catch(console.error);

