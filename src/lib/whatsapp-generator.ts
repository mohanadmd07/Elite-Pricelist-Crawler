import { InpatientApprovalRecord } from '../types';
import { cleanContractorName, stripSentFromSignatures, isAccommodationOrGenericFee, extractRefusalReason } from './arabic-normalizer';
import { generateCmWhatsappWithAI, isGeminiConfigured } from '../services/aiMatchService';

/**
 * Extracts clean, concise clinical procedure phrasing from raw doctor notes or service names.
 * Strips clinical backstory, symptoms, indications, and isolates English/Arabic procedure titles.
 */
export function extractCleanProcedurePhrase(rawText: string): string {
  if (!rawText) return '';

  // 1. Check if rawText has a dedicated line with an English procedure (e.g. "MRI BRAIN WITH CONTRAST")
  const rawLines = rawText.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  for (const line of rawLines) {
    const stripped = stripSentFromSignatures(line).trim();
    const engLetters = (stripped.match(/[a-zA-Z]/g) || []).length;
    const araLetters = (stripped.match(/[\u0600-\u06FF]/g) || []).length;
    if (engLetters >= 4 && engLetters > araLetters) {
      const cleanLine = stripped.replace(/^[-*•\d.)\s]+/, '').trim();
      const lower = cleanLine.toLowerCase();
      if (
        !lower.startsWith('get outlook') &&
        !lower.startsWith('sent from') &&
        !lower.startsWith('inpatient') &&
        !lower.startsWith('mrn') &&
        !lower.startsWith('bed')
      ) {
        return cleanLine;
      }
    }
  }

  let text = stripSentFromSignatures(rawText).trim();
  if (!text) return '';

  // 2. Check for explicit English procedure phrase or clinical acronym embedded anywhere in text
  // e.g. "EEG", "EMG", "ECG", "MRI BRAIN WITH CONTRAST", "Bed Side Endoscopic Tracheostomy", "ankle foot orthosis", "Blood Culture - Aerobic"
  const acronymMatches = text.match(/\b([A-Z]{2,6}(?:\s+[A-Za-z0-9()/-]+)?)\b/g);
  if (acronymMatches) {
    for (const match of acronymMatches) {
      const m = match.trim();
      const lower = m.toLowerCase();
      if (
        !lower.includes('inpatient') &&
        !lower.includes('approval') &&
        !lower.includes('patient') &&
        !lower.includes('physician') &&
        !lower.includes('contractor') &&
        !lower.includes('admission') &&
        !lower.includes('diagnosis') &&
        !lower.includes('request') &&
        !lower.startsWith('mrn') &&
        !lower.startsWith('bed') &&
        !lower.startsWith('zone') &&
        !lower.startsWith('icu')
      ) {
        const araLetters = (text.match(/[\u0600-\u06FF]/g) || []).length;
        if (araLetters > 0) return m;
      }
    }
  }

  const engMatches = text.match(/\b([A-Za-z][A-Za-z0-9\s()/-]{2,}[A-Za-z0-9)])\b/g);
  if (engMatches) {
    for (const match of engMatches) {
      const m = match.trim();
      const lower = m.toLowerCase();
      if (
        m.length >= 3 &&
        !lower.includes('inpatient') &&
        !lower.includes('approval') &&
        !lower.includes('patient') &&
        !lower.includes('physician') &&
        !lower.includes('contractor') &&
        !lower.includes('admission') &&
        !lower.includes('diagnosis') &&
        !lower.includes('request details') &&
        !lower.includes('selected services') &&
        !lower.includes('sent from') &&
        !lower.includes('get outlook') &&
        !lower.startsWith('mrn') &&
        !lower.startsWith('bed') &&
        !lower.startsWith('zone') &&
        !lower.startsWith('icu')
      ) {
        return m;
      }
    }
  }

  // 3. Clinical recommendation triggers in Arabic
  const clinicalMatch = text.match(
    /(?:واوصي بعمل|واوصى بعمل|أوصى بعمل|اوصي بعمل|اوصى بعمل|ويحتاج الى عمل|ويحتاج الي عمل|ويحتاج لعمل|يحتاج الى عمل|يحتاج الي عمل|يحتاج لعمل|بحاجة لاجراء|بحاجة لإجراء|بحاجة الى عمل|بحاجة الي عمل|بحاجة الى|بحاجة الي|بحاجه الى عمل|بحاجه الي عمل|بحاجه الى|بحاجه الي|وتم طلب عمل|وتم طلب|تم طلب عمل|تم طلب|(?:برجاء|نرجو|يرجى)\s+(?:من\s+سيادتكم\s+)?(?:الموافقة|الموافقه|موافقة|موافقه)\s+(?:علي\s+عمل|على\s+عمل|علي|على)?|برجاء عمل|المطلوب عمل|المطلوب موافقة على|المطلوب موافقة علي|المطلوب موافقة|المطلوب موافقه|المطلوب|يحتاج الى|يحتاج الي|اوصى ب|اوصي ب|(?:وتحتاج|تحتاج|ويحتاج|يحتاج)\s+(?:الحاله|الحالة|المريض|المريضة|المريضه)\s+(?:لـ?|إلى|الى|إلي|الي)?\s*(?:عمل|إجراء|اجراء)?|(?:الحاله|الحالة|المريض|المريضة|المريضه)\s+(?:بحاجة|بحاجه|تحتاج|يحتاج)\s+(?:الى|الي|لـ?)\s*(?:عمل|إجراء|اجراء)?)\s*(.+)/is
  );

  if (clinicalMatch && clinicalMatch[1]) {
    text = clinicalMatch[1].trim();
  }

  // 4. Strip trailing clinical indications, backstory, and fillers
  text = text.replace(/و?\s*بحاجة للبقاء.*$/is, '');
  text = text.replace(/(?:\s+(?:لانه|لأنه|لانها|لأنها|متابعة|لمتابعة|لمتابعه|لتقييم|لحين|نظرا|نظراً|بسبب|بعد|لاشتباه|للاشتباه|اشتباه|لوجود|لحالة|لحاله|مع\s+تاريخ\s+مرضي|لتاريخ\s+مرضي)\s+.*)$/is, '');
  text = text.replace(/الحالة\s+كاش.*$/is, '');
  text = text.replace(/@\w+.*$/is, '');
  text = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Strip leading fluff like "المريضة تعاني من ... و تحتاج الى ..."
  text = text.replace(
    /^(?:المريض|المريضة|المريضه|الحالة|الحاله|الطفل|الطفلة|الطفله)\s+(?:يعاني|تعاني|يعانى|تعانى)\s+من\s+.*?(?:و\s*)?(?:يحتاج|تحتاج|نحتاج|بحاجة|بحاجه)\s+(?:الى|الي|لـ?)?\s*(?:عمل|إجراء|اجراء)?\s*/is,
    ''
  );
  text = text.replace(/^(?:يعاني|تعاني)\s+(?:المريض|المريضة|الحالة|الطفل|الطفله)\s+من\s+[^و]+و\s*(?:يحتاج|تحتاج|نحتاج)?\s*(?:الى|الي)?\s*/is, '');
  text = text.replace(/^طفل\s+يعانى\s+من\s+[^و]+و\s*/is, '');

  // Normalize stay extension phrases
  text = text.replace(/مد\s+فترة\s+حجز(?:ها)?/g, 'مد الإقامة');

  return text.trim();
}

