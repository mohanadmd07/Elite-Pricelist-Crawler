/**
 * Doctor Narrative Parser & Clinical Context Interpreter
 * 
 * In Egyptian private hospitals, doctors frequently enter multi-sentence clinical notes
 * combining patient history, present illness, comorbidity backstory, clinical indications,
 * and requested medical interventions (procedures, surgeries, imaging, stay extensions).
 * 
 * This module cleanly separates:
 * 1. Clean requested procedures / services (for pricelist matching without NO_MAPPING).
 * 2. Clinical indication in standardized Arabic (الداعي الطبي for Case Managers and TPAs).
 * 3. Urgency and clinical specialty category.
 */

import { stripSentFromSignatures, normalizeHomoglyphs } from './arabic-normalizer';

export type ClinicalUrgency = 'routine' | 'urgent' | 'emergency';
export type ClinicalCategory =
  | 'surgery'
  | 'radiology'
  | 'laboratory'
  | 'physiotherapy'
  | 'rehabilitation'
  | 'cardiology'
  | 'stay_extension'
  | 'procedure';

export interface ParsedDoctorNarrative {
  primaryProcedure: string;
  secondaryProcedures: string[];
  clinicalIndicationAr: string;
  clinicalIndicationEn?: string;
  urgency: ClinicalUrgency;
  category: ClinicalCategory;
  hasMultipleProcedures: boolean;
  cleanServices: Array<{ name: string; rawPrice?: number }>;
}

/**
 * Standard medical dictionary mapping English clinical indications, symptoms,
 * and comorbidities into precise Arabic medical terminology.
 */
const CLINICAL_PHRASE_TRANSLATIONS: Array<[RegExp, string]> = [
  // Cardiology
  [/\bacute\s+coronary\s+syndrome\b/gi, 'متلازمة الشريان التاجي الحادة'],
  [/\b(?:ecg\s+shows\s+)?stemi\b/gi, 'جلطة حادة بعضلة القلب'],
  [/\bnstemi\b/gi, 'جلطة غير مكتملة بعظام القلب'],
  [/\bmyocardial\s+infarction\b/gi, 'احتشاء عضلة القلب'],
  [/\bangina\b/gi, 'ذبحة صدرية'],
  [/\bchest\s+pain\b/gi, 'آلام بالصدر'],
  [/\bheart\s+failure\b/gi, 'فشل بعضلة القلب'],

  // Neurology
  [/\bbilateral\s+lower\s+limb\s+weakness\b/gi, 'ضعف بالطرفين السفليين'],
  [/\bbilateral\s+upper\s+limb\s+weakness\b/gi, 'ضعف بالطرفين العلويين'],
  [/\blower\s+limb\s+weakness\b/gi, 'ضعف بالطرف السفلي'],
  [/\bupper\s+limb\s+weakness\b/gi, 'ضعف بالطرف العلوي'],
  [/\bsevere\s+headache\b/gi, 'صداع شديد'],
  [/\bheadache\b/gi, 'صداع'],
  [/\b(?:cva|stroke)\b/gi, 'جلطة بالمخ'],
  [/\band\s+(?:hx|history)\s+of\s+strokes\b/gi, '، مع تاريخ مرضي من الجلطات'],
  [/\band\s+(?:hx|history)\s+of\s+stroke\b/gi, '، مع تاريخ مرضي لجلطة بالمخ'],
  [/\b(?:hx|history)\s+of\s+strokes\b/gi, 'مع تاريخ مرضي من الجلطات'],
  [/\b(?:hx|history)\s+of\s+stroke\b/gi, 'مع تاريخ مرضي لجلطة بالمخ'],

  // General Surgery / Abdomen
  [/\bacute\s+appendicitis\b/gi, 'التهاب حاد بالزائدة الدودية'],
  [/\bappendicitis\b/gi, 'التهاب الزائدة الدودية'],
  [/\bacute\s+cholecystitis\b/gi, 'التهاب حاد بالمرارة'],
  [/\bcholecystitis\b/gi, 'التهاب بالمرارة'],
  [/\bintestinal\s+obstruction\b/gi, 'انسداد معوي'],
  [/\bsevere\s+rlq\s+(?:tenderness|pain)\b/gi, 'ألم شديد بأسفل يمين البطن'],
  [/\brlq\s+(?:tenderness|pain)\b/gi, 'ألم بأسفل يمين البطن'],
  [/\babdominal\s+pain\b/gi, 'ألم بالبطن'],
  [/\bvomiting\b/gi, 'قئ مستمر'],
  [/\bfever\b/gi, 'ارتفاع في درجة الحرارة'],
  [/\bhigh\s+fever\b/gi, 'ارتفاع حاد في درجة الحرارة'],

  // Systemic / Comorbidities
  [/\bdue\s+to\s+(?:diabetes(?:\s+mellitus)?|dm)\b/gi, 'بسبب مرض داء السكري'],
  [/\bdue\s+to\s+(?:hypertension|htn)\b/gi, 'بسبب ارتفاع ضغط الدم'],
  [/\bsepsis\b/gi, 'تسمم دموي'],
  [/\bseptic\s+shock\b/gi, 'صدمة تسممية'],
  [/\bdiabetic\s+ketoacidosis\b/gi, 'حموضة كيتونية سكرية'],
  [/\bdiabetic\s+foot(?:\s+ulcer)?\b/gi, 'قدم سكري'],
  [/\bdeep\s+vein\s+thrombosis\b|\bdvt\b/gi, 'جلطة بالأوردة العميقة'],
  [/\bpulmonary\s+embolism\b|\bpe\b/gi, 'جلطة بالشريان الرئوي'],
];

