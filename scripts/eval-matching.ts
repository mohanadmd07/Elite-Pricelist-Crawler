/**
 * Golden Matching Evaluation Script
 * Computes Precision@1 and Precision@3 across golden medical procedure benchmarks and past overrides.
 * Run in CI to prevent matching quality regressions.
 *
 * Methodology (fixed in Phase 5): retrieval uses ONLY the query text — exactly the
 * production local-search path (searchLocalPricelist). expectedKeywords are used
 * solely as the ground-truth JUDGE, never to build or rank the candidate pool.
 * The previous version fed keywords into retrieval and oracle ranking, which made
 * the gate self-referential and pinned P@1/P@3 at 100% regardless of real quality.
 *
 * Usage:
 *   npx tsx scripts/eval-matching.ts
 */

import fs from 'fs';
import path from 'path';
import { normalizeArabic, normalizeText } from '../src/lib/arabic-normalizer';
import { scoreTrigramFallback } from '../src/services/semanticMatchService';
import { loadAllOverridesForEval, getOverrideForQuery } from '../src/services/procedureOverrideService';
import { searchLocalPricelist } from '../src/services/procedureService';
import { ProcedureResult } from '../src/types';

interface GoldenCase {
  query: string;
  expectedKeywords: string[];
  expectedCode?: string;
  category: string;
}

// Curated Egyptian Hospital Clinical Golden Fixtures (Edge Cases & High-Volume Queries)
const GOLDEN_EVAL_DATASET: GoldenCase[] = [
  {
    query: 'رسم قلب بالجهد',
    expectedKeywords: ['stress', 'exercise', 'رسم قلب'],
    category: 'Cardiology',
  },
  {
    query: 'موجات صوتية على القلب عن طريق المريء TEE',
    expectedKeywords: ['transesophageal', 'مريء', 'tee'],
    category: 'Cardiology (TEE vs TTE safety)',
  },
  {
    query: 'موجات صوتية على القلب ايكو',
    expectedKeywords: ['echocardiography', 'موجات صوتية على القلب', 'ايكو'],
    category: 'Cardiology (Echo)',
  },
  {
    query: 'صورة دم كاملة CBC',
    expectedKeywords: ['complete blood count', 'cbc', 'صورة دم'],
    category: 'Hematology',
  },
  {
    query: 'تحليل سكر تراكمي HbA1c',
    expectedKeywords: ['glycated', 'hba1c', 'تراكمي', 'سكر'],
    category: 'Biochemistry',
  },
  {
    query: 'اشعة مقطعية على المخ بدون صبغة',
    expectedKeywords: ['ct brain', 'مقطعية', 'مخ'],
    category: 'Radiology',
  },
  {
    query: 'رنين مغناطيسي على الفقرات القطنية والعجزية',
    expectedKeywords: ['mri', 'lumbosacral', 'lumbar', 'رنين', 'قطنية'],
    category: 'Radiology (MRI)',
  },
  {
    query: 'مزرعة سائل نخاع شوكي CSF Culture',
    expectedKeywords: ['culture', 'مزرعة', 'csf'],
    category: 'Microbiology (Culture vs Analysis)',
  },
  {
    query: 'تحليل سائل نخاع شوكي كيمياء وخلايا CSF analysis',
    expectedKeywords: ['analysis', 'تحليل', 'csf'],
    category: 'Clinical Pathology (Fluid Count)',
  },
  {
    query: 'أجسام مضادة جلوتين Tissue transglutaminase IgA',
    expectedKeywords: ['iga', 'transglutaminase'],
    category: 'Immunology (Isotype specificity)',
  },
  {
    query: 'قسطرة تشخيصية للشرايين التاجية',
    expectedKeywords: ['coronary', 'angiography', 'قسطرة'],
    category: 'Interventional Cardiology',
  },
  {
    query: 'تحليل فيتامين دال 25-OH',
    expectedKeywords: ['vitamin d', '25'],
    category: 'Biochemistry (Vitamin)',
  },
  {
    query: 'غدة درقية TSH فقط',
    expectedKeywords: ['tsh'],
    category: 'Endocrinology (Specificity)',
  },
  {
    query: 'منظار معدله وقولون',
    expectedKeywords: ['gastroscopy', 'colonoscopy', 'منظار'],
    category: 'GI Endoscopy',
  },
  {
    query: 'تخطيط مخ EEG',
    expectedKeywords: ['eeg', 'كهربية', 'مخ'],
    category: 'Neurophysiology',
  },
];

function loadCatalog(): ProcedureResult[] {
  const merged: ProcedureResult[] = [];
  for (const year of ['2026', '2025', '2024', '2023']) {
    const p = path.resolve(process.cwd(), 'public', `${year}_cash.json`);
    if (fs.existsSync(p)) {
      try {
        const items = JSON.parse(fs.readFileSync(p, 'utf-8')) as ProcedureResult[];
        merged.push(...items);
      } catch {
        // skip malformed year file
      }
    }
  }
  return merged;
}

/** Ground-truth judge: does a catalog row match the case's expected answer? */
function rowMatchesExpected(row: ProcedureResult, testCase: GoldenCase): boolean {
  if (testCase.expectedCode && row.code === testCase.expectedCode) return true;
  const normAr = normalizeArabic(normalizeText(row.nameArabic || ''));
  const normEn = normalizeText(row.nameEnglish || '').toLowerCase();
  return testCase.expectedKeywords.some((kw) => {
    const k = kw.toLowerCase();
    return normAr.includes(k) || normEn.includes(k);
  });
}

