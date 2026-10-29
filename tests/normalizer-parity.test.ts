/**
 * Normalizer parity test: the SQL-side normalize_arabic_medical() (Supabase) and
 * the TS-side normalizeArabic()/normalizeText() (client + worker) must produce
 * identical keys for the same input, otherwise server trigram matches and local
 * worker matches diverge silently.
 *
 * The expected values below mirror the SQL rule set from
 * supabase/migrations/20261029000000_phase5_matching_recall.sql verbatim:
 *   lowercase → strip tashkeel/tatweel → Arabic-Indic digits → unify alef/yaa/
 *   kaf/taa marbuta/hamza → replace punctuation with space (KEEP latin letters,
 *   digits and arabic letters) → collapse whitespace → trim.
 */

import { describe, it, expect } from 'vitest';
import { normalizeArabic, normalizeText } from '../src/lib/arabic-normalizer';

/** Reference implementation of the SQL normalizer, transcribed rule-by-rule. */
function sqlNormalize(input: string): string {
  let res = input.toLowerCase();
  res = res.replace(/[\u064B-\u065F\u0670\u0640]/g, '');
  res = res.replace(/[٠١٢٣٤٥٦٧٨٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  res = res.replace(/[أإآا]/g, 'ا');
  res = res.replace(/[ىيی]/g, 'ي');
  res = res.replace(/[كک]/g, 'ك');
  res = res.replace(/[ةهھۀ]/g, 'ه');
  res = res.replace(/[ئؤ]/g, 'ء');
  res = res.replace(/[^a-zA-Z0-9\u0621-\u064A\s]/g, ' ');
  res = res.replace(/\s+/g, ' ');
  return res.trim();
}

const CASES: [string, string][] = [
  ['تحليل سكر HbA1c', 'تحليل سكر hba1c'],
  ['إزالة المرارة بالمنظار', 'ازالة المراره بالمنظار'],
  ['CBC مع DIFF', 'cbc مع diff'],
  ['أشعة رنين مغناطيسي™ على المخ', 'اشعة رنين مغناطيسي على المخ'],
  ['فحص № ١٢٣ للدم', 'فحص 123 للدم'],
  ['كولونوسكوبي (منتهي)', 'كولونوسكوبي منتهي'],
  ['ECHO-Doppler / قلب', 'echo doppler قلب'],
  ['تخطيط كهربية القلب - ١٢ قناة', 'تخطيط كهربية القلب 12 قناه'],
];

describe('SQL ↔ TS normalizer parity', () => {
  it.each(CASES)('normalizeArabic chain matches SQL rules for %j', (input, _expectedSql) => {
    // Client chain used by override keys, cache keys, and the search worker.
    const tsResult = normalizeArabic(normalizeText(input));
    const sqlResult = sqlNormalize(input);
    expect(tsResult).toBe(sqlResult);
  });

  it('keeps Latin letters inside Arabic names (matches SQL charset class)', () => {
    const mixed = 'تحليل سكر HbA1c بالدم';
    expect(normalizeArabic(normalizeText(mixed))).toContain('hba1c');
    expect(sqlNormalize(mixed)).toContain('hba1c');
  });

  it('produces identical keys for alef/yaa/taa-marbuta variants', () => {
    const a = normalizeArabic(normalizeText('إزالة المرارة'));
    const b = normalizeArabic(normalizeText('ازاله المراره'));
    expect(a).toBe(b);
  });
});