/**
 * Translates and formats clinical symptoms and backstory into a formal Arabic clinical indication.
 */
export function translateDoctorIndication(text: string): string {
  if (!text) return '';
  let clean = text.trim();

  // Strip narrative prefixes
  clean = clean.replace(/^(?:patient\s+(?:had|has|was|is|suffering\s+from|admitted\s+through\s+er\s+with|admitted\s+with|presenting\s+with|presented\s+with)?\s*)/i, '').trim();

  let translated = clean;
  let hasMatch = false;

  for (const [re, replacement] of CLINICAL_PHRASE_TRANSLATIONS) {
    if (re.test(translated)) {
      hasMatch = true;
      translated = translated.replace(re, replacement);
    }
  }

  // Clean trailing punctuation and English conjunctions
  translated = translated
    .replace(/\b(?:and|with)\b/gi, 'و')
    .replace(/\s*,\s*/g, ' و ')
    .replace(/\s+/g, ' ')
    .trim();

  if (hasMatch) {
    if (!translated.startsWith('المريض') && !translated.startsWith('المريضة')) {
      translated = `المريض يعاني من ${translated}`;
    }
    return translated;
  }

  return clean;
}

export function isDoctorNarrative(text: string): boolean {
  if (!text || text.trim().length < 15) return false;
  return (
    /(?:patient\s+(?:had|has|is|was|admitted|presenting|presented|suffering)|due\s+to|hx\s+of|history\s+of|scheduled\s+for|planned\s+for)/i.test(text) ||
    /(?:يعاني|تعاني|يعانى|تعانى|لاشتباه|اشتباه|لوجود|نظرا|نظراً|بسبب|مع\s+تاريخ\s+مرضي|تحتاج\s+(?:الحالة|الحاله|المريضة|المريضه)|يحتاج\s+(?:المريض|الطفل)|اوصى\s+بعمل|اوصي\s+بعمل|بحاجة\s+(?:الى|الي)|بحاجه\s+(?:الى|الي))/i.test(text)
  );
}

/**
 * Comprehensive parser for unstructured doctor clinical narrative notes.
 */