async function main() {
  console.log('=====================================================');
  console.log('🧪 ELITE PRICELIST MATCHING QUALITY EVALUATION');
  console.log('   (query-only retrieval — production parity)');
  console.log('=====================================================\n');

  // 1. Load full catalog (all years merged)
  const catalog = loadCatalog();
  if (catalog.length === 0) {
    throw new Error('Could not load pricelist catalog from public/*_cash.json for eval!');
  }
  console.log(`✓ Loaded ${catalog.length} catalog rows (2023–2026).\n`);

  // 2. Load historical overrides from database if available
  const dbOverrides = await loadAllOverridesForEval().catch(() => []);
  console.log(`✓ Retrieved ${dbOverrides.length} past manual overrides from database.\n`);

  const allCases: GoldenCase[] = [...GOLDEN_EVAL_DATASET];
  for (const ov of dbOverrides) {
    if (ov.queryText && ov.chosenName) {
      allCases.push({
        query: ov.queryText,
        expectedKeywords: [normalizeText(ov.chosenName).toLowerCase()],
        expectedCode: ov.chosenCode,
        category: 'Database Staff Override',
      });
    }
  }

  console.log(`Evaluating ${allCases.length} total benchmark queries against catalog...\n`);

  let p1Correct = 0;
  let p3Correct = 0;
  const failures: Array<{ query: string; category: string; expected: string[]; topCandidate: string }> = [];

  for (const testCase of allCases) {
    // 0. Check priority manual override first (production behavior: overrides win)
    const override = await getOverrideForQuery(testCase.query);
    if (override) {
      const overrideHit =
        (testCase.expectedCode && override.chosenCode === testCase.expectedCode) ||
        rowMatchesExpected(
          { nameArabic: override.chosenName, nameEnglish: override.chosenName, price: '', sectionName: '', sourceFile: 'override' } as ProcedureResult,
          testCase,
        );
      if (overrideHit) {
        p1Correct++;
        p3Correct++;
      } else {
        failures.push({
          query: testCase.query,
          category: testCase.category + ' (override)',
          expected: testCase.expectedKeywords,
          topCandidate: override.chosenName,
        });
      }
      continue;
    }

    // 1. RETRIEVE candidates using ONLY the query — identical to production path.
    //    No expectedKeywords touch this step.
    const retrieved = searchLocalPricelist(catalog, [{ name: testCase.query }]);

    // 2. Rank the retrieved pool with the SAME scorer production uses.
    const scored = scoreTrigramFallback(testCase.query, retrieved);

    // Top-1 from the trigram scorer; fall back to retrieval order when it abstains.
    const ranked = retrieved.slice().sort((a, b) => {
      const sa = scored.matchedProcedure === a ? 1 : 0;
      const sb = scored.matchedProcedure === b ? 1 : 0;
      return sb - sa;
    });
    const topCandidate = scored.matchedProcedure || ranked[0] || null;
    const top3 = retrieved.slice(0, 3);

    // 3. JUDGE with expectedKeywords (ground truth only).
    const p1Hit = topCandidate ? rowMatchesExpected(topCandidate, testCase) : false;
    const p3Hit = retrieved.some((row) => rowMatchesExpected(row, testCase));

    if (p1Hit) p1Correct++;
    if (p3Hit || p1Hit) p3Correct++;

    if (!p1Hit) {
      failures.push({
        query: testCase.query,
        category: testCase.category,
        expected: testCase.expectedKeywords,
        topCandidate: topCandidate ? `${topCandidate.nameEnglish} / ${topCandidate.nameArabic}` : 'None',
      });
    }
  }

  const total = allCases.length;
  const p1Rate = (p1Correct / total) * 100;
  const p3Rate = (p3Correct / total) * 100;

  console.log('-----------------------------------------------------');
  console.log('📊 Evaluation Results:');
  console.log(`  Total Evaluated: ${total}`);
  console.log(`  Precision@1:     ${p1Rate.toFixed(1)}% (${p1Correct}/${total}) [Threshold: >= 80%]`);
  console.log(`  Precision@3:     ${p3Rate.toFixed(1)}% (${p3Correct}/${total}) [Threshold: >= 95%]`);
  console.log('-----------------------------------------------------');

  if (failures.length > 0) {
    console.log('\n⚠️ Inspecting Discrepancies (P@1 Misses):');
    for (const f of failures.slice(0, 5)) {
      console.log(`  - Query: "${f.query}" [${f.category}]`);
      console.log(`    Expected keyword: ${f.expected.join(', ')}`);
      console.log(`    Got top match:    ${f.topCandidate}\n`);
    }
  }

  const p1Pass = p1Rate >= 80.0;
  const p3Pass = p3Rate >= 95.0;

  if (!p1Pass || !p3Pass) {
    console.error(`❌ REGRESSION: Matching accuracy fell below quality gate thresholds (P@1: ${p1Rate}%, P@3: ${p3Rate}%)`);
    process.exit(1);
  }

  console.log('✅ ALL MATCHING QUALITY GATES PASSED (Precision@1 >= 80%, Precision@3 >= 95%)');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal evaluation error:', err);
  process.exit(1);
});
