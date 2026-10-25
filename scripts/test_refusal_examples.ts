import { parseHisApprovalEmail } from '../src/mail/parser/hisApprovalParser';
import { generateCmWhatsappMessage } from '../src/lib/whatsapp-generator';
import { RawMailMessage } from '../src/mail/types';

function createMockEmail(replyBody: string): RawMailMessage {
  const mid = 'test-' + Math.random().toString(36).slice(2);
  return {
    id: mid,
    conversationId: 'conv-' + mid,
    messageId: mid,
    subject: 'Re: Inpatient Approval Request',
    sender: 'approvals@insurance.com',
    receivedAt: new Date().toISOString(),
    textBody: replyBody,
    htmlBody: `<div dir="rtl">${replyBody.replace(/\n/g, '<br>')}</div>`,
    attachments: [],
  };
}

const refusalCases = [
  {
    input: 'يتم تنسيق عمل التحليل طرف التعاقد والمريض في معمل خارجي ',
    expectedType: 'refusal',
    expectedReason: 'تنسيق التحليل بمعمل خارجي',
  },
  {
    input: 'جميع الاجراءات للحاله غير مغطاه\nلعدم مد الاقامه ورفع الحد الاقصي من شركه تعاقد المريض',
    expectedType: 'refusal',
    expectedReason: 'لعدم مد الإقامة ورفع الحد الأقصى',
  },
  {
    input: 'غير مغطي \nكاش طرف الاهل ',
    expectedType: 'refusal',
    expectedReason: 'كاش طرف الأهل',
  },
  {
    input: 'غير مغطي تامينيا ',
    expectedType: 'refusal',
    expectedReason: 'غير مغطى تأمينياً',
  },
  {
    input: 'الحاله غير مغطاه',
    expectedType: 'refusal',
    expectedReason: 'غير مغطى',
  },
  {
    input: 'غير مغطى \nبرجاء توجيه الاهل للرسيبشن للتغطيه ',
    expectedType: 'refusal',
    expectedReason: 'توجيه الأهل للريسبشن للتغطية',
  },
  {
    input: 'غير مغطي\nبرجاء توجيه الاهل للرسيبشن للتغطيه ',
    expectedType: 'refusal',
    expectedReason: 'توجيه الأهل للريسبشن للتغطية',
  },
  {
    input: 'الحاله غير مغطاه برجاء ضروره توجيه اهل الحاله لقسم حسابات المرضي',
    expectedType: 'refusal',
    expectedReason: 'توجيه الأهل لقسم حسابات المرضى',
  },
  {
    input: 'غير مغطي',
    expectedType: 'refusal',
    expectedReason: 'غير مغطى',
  },
  {
    input: 'غير مغطاه برجاء ارسال الاهل للحسابات للتغطيه\n',
    expectedType: 'refusal',
    expectedReason: 'إرسال الأهل للحسابات للتغطية',
  },
  {
    input: 'غير مغطى برجاء ارسال الاهل للتغطيه\n',
    expectedType: 'refusal',
    expectedReason: 'إرسال الأهل للحسابات للتغطية',
  },
  {
    input: 'غير مغطي\n',
    expectedType: 'refusal',
    expectedReason: 'غير مغطى',
  },
  {
    input: 'غير مغطي تامنيا\n',
    expectedType: 'refusal',
    expectedReason: 'غير مغطى تأمينياً',
  },
];

const conditionalCases = [
  {
    input: 'ماعدا تحليل hiv غير مغطي',
    expectedCondition: 'ما عدا تحليل HIV غير مغطى',
  },
  {
    input: 'علما بان تحليل العينه غير مغطي داخل المستشفي',
    expectedCondition: 'داخل المستشفى',
  },
  {
    input: 'الحاله غير مغطاه وتم الرد عليكم فى ميل سابق بان الحاله مغطاه لمده يوم واحد فقط من تاريخ الخروج من العنايه\n',
    expectedCondition: 'مغطاة لمدة يوم واحد فقط',
  },
];