function formatProcedureForCmWhatsapp(proc: string): string {
  const lower = proc.toLowerCase().trim();
  if (
    lower.includes('transesophageal') ||
    lower === 'tee' ||
    lower === 't.e.e' ||
    lower.includes('عن طريق المريء') ||
    lower.includes('ايكو بالمنظار') ||
    lower.includes('إيكو بالمنظار')
  ) {
    return 'موجات فوق صوتية على القلب عن طريق المريء (Transesophageal Echocardiography - TEE)';
  }
  if (
    lower.includes('mri brain with contrast') ||
    (lower.includes('mri') && lower.includes('brain') && lower.includes('contrast'))
  ) {
    return 'أشعة رنين مغناطيسي على المخ بالصبغة (MRI Brain With Contrast)';
  }
  if (lower.includes('ct pancreas triphasic')) {
    return 'أشعة مقطعية ثلاثية المراحل على البنكرياس (CT Pancreas Triphasic)';
  }
  if (lower.includes('pig tail')) {
    return 'تركيب قسطرة بيج تيل (Pig Tail Insertion)';
  }
  return proc;
}

/**
 * Extracts procedure name from an approval reply text.
 * e.g. "لا مانع من الدخول طوارئ لاجراء: استئصال الزائدة الدودية بالمنظار تحت مخدر بالعمليات - الحد الأقصى للموافقة 45 الف جنيه"
 * -> "استئصال الزائدة الدودية بالمنظار"
 */
