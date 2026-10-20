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
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // Strip Tashkeel / diacritics / tatweel
    .replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) & 0xf)) // Arabic-Indic digits -> ASCII
    .replace(/[أإآا]/g, 'ا')
    .replace(/[ىيی]/g, 'ي') // Alef-maqsura + Persian yeh
    .replace(/[كک]/g, 'ك') // Persian keheh -> Arabic kaf
    .replace(/[ةهھۀ]/g, 'ه')
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
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) & 0xf))
    .replace(/[أإآا]/g, 'ا')
    .replace(/[ىيی]/g, 'ي')
    .replace(/[كک]/g, 'ك')
    .replace(/[ةهھۀ]/g, 'ه')
    .replace(/[ئؤ]/g, 'ء')
    .replace(/[^a-zA-Z0-9\u0621-\u064A\s]/g, ' ')
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

/**
 * Strips "Main", "شركة", "شركه", and surrounding noise from contractor names.
 * Ensures clean canonical display across emails, tables, WhatsApp messages, and drafts.
 */
export function cleanContractorName(str: string): string {
  if (!str) return '';
  let cleaned = str
    .replace(/<[^>]+>/g, ' ') // Strip HTML tags
    .replace(/^Name:\s*/i, '')
    .replace(/^Contractor(?:\s*Name)?\s*[:\s]*/i, '');

  // Strip English "Main" anywhere (case-insensitive, whole word or enclosed in brackets)
  cleaned = cleaned.replace(/\(?\bmain\b\)?/gi, ' ');

  // Strip Arabic "شركة", "شركه", "الشركة", "الشركه"
  cleaned = cleaned.replace(/(?:^|\s+)(?:ال)?شرك[ةه](?=\s+|$)/gu, ' ');

  // Strip prefix "Cash " or "كاش " if followed by Arabic letters (e.g. "Cash نقابة المهندسين" -> "نقابة المهندسين")
  cleaned = cleaned.replace(/^(?:Cash|كاش)\s+(?=[\u0600-\u06FF])/i, '');

  // Strip extraneous symbols/dividers
  cleaned = cleaned.replace(/[-–—:_]+/g, ' ');

  // Standardize MT prefix like MTالمرضي الكاش -> المرضي الكاش MT
  if (/^MT[\u0600-\u06FF]/i.test(cleaned.trim())) {
    cleaned = cleaned.trim().replace(/^MT\s*/i, '') + ' MT';
  }

  // Collapse multiple spaces and trim
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // If the string just equals "Contractor" or "تعاقد" or empty, return empty
  if (/^(?:Contractor|تعاقد|شركة|شركه)$/i.test(cleaned)) {
    return '';
  }

  return cleaned;
}

/**
 * Strips mobile email client boilerplate footers and signatures (e.g. "Sent from Outlook for Android",
 * "Get Outlook for iOS", "احصل على Outlook", "Sent from my iPhone", etc.) from replies and snippets.
 */
export function stripSentFromSignatures(input: string): string {
  if (!input) return '';
  return input
    .replace(/(?:Sent\s+from|Sent\s+with|Send\s+from)\s+[^\r\n.<>]+/gi, ' ')
    .replace(/Get\s+Outlook(?:\s+for\s+[a-zA-Z]+)?/gi, ' ')
    .replace(/(?:تم\s+الإرسال\s+من|تم\s+الارسال\s+من|أرسلت\s+من|ارسلت\s+من)\s+[^\r\n.<>]+/gi, ' ')
    .replace(/(?:احصل|أحصل)\s+على\s+[^\r\n.<>]+/gi, ' ')
    .replace(/From:\s*[^<]+Sent:\s*[^<]+To:[^\r\n.<>]*/gi, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cleans HIS laboratory/radiology service suffixes such as "- Investigation",
 * and normalizes clinical variations (e.g. "citrulinated" -> "citrullinated", "(d.s)" -> "(d's)")
 * so requested items match official pricelist names accurately.
 */
export function cleanHisProcedureQuery(query: string): string {
  if (!query) return '';
  const trimmed = query.trim();
  // Transesophageal Echocardiography alias handling (TEE / T.E.E)
  if (/^(?:t\.?e\.?e\.?)(?:\s*-\s*investigation|\s*-\s*procedure|\s*echocardiography)?$/i.test(trimmed)) {
    return 'Transesophageal Echocardiography (TEE)';
  }
  return query
    .replace(/\s*-\s*investigation\b/gi, '')
    .replace(/\binvestigation\b/gi, '')
    .replace(/\s*-\s*procedure\b/gi, '')
    .replace(/\s*-\s*service\b/gi, '')
    .replace(/\s*-\s*profile\b/gi, '')
    .replace(/\b(citrulinated)\b/gi, 'citrullinated')
    .replace(/\(d\.s\)/gi, "(d's)")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts the true timestamp of the original HIS approval request from an email body or quoted thread.
 * Looks for HIS notifications headers ("From: HIS Notifications ... Sent: <date>") and
 * in-card timestamps ("Date: MM/DD/YYYY, HH:MM:SS AM/PM"), preventing replies from artificially shifting timestamps.
 */
export function extractOriginalRequestDate(html: string, text?: string): Date | null {
  const combined = (text || '') + ' ' + (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // 1. Quoted header: From: HIS Notifications ... Sent: <date> (To:|Subject:)
  const hisHeaderMatch = combined.match(/From:\s*HIS\s*Notifications\s*Sent:\s*(.*?)\s*(?:To:|Subject:)/i);
  if (hisHeaderMatch) {
    const d = new Date(hisHeaderMatch[1].trim());
    if (!isNaN(d.getTime())) return d;
  }

  // 2. HIS card: Date: MM/DD/YYYY, HH:MM:SS AM/PM
  const dateMatch = combined.match(/Date:\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4},?\s*[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\s*(?:AM|PM)?)/i);
  if (dateMatch) {
    const d = new Date(dateMatch[1].trim());
    if (!isNaN(d.getTime())) return d;
  }

  // 3. Fallback: Admission Date
  const admMatch = combined.match(/Admission(?:\s*Date)?\s*[:\s]*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4},?\s*[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\s*(?:AM|PM)?)/i);
  if (admMatch) {
    const d = new Date(admMatch[1].trim());
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}


