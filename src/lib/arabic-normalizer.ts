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
    .replace(/(^|[^\u0600-\u06FF])علئ(?=[^\u0600-\u06FF]|$)/g, '$1علي') // Typo: علئ -> علي
    .replace(/[ئؤ]/g, 'ء')
    .replace(/[^a-zA-Z0-9\u0621-\u064A\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes common Greek and Cyrillic OCR/extraction homoglyphs to Latin ASCII equivalents.
 * Examples: Greek Rho 'Ρ' -> 'P', Tau 'Τ' -> 'T', Eta 'Η' -> 'H', Cyrillic 'С' -> 'C', 'Н' -> 'H'.
 */
const HOMOGLYPH_MAP: Record<string, string> = {
  // Greek
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0397': 'H', '\u0399': 'I',
  '\u039a': 'K', '\u039c': 'M', '\u039d': 'N', '\u039f': 'O', '\u03a1': 'P',
  '\u03a4': 'T', '\u03a7': 'X', '\u03b1': 'a', '\u03b2': 'b', '\u03b5': 'e',
  '\u03b7': 'h', '\u03b9': 'i', '\u03ba': 'k', '\u03bc': 'm', '\u03bd': 'n',
  '\u03bf': 'o', '\u03c1': 'p', '\u03c4': 't', '\u03c7': 'x',
  // Cyrillic
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041d': 'H', '\u041c': 'M',
  '\u041e': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0406': 'I',
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c',
  '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u043d': 'h', '\u0433': 'r',
};

export function normalizeHomoglyphs(str: string): string {
  if (!str) return '';
  return str.replace(/[\u0391-\u03c7\u0400-\u045f]/g, (ch) => HOMOGLYPH_MAP[ch] || ch);
}

/**
 * Normalizes English nomenclature, expanding common dots in medical abbreviations (e.g. "E.E.G." -> "eeg")
 * and stripping superfluous descriptive suffixes ("- Investigation", "Procedure", etc.)
 */
export function normalizeText(str: string): string {
  if (!str) return '';
  let normalized = normalizeHomoglyphs(str).toLowerCase();

  // Merge dotted abbreviations like "E.E.G." or "E. C. G." -> "eeg" / "ecg"
  normalized = normalized.replace(/\b([a-z])\s*\.\s*/g, '$1');

  // Fold common split / hyphenated compound medical terms
  normalized = normalized
    .replace(/\bporta\s*[- ]\s*cath\b/g, 'portacath')
    .replace(/\bport\s*[- ]\s*a\s*[- ]\s*cath\b/g, 'portacath')
    .replace(/\bpig\s*[- ]\s*tail\b/g, 'pigtail')
    .replace(/\btrue?\s*[- ]\s*cut\b/g, 'trucut')
    .replace(/\bintercostal\s*tube\b/g, 'intercostal tube');

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
  let trimmed = normalizeHomoglyphs(query).trim();
  trimmed = trimmed.replace(/\bعلئ\b/g, 'علي');

  // Strip doctor clinical justification clauses preamble accidentally typed into procedure names
  // e.g. "المريضة تعاني من ارتفاع في درجة الحرارة و تحتاج الي مد فترة حجزها..." -> "مد فترة حجزها..."
  trimmed = trimmed.replace(
    /^(?:patient\s+(?:had|has|was|is|suffering\s+from)?\s+).+?\s+(?:and\s+(?:is\s+)?on|and\s+needs|and\s+requires|needs|requires|scheduled\s+for|planned\s+for)\s+/is,
    ''
  );
  trimmed = trimmed.replace(
    /^(?:المريض|المريضة|المريضه|الحالة|الحاله|الطفل|الطفلة|الطفله)\s+(?:يعاني|تعاني|يعانى|تعانى)\s+من\s+.*?(?:و\s*)?(?:يحتاج|تحتاج|نحتاج|بحاجة|بحاجه)\s+(?:الى|الي|لـ?)?\s*(?:عمل|إجراء|اجراء)?\s*/is,
    ''
  );
  trimmed = trimmed.replace(
    /^(?:المريض|المريضة|المريضه|الحالة|الحاله|الطفل|الطفلة|الطفله)\s+(?:يعاني|تعاني|يعانى|تعانى)\s+من\s+[^و]+و\s*(?:يحتاج|تحتاج|نحتاج)?\s*(?:الى|الي|لـ?)?\s*/is,
    ''
  );
  trimmed = trimmed.replace(
    /^(?:المريض|المريضة|المريضه|الحالة|الحاله|الطفل|الطفلة|الطفله)\s+(?:بحاجة|بحاجه|يحتاج|تحتاج)\s+(?:الى|الي|لـ?)\s+(?:عمل|إجراء|اجراء)?\s*/is,
    ''
  );
  trimmed = trimmed.replace(
    /^(?:برجاء|يرجى|يرجي|نرجو|نرجوا|مطلوب|المطلوب|نوصي|نوصى|اوصى|اوصي|أوصى|أوصي|تم\s+طلب|وتم\s+طلب)\s+(?:من\s+سيادتكم\s+)?(?:الموافقة|الموافقه|موافقة|موافقه)?\s*(?:على|علي)?\s*(?:عمل|إجراء|اجراء|سحب)?\s*/is,
    ''
  );
  trimmed = trimmed.replace(/^(?:يحتاج|تحتاج|نحتاج)\s+(?:الى|الي|لـ?)\s+(?:عمل|إجراء|اجراء)?\s*/is, '');
  trimmed = trimmed.replace(/^(?:بحاجة|بحاجه)\s+(?:الى|الي|لـ?)\s+(?:عمل|إجراء|اجراء|اجراءات)?\s*/is, '');

  // Strip trailing clinical justification / indications
  // e.g. "لانها تعاني من صداع شديد مع تاريخ مرضي بالجلطات"
  trimmed = trimmed.replace(
    /\s*(?:لانه|لأنه|لانها|لأنها|بسبب|نظرا|نظراً|مع\s+تاريخ\s+مرضي|لتاريخ\s+مرضي|حيث\s*(?:انه|أنه|انها|أنها)|لاشتباه|اشتباه|لوجود|لحالة|لحاله|لتشخيص|لتقييم|لمتابعة|لمتابعه|لحين)\s+.*$/is,
    ''
  );
  trimmed = trimmed.replace(/\s*(?:due to|because of|for evaluation of|for suspected|to rule out|suspected)\s+.*$/is, '');

  // If query contains embedded English procedure acronym or phrase alongside Arabic words, extract it
  const engAcronymMatch = trimmed.match(/\b([A-Z]{2,6}(?:\s+[A-Za-z0-9()/-]+)?)\b/);
  if (engAcronymMatch && engAcronymMatch[1]) {
    const candidate = engAcronymMatch[1].trim();
    const lower = candidate.toLowerCase();
    if (
      !['patient', 'doctor', 'inpatient', 'hospital', 'contractor', 'admission', 'bed', 'zone', 'mrn'].includes(lower)
    ) {
      const araLetters = (trimmed.match(/[\u0600-\u06FF]/g) || []).length;
      if (araLetters > 0) {
        trimmed = candidate;
      }
    }
  }

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
    .replace(/\bsessions\b/gi, 'session')
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
  'cxr': ['x - ray chest', 'x-ray chest', 'chest x-ray', 'أشعة علي الصدر'],
  'kub': ['x - ray abdomen', 'urography', 'أشعة علي البطن'],
  'ctpa': ['ct pulmonary angiography', 'تصوير الشريان الرئوي بالأشعة المقطعية'],
  'mrcp': ['magnetic resonance cholangiopancreatography', 'أشعة رنين مغناطيسي علي القنوات المرارية'],
  'triphasic': ['triphasic ct', 'ct liver triphasic', 'أشعة مقطعية حلزونية علي شرايين الكبد', 'ترايفازيك'],
  'ترايفازيك': ['triphasic ct', 'ct liver triphasic', 'أشعة مقطعية حلزونية علي شرايين الكبد'],
  'hsg': ['hysterosalpingography', 'اشعة بالصبغة على الرحم والانابيب'],
  'ivu': ['intravenous pyelogram', 'اشعة بالصبغة على المسالك البولية'],
  'ivp': ['intravenous pyelogram', 'اشعة بالصبغة على المسالك البولية'],
  'bmft': ['barium meal follow through', 'اشعة باريوم على الامعاء الدقيقة'],
  'barium swallow': ['barium swallow', 'اشعة بالباريوم على المريء'],
  'barium enema': ['barium enema', 'حقنة باريوم شرجية', 'اشعة بالباريوم على القولون'],
  'carotid doppler': ['doppler carotid', 'دوبلر على شرايين الرقبة'],
  'dvt': ['venous doppler lower extremity', 'دوبلر اوردة الساقين'],
  'bone scan': ['bone scan', 'مسح ذري على العظام'],
  'مسح ذري': ['bone scan', 'thyroid scan', 'pet-ct'],

  // Ultrasound & Doppler colloquial Arabic queries
  'سونار بطن وحوض': ['us abdomen and pelvis', 'موجات فوق صوتية علي البطن والحوض', 'موجات فوق صوتية على البطن والحوض', 'سونار بطن و حوض'],
  'سونار بطن': ['us abdomen', 'موجات فوق صوتية علي البطن', 'موجات فوق صوتية على البطن'],
  'سونار حوض': ['us pelvis', 'موجات فوق صوتية علي الحوض', 'موجات فوق صوتية على الحوض'],
  'دوبلر اوردة الساقين': ['doppler venous system both lower limbs', 'دوبلر علي أوردة الأطراف السفلي', 'دوبلر اوردة الطرفين السفليين'],
  'دوبلر شرايين الساقين': ['doppler arterial system both lower limbs', 'دوبلر علي شرايين الأطراف السفلي', 'دوبلر شرايين الطرفين السفليين'],
  'تركيب بورت كاث': ['porta cath insertion', 'تركيب جهاز بورت كاث'],
  'رفع بورت كاث': ['porta cath removal', 'رفع بورت كاث'],

  // Dialysis / ICU / Interventions / Acute (Batch 1)
  'hd session': ['غسيل كلوي', 'جلسة غسيل كلوي', 'dialysis'],
  'hemodialysis': ['غسيل كلوي', 'جلسة غسيل كلوي', 'dialysis'],
  'غسيل كلوي': ['hemodialysis', 'hd session', 'dialysis'],
  'pig tail': ['تركيب بيج تيل', 'pig tail catheter', 'pig tail insertion'],
  'بيج تيل': ['pig tail insertion', 'pig tail catheter', 'تركيب بيج تيل'],
  'port-a-cath': ['port-a-cath', 'porta cath', 'porta cath insertion', 'chemoport', 'tivad', 'جهاز علاج كيماوي', 'بورت كاث'],
  'portacath': ['port-a-cath', 'porta cath', 'porta cath insertion', 'chemoport', 'tivad', 'جهاز علاج كيماوي', 'بورت كاث'],
  'بورت كاث': ['port-a-cath', 'porta cath', 'porta cath insertion', 'chemoport', 'جهاز علاج كيماوي'],
  'بورتاكات': ['port-a-cath', 'porta cath', 'porta cath insertion', 'chemoport'],
  'evbl': ['esophageal varices band ligation', 'ربط دوالي المريء', 'ربط دوالي بالمنظار'],
  'ربط دوالي': ['esophageal varices band ligation', 'evbl', 'ربط دوالي المريء'],
  'pcn': ['percutaneous nephrostomy', 'بذل كلوي بالاشعة التداخلية'],
  'tru-cut': ['true cut biopsy', 'u/s guided true cut biopsy', 'عينة تروكت'],
  'تروكت': ['true cut biopsy', 'u/s guided true cut biopsy'],
  'tracheostomy': ['شق حنجري', 'تركيب أنبوب حنجري'],
  'audiogram': ['computerized audiogram', 'رسم سمع بالكمبيوتر'],
  'audiometry': ['computerized audiogram', 'رسم سمع'],
  'رسم سمع': ['computerized audiogram', 'audiogram'],
  'tapping': ['بزل', 'paracentesis'],
  'بزل': ['tapping', 'paracentesis'],

  // Surgical Procedures & Bedside Care (Batch 3)
  'lac': ['above elbow cast', 'جبس فوق الكوع'],
  'sac': ['below elbow cast', 'جبس تحت الكوع'],
  'llc': ['above knee cast', 'جبس فوق الركبة'],
  'slc': ['below knee cast', 'جبس تحت الركبة'],
  'جبس': ['cast', 'above elbow cast', 'below elbow cast', 'above knee cast', 'below knee cast'],
  'جبيرة': ['slab', 'posterior slab', 'جبيرة خلفية'],
  'رد كسر': ['fracture reduction', 'رد كسر بسيط'],
  'رد خلع': ['dislocation reduction', 'رد خلع مفصل'],
  'حقن مفاصل': ['intra-articular injection', 'حقن موضعي عظام مفاصل'],
  'ett': ['endo tracheal intubation', 'endotracheal intubation', 'أنبوبة حنجرية'],
  'intubation': ['endo tracheal intubation', 'تركيب انبوبة حنجرية'],
  'انبوبة حنجرية': ['endo tracheal intubation', 'تركيب انبوبة بالقصبة الهوائية'],
  'cvp': ['cvp catheter insertion', 'تركيب قسطرة وريد مركزي'],
  'قسطرة وريدية مركزية': ['cvp catheter insertion', 'تركيب قسطرة وريد مركزي'],
  'arterial line': ['arterial line insertion', 'تركيب قسطرة شريانية'],
  'قسطرة شريانية': ['arterial line insertion', 'تركيب قسطرة شريانية'],
  'chest tube': ['insertion of intercostal tube', 'تركيب أنبوبة صدرية'],
  'أنبوبة صدرية': ['insertion of intercostal tube', 'تركيب أنبوبة صدرية'],
  'lumbar puncture': ['c.s.f tapping', 'بذل نخاعي', 'بذل السائل السحائي'],
  'بذل نخاعي': ['c.s.f tapping', 'lumbar puncture', 'بذل السائل السحائي'],
  'paracentesis': ['بذل بطن', 'بذل تجمع سائل في البطن', 'paracentesis'],
  'بذل بطن': ['paracentesis', 'بذل تجمع سائل في البطن'],
  'pericardiocentesis': ['بذل تامور', 'بذل من تامور القلب'],
  'غيار جروح': ['wound dressing', 'غيار علي جرح', 'wound cleaning'],
  'فك غرز': ['stitch removal', 'removal of surgical stitches', 'فك غرز جراحية'],
  'غرز جراحية': ['surgical stitches', 'suturing', 'خياطة جروح'],
  'خياطة جروح': ['surgical stitches', 'suturing', 'خياطة جروح'],
  'قسطرة بولية': ['insertion of urinary catheter', 'تركيب قسطرة بولية'],
  'foley': ['insertion of urinary catheter', 'قسطرة بولية'],
  'ctg': ['fetal monitoring by cardiotocography', 'مراقبة معدل نبض الجنين'],
  'holter': ['holter monitor', 'جهاز هولتر', 'تركيب جهاز هولتر'],
  'هولتر': ['holter monitor', 'جهاز هولتر'],
  'spirometry': ['pulmonary function test', 'قياس كفاءة الرئتين'],
  'وظائف تنفس': ['pulmonary function test', 'spirometry'],
  'fees': ['flexible endoscopic evaluation of swallowing', 'تقييم البلع بالمنظار'],
  'تقييم بلع': ['flexible endoscopic evaluation of swallowing', 'fees'],
  'علاج ضوئي': ['phototherapy', 'علاج ضوئي لحديثي الولادة'],
  'فصل بلازما': ['plasma pharesis', 'plasmapheresis', 'اجراء فصل بلازما'],
  'plasmapheresis': ['plasma pharesis', 'اجراء فصل بلازما'],

  // Physiotherapy & Rehabilitation
  'physiotherapy': ['physiotherapy session for inp patients', 'physiotherapy session for icu patients', 'جلسة علاج طبيعي'],
  'physiotherapy session': ['physiotherapy session for inp patients', 'physiotherapy session for icu patients', 'جلسة علاج طبيعي'],
  'physiotherapy sessions': ['physiotherapy session for inp patients', 'physiotherapy session for icu patients', 'جلسة علاج طبيعي'],
  'physical therapy': ['physiotherapy session for inp patients', 'physiotherapy session for icu patients', 'جلسة علاج طبيعي'],
  'جلسات علاج طبيعي': ['physiotherapy session for inp patients', 'physiotherapy session for icu patients', 'جلسة علاج طبيعي لمرضي القسم الداخلي'],
  'جلسة علاج طبيعي': ['physiotherapy session for inp patients', 'physiotherapy session for icu patients', 'جلسة علاج طبيعي لمرضي القسم الداخلي'],
  'علاج طبيعي': ['physiotherapy session for inp patients', 'جلسة علاج طبيعي لمرضي القسم الداخلي'],

  // Routine Clinical Laboratory & Endocrine (Batch 4)
  'cbc': ['complete blood count', 'صورة دم كاملة', 'صورة دم', 'blood picture'],
  'صورة دم': ['complete blood count', 'cbc', 'صورة دم كاملة'],
  'esr': ['erythrocyte sedimentation rate', 'سرعة ترسيب', 'سرعة الترسيب'],
  'سرعة ترسيب': ['esr', 'erythrocyte sedimentation rate'],
  'pt': ['prothrombin time and inr', 'prothrombin time', 'تحليل سيولة', 'سيولة الدم'],
  'inr': ['prothrombin time and inr', 'international normalized ratio', 'تحليل سيولة'],
  'سيولة': ['prothrombin time and inr', 'pt inr', 'سيولة الدم'],
  'ptt': ['partial thromboplastin time', 'aptt', 'زمن التجلط الجزئي'],
  'd-dimer': ['d-dimer quantitative', 'd dimer', 'دي دايمر'],
  'دي دايمر': ['d-dimer quantitative', 'd-dimer'],
  'creatinine': ['serum creatinine', 'وظائف كلى', 'كرياتينين'],
  'وظائف كلى': ['serum creatinine', 'blood urea', 'كرياتينين', 'يوريا'],
  'كرياتينين': ['serum creatinine', 'creatinine'],
  'يوريا': ['blood urea', 'urea', 'بولينا'],
  'حمض البوليك': ['serum uric acid', 'uric acid', 'نقرس'],
  'زلال بالبول': ['microalbuminuria', 'albumin creatinine ratio', 'protein in urine'],
  'تحليل بول': ['complete urine analysis', 'urine analysis', 'فحص بول روتيني'],
  'تحليل براز': ['complete stool analysis', 'stool analysis', 'فحص براز روتيني'],
  'دم خفي': ['fecal occult blood test', 'occult blood in stool', 'fobt'],
  'كالبروتكتين': ['fecal calprotectin', 'calprotectin'],
  'alt': ['sgpt', 'alanin aminotransferase', 'انزيمات كبد'],
  'sgpt': ['alt', 'alanin aminotransferase', 'انزيمات كبد'],
  'ast': ['sgot', 'aspartate aminotransferase', 'انزيمات كبد'],
  'sgot': ['ast', 'aspartate aminotransferase', 'انزيمات كبد'],
  'انزيمات كبد': ['alt', 'ast', 'sgpt', 'sgot'],
  'وظائف كبد': ['alt', 'ast', 'bilirubin', 'albumin'],
  'الصفراء': ['total and direct bilirubin', 'bilirubin total and direct'],
  'البيومين': ['serum albumin', 'albumin'],
  'فوسفاتيز قلوي': ['alkaline phosphatase', 'alp'],
  'صوديوم': ['serum sodium', 'sodium'],
  'بوتاسيوم': ['serum potassium', 'potassium'],
  'كالسيوم': ['serum calcium', 'calcium total'],
  'فيريتين': ['serum ferritin', 'مخزون الحديد'],
  'مخزون الحديد': ['serum ferritin', 'ferritin'],
  'fbs': ['fasting blood sugar', 'fasting blood glucose', 'سكر صائم'],
  'سكر صائم': ['fasting blood sugar', 'fbs'],
  '2hpp': ['2 hours post prandial blood sugar', 'سكر فاطر'],
  'سكر فاطر': ['2 hours post prandial blood sugar', '2hpp'],
  'rbs': ['random blood sugar', 'سكر عشوائي'],
  'سكر عشوائي': ['random blood sugar', 'rbs'],
  'hba1c': ['glycated hemoglobin', 'السكر التراكمي', 'سكر تراكمي'],
  'سكر تراكمي': ['glycated hemoglobin', 'hba1c', 'السكر التراكمي'],
  'كوليسترول': ['serum total cholesterol', 'cholesterol'],
  'دهون ثلاثية': ['serum triglycerides', 'triglycerides'],
  'دهون كاملة': ['full lipid profile', 'lipid profile'],
  'troponin': ['troponin i quantitative', 'troponin t', 'تروبونين'],
  'تروبونين': ['troponin i quantitative', 'troponin', 'hs-ctni'],
  'abg': ['arterial blood gas', 'غازات دم شرياني'],
  'غازات دم': ['arterial blood gas', 'abg'],
  'tsh': ['thyroid stimulating hormone', 'هرمون الغدة الدرقية', 'تحليل تي اس اتش'],
  'الغدة الدرقية': ['tsh', 'free t3', 'free t4'],
  'pth': ['intact pth pth 1-84', 'parathyroid hormone', 'باراثورمون', 'هرمون الغدة الجار درقية'],
  'باراثورمون': ['intact pth pth 1-84', 'pth', 'parathormone'],
  'فيتامين د': ['25-oh vitamin d total', 'vitamin d3', 'vitamin d'],
  'تحليل حمل': ['beta hcg quantitative', 'pregnancy test in blood'],
  'برولاكتين': ['serum prolactin', 'هرمون اللبن'],
  'مخزون المبيض': ['anti mullerian hormone', 'amh'],
  'psa': ['total psa prostate specific antigen', 'prostate specific antigen', 'دلالات اورام البروستاتا'],
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
    const isEnglishKey = /^[a-z0-9\s-]+$/i.test(key);
    const normKey = normalizeText(key);
    let matched = false;

    if (isEnglishKey && key.length <= 4) {
      // Short acronyms (e.g. 'ct', 'mri', 'pci', 'eeg', 'ecg') require word boundary to avoid matching inside words like 'calprotectin'
      matched = new RegExp(`\\b${key}\\b`, 'i').test(cleanQ);
    } else {
      matched = (normKey && norm.includes(normKey)) || norm.includes(key) || normAr.includes(key);
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
    /اقامه|سرير|عنايه مركزه|رعايه مركزه|رسم دخول|رسوم فتح ملف|كشف طوارئ|استشاره|مرور طبيب|مد فتره حجز|فتره حجز|حجز|مد الاقامه/i.test(a) ||
    /إقامة|اقامة|مد فترة حجز|مد الإقامة/i.test(name)
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

/**
 * Extracts a concise, normalized refusal reason or instruction from text or notes.
 */
export function extractRefusalReason(snippet?: string): string {
  if (!snippet || !snippet.trim()) return '';
  const norm = snippet
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[إأآ]/g, 'ا')
    .replace(/ة/g, 'ه');

  if (norm.includes('تم الرفض علي السيستم') || norm.includes('الرفض علي السيستم') || norm.includes('الرفض على السيستم') || norm.includes('علي السيستم')) {
    return 'تم الرفض على السيستم';
  }
  if (norm.includes('تم الرفض') || norm.includes('رفض الطلب') || norm.includes('طلب مرفوض') || norm.includes('مرفوض')) {
    return 'مرفوض من جهة التعاقد';
  }
  if (norm.includes('المتابعه الحسابيه') || norm.includes('المتابعة الحسابية')) {
    return 'الحالة كاش - متابعة حسابية';
  }
  if (norm.includes('معمل خارجي') || norm.includes('طرف التعاقد والمريض في معمل خارجي')) {
    return 'تنسيق التحليل بمعمل خارجي';
  }
  if (norm.includes('لعدم مد الاقامه') || norm.includes('رفع الحد الاقصي')) {
    return 'لعدم مد الإقامة ورفع الحد الأقصى';
  }
  if (norm.includes('حسابات المرضي') || norm.includes('حسابات المرضى')) {
    return 'توجيه الأهل لقسم حسابات المرضى';
  }
  if (
    norm.includes('ارسال الاهل') ||
    norm.includes('إرسال الأهل') ||
    norm.includes('للحسابات للتغطيه') ||
    norm.includes('للحسابات للتغطية')
  ) {
    return 'إرسال الأهل للحسابات للتغطية';
  }
  if (norm.includes('رسيبشن') || norm.includes('ريسبشن')) {
    return 'توجيه الأهل للريسبشن للتغطية';
  }
  if (
    norm.includes('الحاله كاش') ||
    norm.includes('الحالة كاش') ||
    norm.includes('المريض كاش') ||
    norm.includes('كاش طرف الاهل') ||
    norm.includes('كاش طرف الأهل') ||
    norm.includes('كاش')
  ) {
    return 'كاش طرف الأهل';
  }
  if (norm.includes('تامينيا') || norm.includes('تامنيا')) {
    return 'غير مغطى تأمينياً';
  }
  if (norm.includes('خارج التغطيه') || norm.includes('خارج التغطية')) {
    return 'خارج التغطية';
  }
  return 'غير مغطى';
}