export function extractProcedureFromApprovalReply(text: string): string {
  if (!text) return '';
  const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // 1. لا مانع من ... لاجراء / لعمل / وعمل / عمل / إجراء: <Procedure>
  const m1 = clean.match(
    /(?:لا\s*مانع\s*من\s*(?:الدخول[^\n\r:،,-]{0,35})?(?:ل?[إا]جراء|ل?عمل|وعمل)|الموافقة\s*على\s*(?:عمل|إجراء|اجراء)?)\s*[:\s]*([^\n\r،,-]+?)(?=\s*(?:-|–|تحت|بحد|الحد|شامل|مع|فقط|$))/i
  );
  if (m1 && m1[1] && m1[1].trim().length > 3) {
    const res = m1[1].trim();
    if (!res.toLowerCase().includes('inpatient') && !res.toLowerCase().includes('clinical evaluation')) {
      return res;
    }
  }

  // 2. معتمد لـ / موافقة على <Procedure>
  const m2 = clean.match(
    /(?:موافقة\s+على|معتمد\s+لـ?)\s*[:\s]*([^\n\r،,-]+?)(?=\s*(?:-|–|تحت|بحد|الحد|شامل|مع|فقط|$))/i
  );
  if (m2 && m2[1] && m2[1].trim().length > 3) {
    const res = m2[1].trim();
    if (!res.toLowerCase().includes('inpatient') && !res.toLowerCase().includes('clinical evaluation')) {
      return res;
    }
  }

  return '';
}

/**
 * Detects "price approval" (موافقة سعرية) wording in the thread snippets.
 *  - 'request':  someone must bring / make a price approval  (إحضار / عمل موافقة سعرية بمبلغ ...)
 *  - 'approved': a price approval was granted                (موافقة سعرية بمبلغ ...)
 */
