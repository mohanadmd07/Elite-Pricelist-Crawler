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
  let trimmed = query.trim();

  // Strip doctor clinical justification clauses accidentally typed into procedure names
  // e.g. "رسم سمع واتزان حيث انه يعاني من عدم اتزان و دوخة" -> "رسم سمع واتزان"
  trimmed = trimmed.replace(/\s*(?:حيث\s*(?:انه|أنها|أنه|انها)|نظرا\s*(?:لانه|لأنها|لوجود|لأنه)|بسبب|نظرا|لتشخيص)\s+.*$/i, '');
  trimmed = trimmed.replace(/\s*(?:due to|because of|for evaluation of|for suspected)\s+.*$/i, '');

  // Transesophageal Echocardiography alias handling (TEE / T.E.E)
  if (/^(?:t\.?e\.?e\.?)(?:\s*-\s*investigation|\s*-\s*procedure|\s*echocardiography)?$/i.test(trimmed)) {
    return 'Transesophageal Echocardiography (TEE)';
  }
  return trimmed
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
 * Standard Egyptian Hospital Clinical Nomenclature & Synonym Dictionary
 * Bridges differences between doctor requests / HIS terms and official hospital pricelist rows.
 */
export const MEDICAL_SYNONYMS: Record<string, string[]> = {
  // Cardiology / Cath Lab / Interventions
  'pci': ['therapeutic cardiac catheter', 'balloon diltation+stent', 'balloon dilatation', 'قسطرة القلب العلاجية', 'دعامة', 'توسيع بالبالون'],
  'staged pci': ['therapeutic cardiac catheter', 'balloon diltation+stent', 'قسطرة القلب العلاجية', 'دعامة'],
  'primary pci': ['therapeutic cardiac catheter', 'قسطرة القلب العلاجية', 'دعامة'],
  'ptca': ['therapeutic cardiac catheter', 'balloon dilatation', 'قسطرة القلب العلاجية'],
  'coronary angiography': ['diagnostic cardiac catheter', 'قسطرة القلب التشخيصية', 'قسطرة تشخيصية'],
  'cardiac catheter': ['diagnostic cardiac catheter', 'قسطرة القلب التشخيصية', 'قسطرة القلب العلاجية'],
  'قسطرة قلب': ['diagnostic cardiac catheter', 'therapeutic cardiac catheter', 'قسطرة القلب التشخيصية', 'قسطرة القلب العلاجية'],
  'قسطرة تشخيصية': ['diagnostic cardiac catheter', 'قسطرة القلب التشخيصية'],
  'قسطرة علاجية': ['therapeutic cardiac catheter', 'balloon diltation+stent', 'قسطرة القلب العلاجية'],
  'cabg': ['open heart', 'القلب المفتوح'],
  'open heart': ['open heart', 'القلب المفتوح'],
  'قلب مفتوح': ['open heart'],
  'tee': ['transesophageal echocardiography', 'موجات فوق صوتية على القلب عن طريق المريء'],
  'مريء': ['transesophageal echocardiography', 'tee'],
  'tte': ['echocardiography', 'موجات فوق صوتية علي القلب', 'ايكو'],
  'echo': ['echocardiography', 'موجات فوق صوتية علي القلب', 'ايكو'],
  'echocardiography': ['echocardiography', 'موجات فوق صوتية علي القلب', 'ايكو'],
  'ايكو': ['echocardiography', 'echo', 'موجات فوق صوتية علي القلب'],
  'pacemaker': ['single chamber pacemaker', 'dual chamber pacemaker', 'منظم ضربات القلب'],
  'منظم ضربات': ['pacemaker', 'منظم ضربات القلب'],
  'ablation': ['simple ablation', 'cryo ablation', 'دراسة كهروفسيولوجيا القلب والكي'],
  'كهروفسيولوجيا': ['ablation', 'دراسة كهروفسيولوجيا القلب'],

  // Endoscopy / GIT
  'colonoscopy': ['lower git endoscopy', 'منظار قولون', 'منظار القولون'],
  'منظار قولون': ['lower git endoscopy', 'colonoscopy'],
  'gastroscopy': ['upper git endoscopy', 'منظار معدة', 'منظار المعدة'],
  'منظار معدة': ['upper git endoscopy', 'gastroscopy'],
  'ogd': ['upper git endoscopy', 'منظار معدة'],
  'upper endoscopy': ['upper git endoscopy', 'منظار جهاز هضمي علوي'],
  'lower endoscopy': ['lower git endoscopy', 'منظار جهاز هضمي سفلي'],
  'ercp': ['ercp diagnostic', 'ercp with stent', 'منظار تشخيصي للقنوات المرارية', 'منظار قنوات مرارية'],
  'قنوات مرارية': ['ercp', 'منظار قنوات مرارية'],
  'polypectomy': ['removal of duodenal polyps', 'إزالة زوائد بالقولون', 'استئصال زوائد'],
  'زوائد بالقولون': ['removal of duodenal polyps', 'polypectomy'],
  'gastric balloon': ['gastric balloon insertion', 'تركيب بالون معدة'],
  'بالون معدة': ['gastric balloon'],

  // General Surgery / Laparoscopy
  'cholecystectomy': ['استئصال المرارة', 'مرارة بالمنظار', 'gallbladder'],
  'استئصال المرارة': ['cholecystectomy', 'laparoscopic cholecystectomy', 'مرارة'],
  'مرارة': ['cholecystectomy', 'استئصال المرارة'],
  'appendectomy': ['استئصال الزائدة', 'زائدة دودية'],
  'استئصال الزائدة': ['appendectomy', 'زائدة دودية'],
  'زائدة': ['appendectomy', 'استئصال الزائدة'],
  'hernia': ['فتق', 'hernioplasty', 'repair of hernia', 'اصلاح فتق'],
  'hernioplasty': ['hernia', 'فتق', 'اصلاح فتق'],
  'فتق': ['hernia', 'hernioplasty', 'اصلاح فتق'],
  'splenectomy': ['استئصال طحال'],
  'طحال': ['splenectomy', 'استئصال طحال'],
  'thyroidectomy': ['استئصال الغدة الدرقية', 'غدة درقية'],
  'غدة درقية': ['thyroidectomy', 'استئصال الغدة الدرقية'],
  'mastectomy': ['استئصال ثدي', 'أورام الثدي'],
  'fistula': ['ناسور', 'استئصال ناسور'],
  'ناسور': ['fistula', 'استئصال ناسور'],
  'fissure': ['شرخ', 'علاج شرخ شرجي'],
  'شرخ': ['fissure'],
  'hemorrhoids': ['بواسير', 'استئصال بواسير'],
  'بواسير': ['hemorrhoids'],

  // Neurology / Neurophysiology
  'eeg': ['electroencephalography', 'رسم مخ', 'رسم المخ'],
  'electroencephalography': ['eeg', 'رسم مخ'],
  'رسم مخ': ['eeg', 'electroencephalography', 'رسم المخ'],
  'emg': ['electromyography', 'رسم عضلات'],
  'رسم عضلات': ['emg', 'electromyography'],
  'ncs': ['nerve conduction', 'سرعة توصيل الأعصاب'],
  'رسم اعصاب': ['ncs', 'nerve conduction', 'سرعة توصيل الأعصاب'],

  // Urology
  'cystoscopy': ['منظار مثانة'],
  'منظار مثانة': ['cystoscopy'],
  'turp': ['استئصال بروستاتا بالمنظار', 'بروستاتا'],
  'بروستاتا': ['turp', 'prostatectomy', 'استئصال بروستاتا'],
  'ureteroscopy': ['منظار حالب', 'تفتيت حصوة بالليزر'],
  'منظار حالب': ['ureteroscopy'],
  'dj stent': ['دعامة حالب'],
  'دعامة حالب': ['dj stent'],

  // Radiology
  'ct': ['اشعة مقطعية', 'أشعة مقطعية', 'computed tomography'],
  'مقطعية': ['ct', 'computed tomography', 'أشعة مقطعية'],
  'mri': ['رنين مغناطيسي', 'أشعة الرنين المغناطيسي'],
  'رنين': ['mri', 'magnetic resonance imaging'],
  'doppler': ['دوبلر', 'دوبلكس ملون'],
  'دوبلر': ['doppler', 'duplex'],
  'sonar': ['موجات صوتية', 'سونار'],
  'سونار': ['ultrasound', 'sonar', 'موجات صوتية'],

  // Dialysis / ICU / Procedures
  'hd session': ['غسيل كلوي', 'جلسة غسيل كلوي', 'dialysis'],
  'hemodialysis': ['غسيل كلوي', 'جلسة غسيل كلوي', 'dialysis'],
  'غسيل كلوي': ['hemodialysis', 'hd session', 'dialysis'],
  'pig tail': ['تركيب بيج تيل', 'pig tail insertion'],
  'بيج تيل': ['pig tail insertion', 'تركيب بيج تيل'],
  'tracheostomy': ['شق حنجري', 'تركيب أنبوب حنجري'],
  'audiogram': ['computerized audiogram', 'رسم سمع بالكمبيوتر'],
  'audiometry': ['computerized audiogram', 'رسم سمع'],
  'رسم سمع': ['computerized audiogram', 'audiogram'],
  'tapping': ['بزل', 'paracentesis'],
  'بزل': ['tapping', 'paracentesis'],
};

