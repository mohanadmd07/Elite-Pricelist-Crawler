/**
 * Unified Arabic & English Medical Nomenclature Normalizer
 * Resolves edge-cases in hospital procedure matching, diacritics, and corporate aliases.
 */

/**
 * Standardizes Arabic characters across Alef, Yaa, Haa/Taa Marbuta, Hamzas, and diacritics.
 */
export function normalizeArabic(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '') // Strip Tashkeel / diacritics
    .replace(/[أإآا]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/[ةه]/g, 'ه')
    .replace(/[ئؤ]/g, 'ء')
    .replace(/[^a-zA-Z0-9\u0621-\u064A\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes English nomenclature, expanding common dots in medical abbreviations (e.g. "E.E.G." -> "eeg")
 * and stripping superfluous descriptive suffixes ("- Investigation", "Procedure", etc.)
 */
export function normalizeText(str: string): string {
  if (!str) return '';
  let normalized = str.toLowerCase();

  // Merge dotted abbreviations like "E.E.G." or "E. C. G." -> "eeg" / "ecg"
  normalized = normalized.replace(/\b([a-z])\s*\.\s*/g, '$1');

  // Strip common suffixes often appended to procedures in billing lists
  normalized = normalized
    .replace(/\s*[-/,]\s*(investigations?|procedures?|tests?|testing|panels?|profiles?|screens?|screening|analysis|packages?|scans?|counts?)\b/g, '')
    .replace(/\s+\b(investigations?|procedures?|tests?|testing|panels?|profiles?|screens?|screening|analysis|packages?|scans?|counts?)$/g, '');

  return normalized
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآا]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/[ةه]/g, 'ه')
    .replace(/[ئؤ]/g, 'ء')
    .replace(/\./g, '')
    .replace(/[^a-zA-Z0-9\u0621-\u064A\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strips leading numbering (e.g., "1- ", "02. ") from extracted procedure labels
 */
export function cleanNamePrefix(name: string): string {
  if (!name) return '';
  return name.trim().replace(/^\d+\s*[-.)\s]+\s*/, '');
}

/**
 * Normalizes company and contractor names for sales representative resolution
 */
export function getBaseNameForSales(str: string): string {
  if (!str) return '';
  let name = str.toLowerCase();

  // Corporate brand substitutions
  name = name.replace(/\bethydco\b/gi, 'ايثدكو');
  name = name.replace(/\beprom\b/gi, 'ايبروم');
  name = name.replace(/\bamoc\b/gi, 'اموك');
  name = name.replace(/\baxa\b/gi, 'اكسا');
  name = name.replace(/\bwebco\b/gi, 'ويبكو');
  name = name.replace(/\bwepco\b/gi, 'ويبكو');
  name = name.replace(/\bel ahly\b/gi, 'الاهلي');
  name = name.replace(/\bnext care\b/gi, 'نكست كير');

  const wordsToRemove = [
    'شركه', 'شركة', 'هيئة', 'هيئه', 'نقابه', 'نقابة', 'نادى', 'نادي', 'جمعية', 'جمعيه',
    'بترول', 'للبترول', 'الاطباء', 'اطباء', 'المهندسين', 'مهندسين', 'الزراعيه', 'الزراعية',
    'الماسية', 'الماسيه', 'الخدمات', 'الطبية', 'الطبيه'
  ];

  for (const word of wordsToRemove) {
    name = name.replace(new RegExp(`\\b${word}\\b`, 'g'), '');
    name = name.replace(new RegExp(`${word}`, 'g'), '');
  }

  return normalizeArabic(name).replace(/\s+/g, '');
}
