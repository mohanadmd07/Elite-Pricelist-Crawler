import { resolveOfficerByContractor, loadContractorOfficersFromExcel } from '../src/services/contractorOfficerResolver';

const testCases = [
  'جلوب ميد',
  'GlobeMed',
  'شركة بترول الصحراء الغربيه',
  'wepco',
  'بترومنت',
  'Petromaint',
  'مصر للطيران',
  'سيدبك',
  'Ethydco',
  'حديد عز',
  'Next Care',
  'نكست كير',
  'QNB',
  'شركة اكسا',
  'صان مصر',
  'EMC',
  'شركة الخدمات التجارية البترولية بتروتريد',
  'ابو قير للاسمدة',
  'وزارة العدل',
  'نقابة المهندسين',
];

console.log('--- Testing Contractor Officer Resolution ---');
for (const tc of testCases) {
  const res = resolveOfficerByContractor(tc);
  console.log(`[Query]: "${tc}" => Officer: "${res.officerName}" | Phone: "${res.officerPhone || 'N/A'}" | Conf: ${res.confidenceScore} (${res.matchType}) | Canonical: "${res.contractorNormalized}"`);
}