/**
 * Expands a medical query with its clinical aliases and synonyms
 */
export function expandMedicalSynonyms(input: string): string[] {
  if (!input) return [];
  const cleanQ = cleanHisProcedureQuery(input);
  const norm = normalizeText(cleanQ);
  const normAr = normalizeArabic(cleanQ);
  const results = new Set<string>([cleanQ, norm, normAr]);

  for (const [key, syns] of Object.entries(MEDICAL_SYNONYMS)) {
    const isEnglishKey = /^[a-z0-9\s]+$/i.test(key);
    let matched = false;

    if (isEnglishKey && key.length <= 4) {
      // Short acronyms (e.g. 'ct', 'mri', 'pci', 'eeg', 'ecg') require word boundary to avoid matching inside words like 'calprotectin'
      matched = new RegExp(`\\b${key}\\b`, 'i').test(cleanQ);
    } else {
      matched = norm.includes(key) || normAr.includes(key);
    }

    if (matched) {
      syns.forEach((s) => results.add(s));
    }
  }
  return Array.from(results).filter(Boolean);
}

/**
 * Detects if query and candidate have conflicting immunoglobulin isotypes (e.g. IgA vs IgG vs IgM vs IgE).
 * Diagnostic antibody laboratory tests are strictly isotype-specific and must never cross-match.
 */
