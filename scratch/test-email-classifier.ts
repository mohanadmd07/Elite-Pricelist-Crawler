import { analyzeThreadWithHeuristics, UnifiedThreadInput } from '../src/services/aiMatchService';
import { resolveOfficerByContractor } from '../src/services/contractorOfficerResolver';

console.log('====================================================');
console.log('🧪 RUNNING COMPREHENSIVE APPROVAL CLASSIFIER TEST SUITE');
console.log('====================================================\n');

// 1. Test Contractor Officer Mappings from contacts_table.xlsx
console.log('--- 1. Testing Officer Mappings from contacts_table.xlsx ---');
const officerTests = [
  { contractor: 'شركة اسكندرية للبترول', expectedOfficer: 'محمد جابر' },
  { contractor: 'Wepco', expectedOfficer: 'زياد' },
  { contractor: 'بترومنت', expectedOfficer: 'زياد' },
  { contractor: 'Med Right', expectedOfficer: 'نادين' },
  { contractor: 'Ethydco', expectedOfficer: 'نادين' },
  { contractor: 'حديد عز', expectedOfficer: 'ديانا' },
  { contractor: 'وزارة العدل', expectedOfficer: 'ديانا' },
  { contractor: 'AMOC', expectedOfficer: 'أحمد حمزة' },
  { contractor: 'Next Care', expectedOfficer: 'أحمد حمزة' },
  { contractor: 'QNB', expectedOfficer: 'طارق' },
  { contractor: 'شركة اكسا', expectedOfficer: 'طارق' },
  { contractor: 'مصر للطيران', expectedOfficer: 'محمد ابو الوفا' },
];

let mapPassed = 0;
for (const t of officerTests) {
  const res = resolveOfficerByContractor(t.contractor);
  const ok = res.matched && res.officerName === t.expectedOfficer;
  if (ok) mapPassed++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] Contractor: "${t.contractor}" => Officer: "${res.officerName}" (Expected: "${t.expectedOfficer}", Conf: ${res.confidenceScore})`);
}
console.log(`Result: ${mapPassed}/${officerTests.length} officer mapping tests passed.\n`);

// 2. Test Email Reply Context & Edge-Case Classification
console.log('--- 2. Testing NLP Thread Classification & Edge Cases ---');

function createInput(subject: string, body: string, messages?: Array<{ sender: string; date: string; subject: string; body: string; isReply: boolean }>): UnifiedThreadInput {
  return {
    patientName: 'أحمد محمود علي',
    mrn: '123456',
    contractor: 'Med Right',
    diagnosis: 'Chest pain',
    initialServices: [{ name: 'Coronary Angiography', rawPrice: 15000 }],
    threadMessages: messages || [
      {
        sender: 'approvals@medright-eg.com',
        date: '2026-10-20T10:00:00Z',
        subject,
        body,
        isReply: true,
      },
    ],
    candidatePricelistRows: [
      { id: 101, nameEnglish: 'Coronary Angiography', nameArabic: 'قسطرة تشخيصية للشرايين التاجية' },
    ],
  };
}

const nlpTestCases = [
  {
    name: 'Boilerplate Closing Trap (Should be APPROVED, not pending)',
    input: createInput(
      'Re: Inpatient Approval - أحمد محمود علي',
      'لا مانع من إجراء القسطرة التشخيصية بحد أقصى 45 ألف جنيه ونسبة تحمل 10%. ويرجى موافاتنا بالفواتير والتكلفة التقديرية في حالة مد الإقامة أو رفع الحد الأقصى.'
    ),
    expectedStatus: 'approved',
    expectedLimit: 45000,
    expectedCopay: 10,
  },
  {
    name: 'Negation Trap ("cannot approve" should NOT be approved)',
    input: createInput(
      'Re: Inpatient Approval - أحمد محمود علي',
      'Dear Team, We reviewed the medical history and we cannot approve this procedure as it is not covered under the patient policy.'
    ),
    expectedStatus: 'refused',
    expectedLimit: null,
    expectedCopay: null,
  },
  {
    name: 'Chronological Superseding (Inquiry followed by approval)',
    input: createInput('Re: Inpatient Approval', '', [
      {
        sender: 'approvals@medright-eg.com',
        date: '2026-10-20T08:00:00Z',
        subject: 'Re: Inpatient Approval',
        body: 'برجاء موافاتنا بتقرير طبي مفصل ورسم قلب حديث للبت في التغطية.',
        isReply: true,
      },
      {
        sender: 'approvals@medright-eg.com',
        date: '2026-10-20T11:00:00Z',
        subject: 'Re: Inpatient Approval',
        body: 'تم استلام التقرير ولا مانع من عمل القسطرة التشخيصية باللائحة.',
        isReply: true,
      },
    ]),
    expectedStatus: 'approved',
    expectedLimit: null,
    expectedCopay: null,
  },
  {
    name: 'Out of Office (OOO) Auto-Reply Filtering',
    input: createInput('Automatic reply: Inpatient Approval', 'I am out of the office on annual leave until 25th October. Please contact customer service.', [
      {
        sender: 'approvals@medright-eg.com',
        date: '2026-10-20T09:00:00Z',
        subject: 'Automatic reply: Out of office',
        body: 'Automatic reply: I am out of the office on annual leave until 25th October.',
        isReply: true,
      },
    ]),
    expectedStatus: 'new_request', // Auto-reply is ignored; status remains new request
    expectedLimit: null,
    expectedCopay: null,
  },
  {
    name: 'Vague Short Affirmation ("ok معتمد")',
    input: createInput('Re: Inpatient Approval', 'ok معتمد'),
    expectedStatus: 'approved',
    expectedLimit: null,
    expectedCopay: null,
  },
  {
    name: 'Active Pending Documentation Request',
    input: createInput(
      'Re: Inpatient Approval',
      'يرجى موافاتنا بتقرير باثولوجي ورسم قلب حديث قبل النظر في اعتماد الحالة.'
    ),
    expectedStatus: 'pending_information',
    expectedLimit: null,
    expectedCopay: null,
  },
];

let nlpPassed = 0;
for (const tc of nlpTestCases) {
  const out = analyzeThreadWithHeuristics(tc.input);
  const statusOk = out.status === tc.expectedStatus;
  const limitOk = out.approvedAmountLimit === tc.expectedLimit;
  const copayOk = out.patientSharePercentage === tc.expectedCopay;

  const passed = statusOk && limitOk && copayOk;
  if (passed) nlpPassed++;

  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${tc.name}`);
  console.log(`       Status: "${out.status}" (Expected: "${tc.expectedStatus}")`);
  if (tc.expectedLimit !== null) {
    console.log(`       Limit: ${out.approvedAmountLimit} (Expected: ${tc.expectedLimit})`);
  }
  if (tc.expectedCopay !== null) {
    console.log(`       Copay: ${out.patientSharePercentage}% (Expected: ${tc.expectedCopay}%)`);
  }
  console.log(`       Reason: "${out.statusReasonArabic}"`);
}

console.log(`\nResult: ${nlpPassed}/${nlpTestCases.length} NLP classification tests passed.`);
console.log('====================================================');