export function detectPriceApprovalMode(record: InpatientApprovalRecord): 'request' | 'approved' | null {
  if (record.priceApprovalRequested) return 'request';
  const text = [
    record.existingApprovalSnippet,
    record.replySnippet,
    record.aiThreadSummary,
    record.statusReasonArabic,
    record.coverageConditions,
  ]
    .filter(Boolean)
    .join(' ')
    .normalize('NFKC')
    .replace(/[إأآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
  // "خارج التعاقد" (out of contract) => a price approval must be brought
  if (/خارج\s*(?:ال)?تعاقد/.test(text)) return 'request';
  if (!/موافق[ةه]?\s+سعري[ةه]?/.test(text)) return null;
  const isRequest =
    /(?:احضار|لاحضار|بإحضار|باحضار|عمل|اعمل|لعمل|مطلوب|المطلوب|يجب|سوف\s+يتم|سيتم|برجاء|الرجاء|نرجو)\s+(?:يتم\s+)?(?:احضار\s+)?(?:اصل\s+)?موافق[ةه]?\s+سعري[ةه]?/.test(text);
  return isRequest ? 'request' : 'approved';
}

function formatPriceAmount(record: InpatientApprovalRecord): string {
  if (record.creditLimitText) return record.creditLimitText;
  const n = record.creditLimit || record.approvedAmountLimit;
  return n && n > 0 ? `${n.toLocaleString('en-US')} ج.م` : '';
}

/**
 * Generates the standardized Case Manager (CM) WhatsApp message format:
 * 
 * *السيد محمد السيد حسنين* - Bed 322 - Zone B
 * خالده للبترول
 * *المطلوب موافقة سحب تحليل هرمون الغدة الجار درقية (PTH - Parathormone)*
 * 
 * If already approved:
 * *محمد خليل ابراهيم عبدالصمد* - Observation 6 - ER
 * جلوب ميد
 * *تمت الموافقة على: استئصال الزائدة الدودية بالمنظار (حد أقصى: 45,000 EGP)*
 */
export function generateCmWhatsappMessage(record: InpatientApprovalRecord): string {
  // Line 1: *Patient Name* - Bed <Location>
  const patient = (record.patientName || 'المريض').trim();
  let bedInfo = (record.bed || '').trim();
  bedInfo = bedInfo.replace(/Physician.*$/i, '').trim();
  if (
    bedInfo &&
    !bedInfo.toLowerCase().startsWith('bed') &&
    !bedInfo.toLowerCase().startsWith('inpatient') &&
    !bedInfo.toLowerCase().startsWith('icu') &&
    !bedInfo.toLowerCase().startsWith('observation')
  ) {
    bedInfo = `Bed ${bedInfo}`;
  }
  const line1 = bedInfo ? `*${patient}* - ${bedInfo}` : `*${patient}*`;

  // Line 2: Contractor (stripped of Main, شركة, شركه)
  let rawContractor = (record.contractorNormalized || record.contractorRaw || 'التعاقد').trim();
  if (rawContractor.includes('مستشفى إيليت') || rawContractor === 'غير محدد') {
    rawContractor = 'التعاقد';
  }
  const line2 = cleanContractorName(rawContractor) || rawContractor;

  // Line 3: Extract procedures
  let rawList: string[] = [];
  if (record.requestedServices && record.requestedServices.length > 0) {
    rawList = record.requestedServices.map((s) => s.name.trim()).filter(Boolean);
  } else if (record.matchedProcedures && record.matchedProcedures.length > 0) {
    rawList = record.matchedProcedures.map((m) => m.matchedName || m.serviceName).filter(Boolean);
  }

  // Filter out generic placeholders
  rawList = rawList.filter((s) => {
    const l = s.toLowerCase();
    return (
      !l.includes('clinical inpatient evaluation') &&
      !l.includes('inpatient clinical evaluation') &&
      !l.includes('clinical evaluation')
    );
  });

  // Check if an explicit clinical procedure was agreed upon in the approval reply
  const fromReply = extractProcedureFromApprovalReply(
    (record.existingApprovalSnippet || '') + ' ' + (record.replySnippet || '')
  );

  let cleanedServices = rawList
    .map(extractCleanProcedurePhrase)
    .map(formatProcedureForCmWhatsapp)
    .filter(Boolean);

  let procText = '';
  if (fromReply) {
    const cleanFromReply = extractCleanProcedurePhrase(fromReply);
    if (cleanedServices.length > 0 && !cleanedServices.some((s) => s.includes(cleanFromReply) || cleanFromReply.includes(s))) {
      const primaryService = cleanedServices[0].replace(/\/\s*first\s*\d+\s*hours?/i, '').trim();
      procText = `${cleanFromReply} (${primaryService})`;
    } else {
      procText = cleanFromReply;
    }
  } else if (cleanedServices.length > 0) {
    procText = cleanedServices.join(' و ');
  } else if (record.diagnosis && !record.diagnosis.toLowerCase().includes('evaluation') && !record.diagnosis.toLowerCase().includes('staff')) {
    procText = record.diagnosis;
  } else {
    procText = 'الدخول والإجراءات المقررة';
  }

  // Check approval and refusal status
  const isApproved =
    record.status === 'approved' ||
    record.status === 'conditionally_approved' ||
    Boolean(record.hasExistingApproval);
  const isRefused =
    record.status === 'refused' ||
    Boolean(record.isRefused);

  // Credit limit formatting
  let limitFormatted = '';
  if (record.creditLimitText) {
    limitFormatted = ` (حد أقصى: ${record.creditLimitText})`;
  } else if (record.creditLimit && record.creditLimit > 0) {
    limitFormatted = ` (حد أقصى: ${record.creditLimit.toLocaleString('en-US')} ج.م)`;
  } else if (record.approvedAmountLimit && record.approvedAmountLimit > 0) {
    limitFormatted = ` (حد أقصى: ${record.approvedAmountLimit.toLocaleString('en-US')} ج.م)`;
  }

  // Patient share / co-payment formatting
  let copayFormatted = '';
  if (record.patientSharePercentage && record.patientSharePercentage > 0) {
    copayFormatted = ` (نسبة التحمل: ${record.patientSharePercentage}%)`;
  }

  // Procedures unlisted in the contractor pricelist -> "مطلوب موافقة سعرية بمبلغ X" (X from another pricelist)
  const unlisted = (record.matchedProcedures || []).filter(
    (m) => m.status === 'unmatched' && (m.suggestedPrice || 0) > 0 && !isAccommodationOrGenericFee(m.serviceName)
  );
  const unlistedLines = unlisted.map((m) => {
    const name = formatProcedureForCmWhatsapp(extractCleanProcedurePhrase(m.serviceName)) || m.serviceName;
    const amt = ` بمبلغ ${(m.suggestedPrice as number).toLocaleString('en-US')} ج.م`;
    return { name, text: `مطلوب موافقة سعرية${amt} على: ${name}` };
  });
  if (unlistedLines.length > 0 && !isApproved && !isRefused) {
    const body =
      unlistedLines.length === 1
        ? unlistedLines[0].text
        : unlistedLines.map((u) => u.text).join(' | ');
    return `${line1}\n${line2}\n*${body}*`;
  }

  const priceMode = detectPriceApprovalMode(record);
  const priceAmount = record.priceApprovalRequested && record.priceApprovalAmount
    ? `${record.priceApprovalAmount.toLocaleString('en-US')} ج.م`
    : formatPriceAmount(record);
  const priceText = priceAmount ? `موافقة سعرية بمبلغ ${priceAmount}` : 'موافقة سعرية';

  let line3 = '';
  if (priceMode === 'request') {
    // "إحضار / عمل موافقة سعرية بمبلغ معين" -> "مطلوب موافقة سعرية بالمبلغ المعين"
    line3 = `*مطلوب ${priceText}${procText ? ` على: ${procText}` : ''}*`;
  } else if (isApproved && priceMode === 'approved') {
    // "موافقة سعرية بمبلغ معين" -> state it as a price approval, not as a max limit / ceiling
    line3 = `*تمت الموافقة على: ${procText} - ${priceText}*`;
  } else if (isApproved) {
    const condText = (record.coverageConditions || record.statusReasonArabic || '').trim();
    if (
      condText &&
      (condText.startsWith('مغطاة لمدة') || condText.startsWith('مغطاه لمده') || condText.startsWith('مشروط'))
    ) {
      line3 = `*موافقة مشروطة على: ${procText} (${condText})*`;
    } else if (
      condText &&
      (condText.startsWith('ما عدا') ||
        condText.startsWith('ماعدا') ||
        condText.includes('داخل المستشفى') ||
        condText.includes('داخل المستشفي'))
    ) {
      line3 = `*تمت الموافقة على: ${procText} (${condText})*`;
    } else {
      line3 = `*تمت الموافقة على: ${procText}${limitFormatted}${copayFormatted}*`;
    }
  } else if (isRefused) {
    const refusalReason = extractRefusalReason(
      record.statusReasonArabic || record.refusalSnippet || record.coverageConditions
    );
    line3 = refusalReason
      ? `*تم رفض طلب الموافقة على: ${procText} (${refusalReason})*`
      : `*تم رفض طلب الموافقة على: ${procText}*`;
  } else {
    // Check if procText is purely a clinical diagnosis / ICD-10 code rather than an explicit medical procedure
    const isDiagnosisCode =
      /^[A-Z]\d{2}(?:\.\d+)?\s*[-:]/i.test(procText) ||
      /\b(?:neoplasm|carcinoma|cancer|tumor|failure|infarction|stroke|hypertension|diabetes|syndrome|infection|sepsis|hematoma)\b/i.test(procText) ||
      /\b(?:ورم|سرطان|فشل|جلطة|جلطه|نزيف|التهاب|تجمع دموي)\b/i.test(procText);

    if (isDiagnosisCode || procText === 'الدخول والإجراءات المقررة') {
      const diagSuffix = procText && procText !== 'الدخول والإجراءات المقررة' ? ` (${procText})` : '';
      line3 = `*المطلوب موافقة دخول وإقامة بالقسم الداخلي${diagSuffix}*`;
    } else {
      let actionPrefix = '';
      if (
        procText.startsWith('سحب') ||
        procText.startsWith('عمل') ||
        procText.startsWith('تركيب') ||
        procText.startsWith('اجراء') ||
        procText.startsWith('إجراء') ||
        procText.startsWith('مد') ||
        procText.startsWith('إقامة') ||
        procText.startsWith('اقامة') ||
        procText.startsWith('دخول') ||
        procText.startsWith('حجز')
      ) {
        actionPrefix = '';
      } else if (procText.startsWith('تحليل')) {
        actionPrefix = 'سحب ';
      } else if (
        procText.startsWith('دعامة') ||
        procText.startsWith('دعامه') ||
        procText.startsWith('قسطرة') ||
        procText.startsWith('قسطره') ||
        procText.startsWith('انبوب') ||
        procText.startsWith('أنبوب')
      ) {
        actionPrefix = 'تركيب ';
      } else {
        actionPrefix = 'عمل ';
      }
      line3 = `*المطلوب موافقة ${actionPrefix}${procText}*`;
    }
  }

  return `${line1}\n${line2}\n${line3}`;
}

/**
 * Asynchronously generates an AI-optimized Case Manager WhatsApp message using Gemini AI.
 * Falls back seamlessly to deterministic procedure extraction if Gemini is unconfigured or unavailable.
 */
export async function generateCmWhatsappMessageAsync(record: InpatientApprovalRecord): Promise<string> {
  // 1. If pre-generated message is cached on the record, return it
  if (record.cmWhatsappMessage && record.cmWhatsappMessage.trim().length > 0) {
    return record.cmWhatsappMessage.trim();
  }

  // 2. Try Gemini AI if configured (price-approval wording is deterministic, so skip AI for it)
  if (isGeminiConfigured() && !detectPriceApprovalMode(record) && !(record.matchedProcedures || []).some((m) => m.status === 'unmatched' && (m.suggestedPrice || 0) > 0)) {
    try {
      const aiMsg = await generateCmWhatsappWithAI(record);
      if (aiMsg && aiMsg.split('\n').length >= 3) {
        return aiMsg;
      }
    } catch (err) {
      console.warn('[CM WhatsApp] AI generation error, using local fallback:', err);
    }
  }

  // 3. Fallback to local synchronous generator
  return generateCmWhatsappMessage(record);
}