const approvalCases = [
  'لامانع من الدخول طوارئ  لتلقى العلاج التحفظى  لحالة ارتجاج ما بعد حادث سير -  الحد الأقصى للموافقة 30000 جنيه فقط لا غير مع موافاتنا بكافة الفحوصات والتكلفة التقديرية في حالة الاحتياج لرفع الحد الاقصى أو مد الاقامة.\nThis adherent has a co-payment of 20% on this approval. ',
  'ﻻﻣﺎﻧﻊ ﻣن اﻟدﺧول طوارئ رﻋﺎﯾﺔ ﻟﺗﻠﻘﻰ اﻟﻌﻼج اﻟﺗﺣﻔظﻰ ﻟﺣﺎﻟﺔ اﺷﺗﺑﺎه ﻣﺎ ﺑﻌد ارﺗﺟﺎج ﺑﺎﻟﻣﺦ وﺟرح ﺑﺎﻟﺣﺎﺟب وﺟرح ﺑﺎﻟﺳﺎق اﺛر ﺣﺎدث ﺳﯾر -ﻣﻼﺣظﺎت وﺗﻔﺎﺻﯾل اﻟﺗﻐطﯾﮫ \n. اﻟﺣد اﻷﻗﺻﻰ ﻟﻠﻣواﻓﻘﺔ 30 اﻟف ﺟﻧﯾﮫ ﻓﻘط ﻻ ﻏﯾر ﻣﻊ ﻣوافاتنا بكافة الفحوصات والتكلفة التقديرية في حالة الاحتياج لرفع الحد الاقصى أو مد الاقامة ',
  'مرفق الموافقه ',
  'لا مانع',
  'لا مانع من عمل اللازم \nالموافقة السعرية طرفى \n',
  '‏لا مانع طبقا للتعاقد\n',
  'مرفق اليكم الموافقه  \n',
  'Approved\n\nKind Regards,\n\nIbrahim Samir\n\nInternational Marketing Senior\n',
  'لا مانع من عمل العمليه المطلوب علي ان تكون بأسعار التعاقد \nوفقا لتعليمات التشغيل\n',
];

console.log('--- TESTING 13 REFUSAL CASES ---');
let refusalPassed = 0;
for (const c of refusalCases) {
  const parsed = parseHisApprovalEmail(createMockEmail(c.input));
  const isRefused = parsed.isRefused;
  const reason = parsed.refusalReason;
  const whatsapp = generateCmWhatsappMessage({
    id: 'test',
    messageId: 'test',
    receivedAt: new Date().toISOString(),
    patientName: 'مريض تجريبي',
    mrn: '12345',
    bed: '201',
    contractorNormalized: 'التعاقد',
    contractorRaw: 'التعاقد',
    priceListYear: '2025',
    diagnosis: 'اشتباه كسر',
    contractorOfficer: 'غير محدد',
    status: 'refused',
    isRefused: true,
    statusReasonArabic: parsed.statusReasonArabic,
    requestedServices: [],
    matchedProcedures: [],
    draftBody: '',
    draftedAt: new Date().toISOString(),
  });

  if (isRefused && reason === c.expectedReason) {
    refusalPassed++;
    console.log(`✅ PASS: [${c.expectedReason}] -> WA: ${whatsapp.split('\n')[2]}`);
  } else {
    console.error(`❌ FAIL: Expected refused with "${c.expectedReason}", got isRefused=${isRefused}, reason="${reason}" for:`, JSON.stringify(c.input));
  }
}

console.log('\n--- TESTING 3 CONDITIONAL CASES ---');
let condPassed = 0;
for (const c of conditionalCases) {
  const parsed = parseHisApprovalEmail(createMockEmail(c.input));
  const hasApproval = parsed.hasExistingApproval;
  const isRefused = parsed.isRefused;
  const condText = parsed.financialTerms?.coverageConditions || '';
  const whatsapp = generateCmWhatsappMessage({
    id: 'test',
    messageId: 'test',
    receivedAt: new Date().toISOString(),
    patientName: 'مريض تجريبي',
    mrn: '12345',
    bed: '201',
    contractorNormalized: 'التعاقد',
    contractorRaw: 'التعاقد',
    priceListYear: '2025',
    diagnosis: 'جراحة عامة',
    contractorOfficer: 'غير محدد',
    status: 'answered',
    hasExistingApproval: true,
    isRefused: false,
    coverageConditions: condText,
    requestedServices: [],
    matchedProcedures: [],
    draftBody: '',
    draftedAt: new Date().toISOString(),
  });

  if (hasApproval && !isRefused && condText.includes(c.expectedCondition)) {
    condPassed++;
    console.log(`✅ PASS: [Condition: ${condText}] -> WA: ${whatsapp.split('\n')[2]}`);
  } else {
    console.error(`❌ FAIL: hasApproval=${hasApproval}, isRefused=${isRefused}, condText="${condText}" for:`, JSON.stringify(c.input));
  }
}

console.log('\n--- TESTING 9 PREVIOUS APPROVAL CASES ---');
let appPassed = 0;
for (const a of approvalCases) {
  const parsed = parseHisApprovalEmail(createMockEmail(a));
  if (parsed.hasExistingApproval && !parsed.isRefused) {
    appPassed++;
    console.log(`✅ PASS: Approval detected`);
  } else {
    console.error(`❌ FAIL: Expected approval for:`, JSON.stringify(a));
  }
}

console.log(`\nResults: Refusals ${refusalPassed}/${refusalCases.length} | Conditionals ${condPassed}/${conditionalCases.length} | Approvals ${appPassed}/${approvalCases.length}`);
if (refusalPassed === refusalCases.length && condPassed === conditionalCases.length && appPassed === approvalCases.length) {
  console.log('🎉 ALL 25 CASES PASSED 100% PERFECTLY! 🎉');
} else {
  process.exit(1);
}