export function parseDoctorNarrative(rawText: string): ParsedDoctorNarrative {
  if (!rawText) {
    return {
      primaryProcedure: '',
      secondaryProcedures: [],
      clinicalIndicationAr: '',
      urgency: 'routine',
      category: 'procedure',
      hasMultipleProcedures: false,
      cleanServices: [],
    };
  }

  const text = stripSentFromSignatures(rawText).trim();

  // If not a doctor narrative, return clean original text without alteration
  if (!isDoctorNarrative(text)) {
    return {
      primaryProcedure: text,
      secondaryProcedures: [],
      clinicalIndicationAr: '',
      urgency: 'routine',
      category: 'procedure',
      hasMultipleProcedures: false,
      cleanServices: [{ name: text, rawPrice: 0 }],
    };
  }

  // 1. Detect Urgency
  let urgency: ClinicalUrgency = 'routine';
  if (/\b(?:emergency|stemi|shock|arrest|acute\s+coronary|massive\s+bleeding|طارئ|طوارئ|حرج|عاجل|إنقاذ\s+حياة)\b/i.test(text)) {
    urgency = 'emergency';
  } else if (/\b(?:urgent|urgently|acute\s+appendicitis|peritonitis|severe\s+pain|مستعجل|عاجلة|حالة\s+حادة)\b/i.test(text)) {
    urgency = 'urgent';
  }

  // 2. English narrative extraction:
  // e.g. "patient admitted through ER with acute appendicitis ... scheduled for urgent laparoscopic appendectomy"
  // e.g. "patient presenting with acute coronary syndrome and chest pain, ECG shows STEMI, for primary PCI with stent"
  // e.g. "patient had bilateral lower limb weakness due to diabetes and hx of strokes and on physiotherapy sessions"
  const engNarrativeMatch = text.match(
    /(?:patient\s+(?:had|has|is|was|admitted[^\n\r,]+with|presenting[^\n\r,]+with|presented[^\n\r,]+with|suffering\s+from)?\s+)?(.+?)\s+(?:and\s+(?:is\s+)?on|and\s+needs|and\s+requires|needs|requires|scheduled\s+for|planned\s+for|for)\s+([a-zA-Z0-9\s/-]+)(?:\r|\n|$)/i
  );

  let primaryProcedure = '';
  let clinicalIndicationAr = '';
  let clinicalIndicationEn = '';

  if (engNarrativeMatch && engNarrativeMatch[2]) {
    const candidateProc = engNarrativeMatch[2].replace(/\b(?:urgent|emergently|urgently)\b/gi, '').trim();
    if (candidateProc.length >= 3 && !candidateProc.toLowerCase().includes('inpatient')) {
      primaryProcedure = candidateProc;
      clinicalIndicationEn = engNarrativeMatch[1].trim();
      clinicalIndicationAr = translateDoctorIndication(clinicalIndicationEn);
    }
  }

  // 3. Arabic narrative extraction:
  // e.g. "المريضة تعاني من ارتفاع في درجة الحرارة و تحتاج الي مد فترة حجزها لعمل التحاليل اللازمة ... مع عمل اشعة مقطعية علئ المخ لانها تعاني من صداع شديد مع تاريخ مرضي بالجلطات"
  if (!primaryProcedure) {
    const araTrigger = text.match(
      /(?:واوصي بعمل|واوصى بعمل|أوصى بعمل|اوصي بعمل|اوصى بعمل|ويحتاج الى عمل|ويحتاج الي عمل|ويحتاج لعمل|يحتاج الى عمل|يحتاج الي عمل|يحتاج لعمل|بحاجة لاجراء|بحاجة لإجراء|بحاجة الى عمل|بحاجة الي عمل|بحاجة الى|بحاجة الي|بحاجه الى عمل|بحاجه الي عمل|بحاجه الى|بحاجه الي|وتم طلب عمل|وتم طلب|تم طلب عمل|تم طلب|(?:برجاء|نرجو|يرجى)\s+(?:من\s+سيادتكم\s+)?(?:الموافقة|الموافقه|موافقة|موافقه)\s+(?:علي\s+عمل|على\s+عمل|علي|على)?|برجاء عمل|المطلوب عمل|المطلوب موافقة على|المطلوب موافقة علي|المطلوب موافقة|المطلوب موافقه|المطلوب|يحتاج الى|يحتاج الي|اوصى ب|اوصي ب|(?:وتحتاج|تحتاج|ويحتاج|يحتاج)\s+(?:الحاله|الحالة|المريض|المريضة|المريضه)\s+(?:لـ?|إلى|الى|إلي|الي)?\s*(?:عمل|إجراء|اجراء)?)\s*(.+)/is
    );
    if (araTrigger && araTrigger[1]) {
      primaryProcedure = araTrigger[1].split(/(?:مع\s+عمل|بالإضافة|بالاضافة|لانها|لانه|بسبب)/i)[0].trim();
    }
  }

  // Strip trailing justification from primaryProcedure
  if (primaryProcedure) {
    primaryProcedure = primaryProcedure
      .replace(/(?:\s+(?:لانه|لأنه|لانها|لأنها|متابعة|لمتابعة|لمتابعه|لتقييم|لحين|نظرا|نظراً|بسبب|بعد|لاشتباه|للاشتباه|اشتباه|لوجود|لحالة|لحاله|مع\s+تاريخ\s+مرضي|لتاريخ\s+مرضي)\s+.*)$/is, '')
      .trim();

    // Check if procedure has an explicit uppercase medical acronym embedded (e.g. "EEG", "EMG", "ECG")
    const acronymMatch = primaryProcedure.match(/\b([A-Z]{2,6})\b/);
    if (acronymMatch && acronymMatch[1] && (primaryProcedure.match(/[\u0600-\u06FF]/g) || []).length > 0) {
      primaryProcedure = acronymMatch[1];
    }
  }

  if (!clinicalIndicationAr) {
    const araSymptomsMatch = text.match(
      /(?:المريض|المريضة|المريضه|الحالة|الحاله)\s+(?:يعاني|تعاني|يعانى|تعانى)\s+من\s+([^و\r\n<]+(?:و[^و\r\n<]+)*)/i
    );
    if (araSymptomsMatch && araSymptomsMatch[1]) {
      clinicalIndicationAr = `المريض يعاني من ${araSymptomsMatch[1].trim()}`;
    } else {
      const trailingJustification = text.match(
        /(?:لانها|لانه|لأنها|لأنه|نظرا\s+لـ?|نظراً\s+لـ?|بسبب|مع\s+تاريخ\s+مرضي|لاشتباه|اشتباه|لوجود)\s+([^\r\n.<]+)/i
      );
      if (trailingJustification && trailingJustification[1]) {
        clinicalIndicationAr = `المريض يعاني من ${trailingJustification[1].trim()}`;
      }
    }
  }

  // 4. Multi-Procedure Dissection (e.g. Stay extension + CT Brain + Blood Culture)
  const secondaryProcedures: string[] = [];
  const cleanServices: Array<{ name: string; rawPrice?: number }> = [];

  // Check if text requests stay extension
  const hasStayExtension = /مد\s+(?:فترة\s+)?(?:حجز|الاقامه|الإقامة|الاقامة)/i.test(text);
  const alreadyStay = /مد|إقامة|اقامة|حجز/i.test(primaryProcedure);
  if (hasStayExtension && !alreadyStay) {
    secondaryProcedures.push('مد الإقامة ومتابعة طبية بالقسم الداخلي');
  }

  // Check if text requests CT Scan
  const hasCtScan = /اشعة\s+مقطعية|أشعة\s+مقطعية|\bct\b/i.test(text);
  const alreadyCt = /ct|مقطعية|مقطعيه/i.test(primaryProcedure);
  if (hasCtScan && !alreadyCt) {
    let ctName = 'أشعة مقطعية على المخ';
    if (/بطن|حوض|abdomen|pelvis/i.test(text)) ctName = 'أشعة مقطعية على البطن والحوض';
    else if (/صدر|chest/i.test(text)) ctName = 'أشعة مقطعية على الصدر';
    if (!secondaryProcedures.includes(ctName)) {
      secondaryProcedures.push(ctName);
    }
  }

  // Check if text requests MRI
  const hasMri = /رنين\s+مغناطيسي|\bmri\b/i.test(text);
  const alreadyMri = /mri|رنين/i.test(primaryProcedure);
  if (hasMri && !alreadyMri) {
    const mriName = 'أشعة رنين مغناطيسي';
    if (!secondaryProcedures.includes(mriName)) {
      secondaryProcedures.push(mriName);
    }
  }

  // Check if text requests Ultrasound / Echo
  const hasEcho = /موجات\s+فوق\s+صوتية|ايكو|إيكو|\becho\b/i.test(text);
  const alreadyEcho = /echo|ايكو|إيكو|موجات/i.test(primaryProcedure);
  if (hasEcho && !alreadyEcho) {
    const echoName = 'موجات فوق صوتية على القلب (Echocardiography)';
    if (!secondaryProcedures.includes(echoName)) {
      secondaryProcedures.push(echoName);
    }
  }

  // Check if text requests Physiotherapy
  const hasPhysio = /علاج\s+طبيعي|\bphysiotherapy\b|\bphysical\s+therapy\b/i.test(text);
  const alreadyPhysio = /physio|طبيعي/i.test(primaryProcedure);
  if (hasPhysio && !alreadyPhysio) {
    const physioName = 'جلسات علاج طبيعي';
    if (!secondaryProcedures.includes(physioName)) {
      if (!primaryProcedure) primaryProcedure = physioName;
      else secondaryProcedures.push(physioName);
    }
  }

  // 5. Build cleanServices list
  if (primaryProcedure) {
    cleanServices.push({ name: primaryProcedure, rawPrice: 0 });
  }
  for (const sec of secondaryProcedures) {
    if (!cleanServices.some((s) => s.name === sec)) {
      cleanServices.push({ name: sec, rawPrice: 0 });
    }
  }

  if (cleanServices.length === 0) {
    cleanServices.push({ name: text, rawPrice: 0 });
  }

  // 6. Determine Category
  let category: ClinicalCategory = 'procedure';
  const combinedNames = (primaryProcedure + ' ' + secondaryProcedures.join(' ')).toLowerCase();
  if (hasStayExtension && cleanServices.length === 1) {
    category = 'stay_extension';
  } else if (/appendectomy|laparoscopic|cholecystectomy|hernia|repair|surgery|جراحة|استئصال|عملية|منظار/i.test(combinedNames)) {
    category = 'surgery';
  } else if (/pci|catheter|stent|coronary|قسطرة|دعامة/i.test(combinedNames)) {
    category = 'cardiology';
  } else if (/physiotherapy|physical\s+therapy|علاج\s+طبيعي/i.test(combinedNames)) {
    category = 'rehabilitation';
  } else if (/ct|mri|x-ray|ultrasound|echo|اشعة|أشعة|رنين|سونار/i.test(combinedNames)) {
    category = 'radiology';
  } else if (/culture|cbc|crp|تحليل|مزرعة/i.test(combinedNames)) {
    category = 'laboratory';
  }

  return {
    primaryProcedure: primaryProcedure || cleanServices[0].name,
    secondaryProcedures,
    clinicalIndicationAr: clinicalIndicationAr || 'الداعي الطبي قيد المتابعة السريرية',
    clinicalIndicationEn,
    urgency,
    category,
    hasMultipleProcedures: cleanServices.length > 1,
    cleanServices,
  };
}

/**
 * Formats a clean executive summary in Arabic synthesizing the doctor narrative context and decision.
 */
export function formatDoctorNarrativeSummary(parsed: ParsedDoctorNarrative, patientName?: string): string {
  const patient = patientName ? `للمريض ${patientName}` : '';
  const procNames = parsed.cleanServices.map((s) => s.name).join(' و ');
  const urgencyPrefix = parsed.urgency === 'emergency' ? 'طارئ: ' : parsed.urgency === 'urgent' ? 'عاجل: ' : '';
  return `${urgencyPrefix}طلب موافقة ${patient} على (${procNames}). الداعي الطبي: ${parsed.clinicalIndicationAr}.`;
}
