import 'dotenv/config';
import {
  analyzeThreadWithUnifiedAI,
  analyzeThreadWithHeuristics,
  UnifiedThreadInput,
} from '../src/services/aiMatchService';

async function runTests() {
  console.log('=====================================================');
  console.log(' Testing Unified Contextual AI Agent & Heuristics');
  console.log('=====================================================');

  const candidatePricelistRows = [
    { id: 1, nameEnglish: 'CORONARY ANGIOGRAPHY', nameArabic: 'قسطرة تشخيصية على الشرايين التاجية' },
    { id: 2, nameEnglish: 'ELECTROENCEPHALOGRAPHY (EEG)', nameArabic: 'رسم مخ' },
    { id: 3, nameEnglish: 'TRANSESOPHAGEAL ECHOCARDIOGRAPHY (TEE)', nameArabic: 'موجات فوق صوتية على القلب عن طريق المريء' },
    { id: 4, nameEnglish: 'TRANSTHORACIC ECHOCARDIOGRAPHY (TTE)', nameArabic: 'إيكو على القلب عن طريق الصدر' },
  ];

  // Test Case 1: Conditional Approval with Co-pay and Financial Cap
  console.log('\n--- [Test 1: Conditional Approval with Co-Pay and Cap] ---');
  const input1: UnifiedThreadInput = {
    patientName: 'أحمد محمود علي',
    mrn: '10023456',
    bed: 'Bed 302',
    admissionType: 'Inpatient',
    contractor: 'شركة أكسيس للرعاية الصحية',
    contractorOfficer: 'محمد شحاتة',
    priceListYear: '2025',
    diagnosis: 'الاشتباه في انسداد الشرايين التاجية والذبحة الصدرية',
    initialServices: [{ name: 'Coronary Angiography', rawPrice: 12000 }],
    threadMessages: [
      {
        sender: 'his.notifications@elitehospital.org',
        date: '2026-10-20T08:00:00Z',
        subject: 'Inpatient Approval - أحمد محمود علي (MRN: 10023456)',
        body: 'برجاء الموافقة على عمل قسطرة تشخيصية للشرايين التاجية للمريض',
        isReply: false,
      },
      {
        sender: 'approvals@axis-care.com',
        date: '2026-10-20T08:30:00Z',
        subject: 'RE: Inpatient Approval - أحمد محمود علي (MRN: 10023456)',
        body: 'السادة مستشفى إيليت، تحية طيبة، تمت الموافقة على إجراء القسطرة التشخيصية بحد أقصى 15,000 جنيه، بنسبة تحمل 10% على المريض، ومشروط بإرسال تقرير القسطرة فور الانتهاء.',
        isReply: true,
      },
    ],
    candidatePricelistRows,
  };

  const res1 = await analyzeThreadWithUnifiedAI(input1);
  console.log('Result 1 (AI / Heuristics):');
  console.log('  Status:', res1.status);
  console.log('  Reason:', res1.statusReasonArabic);
  console.log('  Co-Pay %:', res1.patientSharePercentage);
  console.log('  Approved Cap:', res1.approvedAmountLimit);
  console.log('  Conditions:', res1.coverageConditions);
  console.log('  Executive Summary:', res1.executiveSummaryArabic);
  console.log('  Matched Procedures:', res1.matchedProcedures);
  console.log('  CM WhatsApp:', res1.cmWhatsappMessage);

  // Test Case 2: Information Requested (Pending Information)
  console.log('\n--- [Test 2: Insurance Requests Medical Report & Pathology] ---');
  const input2: UnifiedThreadInput = {
    patientName: 'مريم إبراهيم عبد الله',
    mrn: '10045678',
    bed: 'Bed 205',
    admissionType: 'Inpatient',
    contractor: 'نقابة المهندسين بالاسكندرية',
    contractorOfficer: 'أحمد سعيد',
    priceListYear: '2025',
    diagnosis: 'ورم ليفي بالرحم مع نزيف حاد',
    initialServices: [{ name: 'استئصال ورم ليفي', rawPrice: 25000 }],
    threadMessages: [
      {
        sender: 'his.notifications@elitehospital.org',
        date: '2026-10-20T09:00:00Z',
        subject: 'Inpatient Approval - مريم إبراهيم عبد الله (MRN: 10045678)',
        body: 'مطلوب الموافقة على استئصال ورم ليفي للمريضة',
        isReply: false,
      },
      {
        sender: 'medical@eng-syndicate.org',
        date: '2026-10-20T09:45:00Z',
        subject: 'RE: Inpatient Approval - مريم إبراهيم عبد الله (MRN: 10045678)',
        body: 'يرجى موافاتنا بتقرير طبي مفصل من الطبيب المعالج مع تقرير الأشعة التلفزيونية وبيان حجم الورم قبل البت في الموافقة.',
        isReply: true,
      },
    ],
    candidatePricelistRows,
  };

  const res2 = await analyzeThreadWithUnifiedAI(input2);
  console.log('Result 2 (AI / Heuristics):');
  console.log('  Status:', res2.status);
  console.log('  Reason:', res2.statusReasonArabic);
  console.log('  Conditions:', res2.coverageConditions);
  console.log('  Executive Summary:', res2.executiveSummaryArabic);

  // Test Case 3: Refusal / Not Covered
  console.log('\n--- [Test 3: Not Covered / Refusal] ---');
  const input3: UnifiedThreadInput = {
    patientName: 'خالد مصطفى حسن',
    mrn: '10088990',
    bed: 'Bed 410',
    admissionType: 'Inpatient',
    contractor: 'ميدنت مصر للرعاية الطبية',
    contractorOfficer: 'عمرو فؤاد',
    priceListYear: '2025',
    diagnosis: 'فحص روتيني شامل',
    initialServices: [{ name: 'رسم مخ', rawPrice: 3500 }],
    threadMessages: [
      {
        sender: 'his.notifications@elitehospital.org',
        date: '2026-10-20T10:00:00Z',
        subject: 'Inpatient Approval - خالد مصطفى حسن (MRN: 10088990)',
        body: 'طلب موافقة رسم مخ',
        isReply: false,
      },
      {
        sender: 'approvals@mednet.com',
        date: '2026-10-20T10:15:00Z',
        subject: 'RE: Inpatient Approval - خالد مصطفى حسن (MRN: 10088990)',
        body: 'نعتذر عن الموافقة، الفحص غير مغطى بالوثيقة التأمينية كونه فحص تشخيصي روتيني خارج التغطية.',
        isReply: true,
      },
    ],
    candidatePricelistRows,
  };

  const res3 = await analyzeThreadWithUnifiedAI(input3);
  console.log('Result 3 (AI / Heuristics):');
  console.log('  Status:', res3.status);
  console.log('  Reason:', res3.statusReasonArabic);
  console.log('  Executive Summary:', res3.executiveSummaryArabic);

  console.log('\n=====================================================');
  console.log(' ✅ All test cases executed successfully!');
  console.log('=====================================================');
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
