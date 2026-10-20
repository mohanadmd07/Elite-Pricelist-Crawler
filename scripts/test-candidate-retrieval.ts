import { getCashData } from '../src/services/procedureService';
import { cleanHisProcedureQuery, normalizeText, normalizeArabic } from '../src/lib/arabic-normalizer';

const MEDICAL_SYNONYMS: Record<string, string[]> = {
  colonoscopy: ['lower git endoscopy', 'منظار قولون', 'منظار القولون'],
  'منظار قولون': ['lower git endoscopy', 'colonoscopy'],
  gastroscopy: ['upper git endoscopy', 'منظار معدة', 'منظار المعدة'],
  'منظار معدة': ['upper git endoscopy', 'gastroscopy'],
  cholecystectomy: ['استئصال المرارة', 'مرارة', 'gallbladder'],
  'استئصال المرارة': ['cholecystectomy', 'laparoscopic cholecystectomy', 'مرارة'],
  angiography: ['cardiac catheter', 'قسطرة القلب', 'قسطرة تشخيصية', 'coronary'],
  'قسطرة قلب': ['cardiac catheter', 'coronary angiography', 'قسطرة تشخيصية'],
  eeg: ['electroencephalography', 'رسم مخ', 'رسم المخ'],
  'رسم مخ': ['eeg', 'electroencephalography', 'رسم المخ'],
  echo: ['echocardiography', 'موجات صوتية على القلب', 'ايكو'],
  'ايكو': ['echocardiography', 'echo', 'موجات صوتية على القلب'],
  tee: ['transesophageal echocardiography', 'موجات فوق صوتية على القلب عن طريق المريء'],
  'مريء': ['transesophageal echocardiography', 'tee'],
  appendectomy: ['استئصال الزائدة', 'زائدة دودية'],
  'استئصال الزائدة': ['appendectomy', 'زائدة دودية'],
  hernia: ['فتق', 'hernioplasty', 'repair of hernia'],
  'فتق': ['hernia', 'hernioplasty', 'اصلاح فتق'],
};

function getExpandedQueries(input: string): string[] {
  const norm = normalizeText(input);
  const normAr = normalizeArabic(input);
  const results = new Set<string>([norm, normAr, input]);

  for (const [key, syns] of Object.entries(MEDICAL_SYNONYMS)) {
    if (norm.includes(key) || normAr.includes(key)) {
      syns.forEach((s) => results.add(s));
    }
  }
  return Array.from(results).filter(Boolean);
}

async function testRetrieval() {
  const catalog = await getCashData('2025');

  const testQueries = [
    'منظار قولون تشخيصي',
    'Colonoscopy diagnostic',
    'قسطرة قلب تشخيصية',
    'Coronary Angiography',
    'Laparoscopic Cholecystectomy',
    'استئصال المرارة بالمنظار',
    'رسم مخ بالكمبيوتر',
    'EEG',
    'موجات فوق صوتية على القلب عن طريق المريء TEE',
  ];

  for (const query of testQueries) {
    console.log(`\n=== Query: "${query}" ===`);
    const expanded = getExpandedQueries(query);

    const matches: Array<{ nameEn: string; nameAr: string; price: any; score: number }> = [];

    for (const item of catalog) {
      const itemEn = normalizeText(item.nameEnglish);
      const itemAr = normalizeArabic(item.nameArabic);

      let maxScore = 0;
      for (const q of expanded) {
        const qNorm = normalizeText(q);
        const qArNorm = normalizeArabic(q);

        if (qNorm && itemEn === qNorm) maxScore = Math.max(maxScore, 100);
        if (qArNorm && itemAr === qArNorm) maxScore = Math.max(maxScore, 100);
        if (qNorm && (itemEn.startsWith(qNorm) || itemEn.includes(qNorm))) maxScore = Math.max(maxScore, 50);
        if (qArNorm && (itemAr.startsWith(qArNorm) || itemAr.includes(qArNorm))) maxScore = Math.max(maxScore, 50);

        const tokens = (qNorm + ' ' + qArNorm).split(' ').filter((t) => t.length > 2);
        for (const t of tokens) {
          if (itemEn.includes(t) || itemAr.includes(t)) maxScore = Math.max(maxScore, maxScore + 10);
        }
      }

      if (maxScore > 15) {
        matches.push({
          nameEn: item.nameEnglish,
          nameAr: item.nameArabic,
          price: item.price,
          score: maxScore,
        });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    const top3 = matches.slice(0, 3);
    if (top3.length === 0) {
      console.log('  ❌ NO MATCH FOUND');
    } else {
      top3.forEach((m, idx) => {
        console.log(`  [Top ${idx + 1} | Score ${m.score}]: ${m.nameAr} / ${m.nameEn} (Price: ${m.price})`);
      });
    }
  }
}

testRetrieval().catch(console.error);