export function hasAntibodyConflict(query: string, candidate: string): boolean {
  if (!query || !candidate) return false;
  const isotypes = ['iga', 'igg', 'igm', 'ige'];
  const qLower = query.toLowerCase();
  const cLower = candidate.toLowerCase();

  const qIso = isotypes.filter((iso) => new RegExp(`\\b${iso}\\b`, 'i').test(qLower));
  const cIso = isotypes.filter((iso) => new RegExp(`\\b${iso}\\b`, 'i').test(cLower));

  if (qIso.length > 0 && cIso.length > 0) {
    return !qIso.some((iso) => cIso.includes(iso));
  }
  return false;
}

/**
 * Strict laboratory and clinical modality conflict detector.
 * Prevents distinct clinical investigations from collapsing onto generic body fluid analyses:
 * - Microbiology Culture vs Chemistry & Cell Count
 * - Gram Stain / Acid-Fast Stain vs Chemistry Analysis
 * - Cytology Fluid Examination vs Chemistry Analysis
 * - Molecular PCR Panels (Biofire / Multiplex) vs Chemistry Analysis / Culture
 * - Specific Biochemical Analytes (Lactate, ADA, Pyruvate) vs General Chemistry & Cell Count
 */
export function hasLabInvestigationConflict(query: string, candidate: string): boolean {
  if (!query || !candidate) return false;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();

  // 1. Culture vs Non-Culture
  const isQCulture = /\bculture\b|مزرع[ةه]/i.test(q);
  const isCCulture = /\bculture\b|مزرع[ةه]/i.test(c);
  if (isQCulture !== isCCulture) {
    if (isQCulture && (/\banalysis\b|chemistry|cell count|تحليل كيمياء/i.test(c))) return true;
    if (isCCulture && (/\banalysis\b|chemistry|cell count|تحليل كيمياء/i.test(q))) return true;
  }

  // 2. Gram Stain / Stain vs Non-Stain
  const isQStain = /\bstain\b|صبغ[ةه]/i.test(q);
  const isCStain = /\bstain\b|صبغ[ةه]/i.test(c);
  if (isQStain !== isCStain) {
    if (isQStain && (/\banalysis\b|chemistry|cell count|culture/i.test(c))) return true;
    if (isCStain && (/\banalysis\b|chemistry|cell count|culture/i.test(q))) return true;
  }

  // 3. Cytology vs Non-Cytology
  const isQCytology = /\bcytology\b|سيتولوج/i.test(q);
  const isCCytology = /\bcytology\b|سيتولوج/i.test(c);
  if (isQCytology !== isCCytology) {
    if (isQCytology && (/\banalysis\b|chemistry|cell count|culture|stain/i.test(c))) return true;
    if (isCCytology && (/\banalysis\b|chemistry|cell count|culture|stain/i.test(q))) return true;
  }

  // 4. PCR / Molecular Panel vs Routine Chemistry Analysis / Culture
  const isQPCR = /\bpcr\b|filmarray|biofire|molecular/i.test(q);
  const isCPCR = /\bpcr\b|filmarray|biofire|molecular/i.test(c);
  if (isQPCR !== isCPCR) {
    if (isQPCR && (/\banalysis\b|chemistry|cell count|culture|stain|cytology/i.test(c))) return true;
    if (isCPCR && (/\banalysis\b|chemistry|cell count|culture|stain|cytology/i.test(q))) return true;
  }

  // 5. Specific CSF Analyte (Lactate, ADA, Chloride, etc.) vs General Fluid Analysis
  const isQLactate = /\blactate\b|لاكتات/i.test(q);
  const isCLactate = /\blactate\b|لاكتات/i.test(c);
  if (isQLactate !== isCLactate) {
    if (isQLactate && (/chemistry & cell count|cell count/i.test(c))) return true;
    if (isCLactate && (/chemistry & cell count|cell count/i.test(q))) return true;
  }

  // 6b. Single-site modality sessions (magnetic / laser / ultrasound ... "one site") vs
  //     physiotherapy chest-and-limbs care sessions
  const oneSiteRe = /(?:one|two|three|\d+)\s*sites?|مكان\s*واحد|مكانين|ثلاث[ةه]?\s*اماكن|مغناطيس|magnetic|ليزر|laser/i;
  const physioQueryRe = /physio|physical therapy|علاج\s*طبيع|عنايه\s*صدر|عناية\s*صدر|اطراف|أطراف|limbs/i;
  if (oneSiteRe.test(c) && !oneSiteRe.test(q) && physioQueryRe.test(q) && !/ليزر|laser|مغناطيس|magnetic/i.test(q)) return true;

  // 6. Laser session vs Physiotherapy / chest-and-limbs care session
  const isQLaser = /\blaser\b|ليزر/i.test(q);
  const isCLaser = /\blaser\b|ليزر/i.test(c);
  if (isQLaser !== isCLaser) {
    const physioRe = /physio|physical therapy|علاج\s*طبيع|عنايه\s*صدر|عناية\s*صدر|chest\s*\+|اطراف|أطراف|limbs?/i;
    if (isCLaser && physioRe.test(q)) return true;
    if (isQLaser && physioRe.test(c)) return true;
  }

  return false;
}

/**
 * Identifies hospital accommodation, bed, and generic administrative fees
 * to prevent them from misidentifying as medical procedures.
 */
export function isAccommodationOrGenericFee(name: string): boolean {
  if (!name) return false;
  const n = normalizeText(name);
  const a = normalizeArabic(name);
  return (
    /\b(bed|room|accommodation|stay|icu day|ccu day|nursing|care unit)\b/i.test(n) ||
    /إقامة|اقامة|سرير|عناية مركزة|رعاية مركزة|رسم دخول|رسوم فتح ملف|كشف طوارئ|استشارة|مرور طبيب/i.test(a)
  );
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


