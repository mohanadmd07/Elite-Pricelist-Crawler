import {
  detectExistingApproval,
  extractCreditLimit,
  extractCoPayment,
} from '../src/mail/parser/hisApprovalParser';

const testExamples = [
  {
    name: 'Example 1: Emergency admission + 30k limit + 20% co-pay',
    text: `لامانع من الدخول طوارئ  لتلقى العلاج التحفظى  لحالة ارتجاج ما بعد حادث سير -  الحد الأقصى للموافقة 30000 جنيه فقط لا غير مع موافاتنا بكافة الفحوصات والتكلفة التقديرية في حالة الاحتياج لرفع الحد الاقصى أو مد الاقامة.
This adherent has a co-payment of 20% on this approval. `,
    expectedApproval: true,
    expectedLimit: 30000,
    expectedCopay: 20,
  },
  {
    name: 'Example 2: ICU admission with ligatures + 30k written in words',
    text: `ﻻﻣﺎﻧﻊ ﻣن اﻟدﺧول طوارئ رﻋﺎﯾﺔ ﻟﺗﻠﻘﻰ اﻟﻌﻼج اﻟﺗﺣﻔظﻰ ﻟﺣﺎﻟﺔ اﺷﺗﺑﺎه ﻣﺎ ﺑﻌد ارﺗﺟﺎج ﺑﺎﻟﻣﺦ وﺟرح ﺑﺎﻟﺣﺎﺟب وﺟرح ﺑﺎﻟﺳﺎق اﺛر ﺣﺎدث ﺳﯾر -ﻣﻼﺣظﺎت وﺗﻔﺎﺻﯾل اﻟﺗﻐطﯾﮫ 
. اﻟﺣد اﻷﻗﺻﻰ ﻟﻠﻣواﻓﻘﺔ 30 اﻟف ﺟﻧﯾﮫ ﻓﻘط ﻻ ﻏﯾر ﻣﻊ ﻣواﻓﺎﺗﻧﺎ ﺑﻛﺎﻓﺔ اﻟﻔﺣوﺻﺎت واﻟﺗﻛﻠﻔﺔ اﻟﺗﻘدﯾرﯾﺔ ﻓﻲ ﺣﺎﻟﺔ اﻻﺣﺗﯾﺎج ﻟرﻓﻊ اﻟﺣد اﻻﻗﺻﻰ أو ﻣد اﻻﻗﺎﻣﺔ `,
    expectedApproval: true,
    expectedLimit: 30000,
  },
  {
    name: 'Example 3: Attached approval',
    text: `مرفق الموافقه `,
    expectedApproval: true,
  },
  {
    name: 'Example 4: Standalone La Manea',
    text: `لا مانع`,
    expectedApproval: true,
  },
  {
    name: 'Example 5: Do needful + price approval',
    text: `لا مانع من عمل اللازم 
الموافقة السعرية طرفى 
`,
    expectedApproval: true,
  },
  {
    name: 'Example 6: Per contract',
    text: `لا مانع طبقا للتعاقد
`,
    expectedApproval: true,
  },
  {
    name: 'Example 7: Attached to you',
    text: `مرفق اليكم الموافقه  
`,
    expectedApproval: true,
  },
  {
    name: 'Example 8: English Approved + Signature',
    text: `Approved

Kind Regards,

Ibrahim Samir

International Marketing Senior
`,
    expectedApproval: true,
  },
  {
    name: 'Example 9: Surgery per contract prices & operating instructions',
    text: `لا مانع من عمل العمليه المطلوب علي ان تكون بأسعار التعاقد 
وفقا لتعليمات التشغيل
`,
    expectedApproval: true,
  },
];

console.log('Testing updated parser against 9 user examples...\n');
let allPassed = true;
for (const ex of testExamples) {
  const result = detectExistingApproval(ex.text, '', ex.text);
  const credit = extractCreditLimit(ex.text);
  const copay = extractCoPayment(ex.text);
  const passApproval = result.hasApproval === ex.expectedApproval;
  const passLimit = ex.expectedLimit ? credit.limit === ex.expectedLimit : true;
  const passCopay = ex.expectedCopay ? copay.percentage === ex.expectedCopay : true;

  const passed = passApproval && passLimit && passCopay;
  if (!passed) allPassed = false;

  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${ex.name}`);
  console.log(`  hasApproval: ${result.hasApproval} (expected: ${ex.expectedApproval})`);
  if (ex.expectedLimit) {
    console.log(`  limit: ${credit.limit} (expected: ${ex.expectedLimit})`);
  }
  if (ex.expectedCopay) {
    console.log(`  copay: ${copay.percentage}% (expected: ${ex.expectedCopay}%)`);
  }
  console.log(`  snippet: "${result.snippet.slice(0, 60)}..."`);
  console.log('----------------------------------------------------');
}

console.log(`\nOverall Result: ${allPassed ? 'ALL 9 EXAMPLES PASSED ✅' : 'FAILURES OCCURRED ❌'}`);
