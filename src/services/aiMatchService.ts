import { GoogleGenAI, Type } from '@google/genai';
import { ProcedureResult, SelectedProcedure, InpatientApprovalRecord, ApprovalGranularStatus } from '../types';
import { cleanContractorName, normalizeArabic, normalizeText, expandMedicalSynonyms, hasAntibodyConflict, hasLabInvestigationConflict, cleanHisProcedureQuery } from '../lib/arabic-normalizer';
import { generateCmWhatsappMessage } from '../lib/whatsapp-generator';
import { redactPhiFromText, assertZeroDemographics, KnownDemographics } from '../lib/deidentifier';
import { parseDoctorNarrative, translateDoctorIndication, ParsedDoctorNarrative } from '../lib/doctorNarrativeParser';
import {
  isQuotaPaused,
  markQuotaPaused,
  RECOMMENDED_GEMINI_MODELS,
  executeWithRateLimitRetry,
} from '../lib/geminiRateLimiter';

export const GEMINI_STORAGE_KEY = 'elite_gemini_api_key';

export interface UnifiedThreadInput {
  patientName: string;
  mrn: string;
  bed?: string;
  admissionType?: string;
  contractor: string;
  contractorOfficer?: string;
  priceListYear?: string;
  diagnosis: string;
  initialServices: Array<{ name: string; rawPrice: number }>;
  threadMessages: Array<{
    sender: string;
    date: string;
    subject: string;
    body: string;
    isReply: boolean;
  }>;
  candidatePricelistRows: Array<{
    id: number;
    nameEnglish: string;
    nameArabic?: string;
    sectionName?: string;
  }>;
}

export interface UnifiedThreadOutput {
  status: ApprovalGranularStatus;
  statusReasonArabic: string;
  patientSharePercentage: number | null;
  approvedAmountLimit: number | null;
  coverageConditions: string;
  confidenceScore?: number;
  extractedOfficerHint?: string;
  extractedClinicalIndication?: string;
  isAutoReply?: boolean;
  executiveSummaryArabic: string;
  matchedProcedures: Array<{
    serviceName: string;
    matchedName: string;
    code?: string;
    status: 'matched' | 'unmatched';
  }>;
  suggestedDraftReply: string;
  cmWhatsappMessage: string;
}

/**
 * Deterministic fallback heuristic engine for analyzing approval threads
 * when Gemini API key is missing, network is offline, or rate-limited.
 * Strictly respects thread chronology: later approval messages supersede earlier inquiries.
 */
export function analyzeThreadWithHeuristics(input: UnifiedThreadInput): UnifiedThreadOutput {
  // Sort messages strictly chronologically (oldest to newest)
  const sortedMessages = [...input.threadMessages].sort((a, b) => {
    const tA = new Date(a.date).getTime() || 0;
    const tB = new Date(b.date).getTime() || 0;
    return tA - tB;
  });

  const allText = sortedMessages.map((m) => `${m.subject} ${m.body}`).join('\n');

  // 1. Detect Co-Payment / Deductible %
  let patientSharePercentage: number | null = null;
  const copayMatch =
    allText.match(/(?:تحمل|نسبة التحمل|تحمل المريض|co-?pay|copayment)\s*[:\s]*(\d{1,2})\s*%/i) ||
    allText.match(/(\d{1,2})\s*%\s*(?:تحمل|نسبة التحمل)/i);
  if (copayMatch) {
    patientSharePercentage = parseInt(copayMatch[1], 10);
  }

  // 2. Detect Approved Monetary Cap / Limit across all messages
  let approvedAmountLimit: number | null = null;
  const capMatch =
    allText.match(/(?:الحد\s*الأقصى\s*(?:لهذه\s*الموافقة|للموافقة)?|بحد\s*أقصى|سقف|موافقة\s*سعرية\s*بمبلغ|cap|limit)\s*[:\s]*([\d,]+(?:\.\d+)?)\s*(?:الف|ألف)?\s*(?:جنيه|ج\.م|egp|le)?/i) ||
    allText.match(/([\d,]+(?:\.\d+)?)\s*(?:الف|ألف)\s*جنيه/i) ||
    allText.match(/(?:بحد أقصى|سقف|مبلغ|بمبلغ|قيمة|حد مالي)\s*[:\s]*([\d,]+(?:\.\d+)?)\s*(?:جنيه|ج\.م|egp|le)?/i);

  if (capMatch) {
    let rawNum = parseFloat(capMatch[1].replace(/,/g, ''));
    if (capMatch[0].includes('الف') || capMatch[0].includes('ألف')) {
      if (rawNum < 1000) rawNum *= 1000;
    }
    if (!isNaN(rawNum) && rawNum > 0) {
      approvedAmountLimit = rawNum;
    }
  }

  // 3. Inspect Chronological Messages for latest stance
  let hasApproval = false;
  let hasRefusal = false;
  let hasPendingInfo = false;
  let approvalSnippet = '';
  let procedureInReply = '';
  let pendingDetails = '';
  let extractedOfficerHint = '';
  let detectedAutoReply = false;

  for (const m of sortedMessages) {
    const text = `${m.subject} ${m.body}`.replace(/<[^>]+>/g, ' ');
    const isReply = m.isReply || /^(re|رد|fw|fwd)\s*:/i.test((m.subject || '').trim());
    const isSubstantive =
      isReply ||
      m.sender.toLowerCase().includes('approval') ||
      m.sender.toLowerCase().includes('contract') ||
      !m.sender.toLowerCase().includes('notifications@');

    if (!isSubstantive) continue;

    // 0. Filter out Automated Out-of-Office (OOO) and delivery notifications
    const isOoo = /(?:out\s*of\s*office|automatic\s*reply|رد\s*تلقائي|إجازة\s*سنوية|اجازة\s*سنوية|undeliverable|delivery\s*status\s*notification)/i.test(text);
    if (isOoo) {
      detectedAutoReply = true;
      continue;
    }

    // Attempt to extract sender officer/signature hint
    const sigMatch = text.match(/(?:مع\s*تحيات|تحياتي|regards|thanks\s*&?\s*regards|best\s*regards)[\s,:*-]+([^\n\r,]+)/i) ||
      text.match(/(?:دكتور|د\.|dr\.|أ\.|ا\/|مسئول\s*الموافقات)[\s:]+([^\n\r,]+)/i);
    if (sigMatch && sigMatch[1] && sigMatch[1].trim().length > 2) {
      extractedOfficerHint = sigMatch[1].trim().slice(0, 40);
    }

    // Check for procedure explicitly named in an approval reply
    const procMatch = text.match(
      /(?:لا\s*مانع\s*من\s*(?:الدخول[^\n\r:،,-]{0,35})?(?:ل[إا]جراء|لعمل|وعمل)|الموافقة\s*على\s*(?:عمل|إجراء|اجراء)?)\s*[:\s]*([^\n\r،,-]+?)(?=\s*(?:-|–|تحت|بحد|الحد|شامل|مع|فقط|$))/i
    );
    if (procMatch && procMatch[1] && procMatch[1].trim().length > 3) {
      const p = procMatch[1].trim();
      if (!p.toLowerCase().includes('inpatient') && !p.toLowerCase().includes('clinical evaluation')) {
        procedureInReply = p;
      }
    }

    // Anti-Naive Regex: Detect explicit negation
    const isNegated = /(?:cannot\s*approve|can\s*not\s*approve|not\s*approved|غير\s*معتمد|لا\s*يمكن(?:نا)?\s*الموافقة|نعتذر\s*عن\s*الموافقة|نعتذر\s*عن\s*عدم\s*الموافقة|غير\s*مغط[ىاه]|صعوبة\s*الموافقة|مرفوض|رفض|لم\s*تتم\s*الموافقة|لا\s*نوافق|خارج\s*التغطية)/i.test(text);

    // Single-word / short approval confirmations
    const isShortApproval = /(?:^|\s)(?:ok|تم|موافقين|معتمد|done)(?:$|[\s!.]+)/i.test(text.trim());

    const isApp = !isNegated && (
      /(?:لا\s*مانع|approved|\bapprove\b|معتمد|موافقة\s*سعرية|تمت\s*الموافقة|موافقة\s*باللائحة|يضاف\s*عل[يى]\s*الفاتور[ةه]|موافق\s*على)/i.test(text) ||
      isShortApproval
    );
    const isRef = isNegated || /(?:مرفوض|رفض|not\s*approved|rejected|خارج\s*التغطية)/i.test(text);
    const isPend = !isApp && /(?:يرجى\s*موافاتنا|برجاء\s*ارسال|مطلوب\s*تقرير|استيفاء|افادتنا\s*بـ?|يرجى\s*تزويدنا|مطلوب\s*صور[ةه]|please\s*provide|not\s*approved\s*until)/i.test(text);

    if (isApp) {
      hasApproval = true;
      hasRefusal = false; // Superseded by subsequent approval!
      hasPendingInfo = false; // Prior inquiries superseded by approval!
      approvalSnippet = text.substring(0, 150);
    } else if (isRef && !hasApproval) {
      hasRefusal = true;
      hasPendingInfo = false;
    } else if (isPend && !hasApproval) {
      hasPendingInfo = true;
      pendingDetails = text.substring(0, 120);
    }
  }

  // 4. Determine Final Granular Status & Clean Conditions
  let status: ApprovalGranularStatus = 'new_request';
  let statusReasonArabic = 'طلب جديد وارد من السيستم قيد المتابعة';
  let coverageConditions = '';

  const hasSubstantiveReplies = sortedMessages.some((m) => {
    if (!m.isReply) return false;
    const txt = `${m.subject} ${m.body}`;
    return !/(?:out\s*of\s*office|automatic\s*reply|رد\s*تلقائي|إجازة\s*سنوية|اجازة\s*سنوية|undeliverable|delivery\s*status\s*notification)/i.test(txt);
  });

  if (hasApproval) {
    status = 'approved';
    coverageConditions = ''; // Never ask for missing reports if already approved!
    statusReasonArabic = `تمت الموافقة واعتماد الحالة${approvedAmountLimit ? ` بحد أقصى ${approvedAmountLimit.toLocaleString('en-US')} ج.م` : ' باللائحة'}`;
  } else if (hasRefusal) {
    status = 'refused';
    coverageConditions = '';
    statusReasonArabic = 'تم رصد رفض أو عدم تغطية للإجراء من قبل جهة التعاقد';
  } else if (hasPendingInfo) {
    status = 'pending_information';
    const pendingNotes: string[] = [];
    if (/تقرير طبي|تقرير معالج|medical report/i.test(pendingDetails)) pendingNotes.push('مطلوب تقرير طبي مفصل');
    if (/باثولوجي|pathology|عينة/i.test(pendingDetails)) pendingNotes.push('مطلوب تقرير باثولوجي');
    if (/رسم قلب|ecg|echo|ايكو|إيكو/i.test(pendingDetails)) pendingNotes.push('مطلوب رسم قلب/إيكو');
    if (/اشعة|أشعة|x-ray|ct|mri|رنين/i.test(pendingDetails)) pendingNotes.push('مطلوب تقرير الأشعة');
    coverageConditions = pendingNotes.join(' - ') || 'مطلوب استيفاء تقارير أو فحوصات إضافية';
    statusReasonArabic = 'مطلوب استيفاء تقارير أو فحوصات إضافية من شركة التأمين';
  } else if (hasSubstantiveReplies) {
    status = 'pending_manual_draft';
    coverageConditions = '';
    statusReasonArabic = 'توجد ردود ومحادثة جارية على الإيميل تتطلب مراجعة منسق السيلز';
  } else {
    status = 'new_request';
    coverageConditions = '';
    statusReasonArabic = 'طلب جديد بانتظار رد جهة التعاقد';
  }

  // 5. Match Procedures against candidate rows
  // Decompose any doctor narrative services into clean requested items and clinical indication
  let extractedClinicalIndication = '';
  if (input.diagnosis && input.diagnosis !== 'Clinical Inpatient Evaluation') {
    extractedClinicalIndication = translateDoctorIndication(input.diagnosis);
  }

  const effectiveServices: Array<{ name: string; rawPrice: number }> = [];
  for (const srv of input.initialServices) {
    const narrative = parseDoctorNarrative(srv.name);
    if (narrative.clinicalIndicationAr && !narrative.clinicalIndicationAr.includes('قيد المتابعة')) {
      if (!extractedClinicalIndication) {
        extractedClinicalIndication = narrative.clinicalIndicationAr;
      }
    }
    if (narrative.cleanServices.length > 0) {
      for (const cs of narrative.cleanServices) {
        effectiveServices.push({
          name: cs.name,
          rawPrice: cs.rawPrice ?? srv.rawPrice,
        });
      }
    } else {
      effectiveServices.push(srv);
    }
  }

  if (
    effectiveServices.length === 0 ||
    effectiveServices.every((s) => s.name.toLowerCase().includes('evaluation'))
  ) {
    if (procedureInReply) {
      effectiveServices.unshift({
        name: procedureInReply,
        rawPrice: 0,
      });
    }
  }

  const matchedProcedures: Array<{ serviceName: string; matchedName: string; status: 'matched' | 'unmatched' }> = [];
  for (const srv of effectiveServices) {
    let matchedItem: any = null;
    const cleanS = cleanHisProcedureQuery(srv.name).trim().toLowerCase();
    const cleanSNorm = normalizeText(cleanS);
    const synonyms = expandMedicalSynonyms(srv.name).map((s) => s.toLowerCase());

    for (const cand of input.candidatePricelistRows) {
      const eng = (cand.nameEnglish || '').toLowerCase();
      const ara = (cand.nameArabic || '').toLowerCase();
      const engNorm = normalizeText(cand.nameEnglish || '');
      const araNorm = normalizeArabic(cand.nameArabic || '');

      // Strict Immunoglobulin Isotype conflict protection (e.g. IgG vs IgA)
      if (hasAntibodyConflict(srv.name, eng) || hasAntibodyConflict(srv.name, ara)) {
        continue;
      }

      // Strict Laboratory investigation modality conflict protection (e.g. CSF culture vs CSF analysis)
      if (hasLabInvestigationConflict(srv.name, eng) || hasLabInvestigationConflict(srv.name, ara)) {
        continue;
      }

      const isSynMatch = synonyms.some((syn) => {
        if (syn.length < 3) return false;
        if (syn.length <= 4) {
          return new RegExp(`\\b${syn}\\b`, 'i').test(eng) || new RegExp(`\\b${syn}\\b`, 'i').test(ara);
        }
        return eng.includes(syn) || ara.includes(syn);
      });

      if (
        eng === cleanS ||
        ara === cleanS ||
        (cleanSNorm && engNorm === cleanSNorm) ||
        (cleanSNorm && (engNorm.includes(cleanSNorm) || cleanSNorm.includes(engNorm))) ||
        isSynMatch ||
        (cleanS.length > 4 && (eng.includes(cleanS) || cleanS.includes(eng)))
      ) {
        matchedItem = cand;
        break;
      }
    }

    if (matchedItem) {
      const displayName = matchedItem.nameArabic
        ? `${matchedItem.nameArabic} (${matchedItem.nameEnglish})`
        : matchedItem.nameEnglish;
      matchedProcedures.push({
        serviceName: srv.name,
        matchedName: displayName,
        status: 'matched',
      });
    } else {
      matchedProcedures.push({
        serviceName: srv.name,
        matchedName: srv.name,
        status: 'unmatched',
      });
    }
  }

  // 6. Build Executive Summary (Accurate, Chronological, & Conclusive)
  let executiveSummaryArabic = `طلب موافقة للمريض ${input.patientName} (${input.contractor}).`;
  if (status === 'approved') {
    const procMention = procedureInReply ? ` على إجراء (${procedureInReply})` : '';
    const limitMention = approvedAmountLimit ? ` بحد أقصى ${approvedAmountLimit.toLocaleString('en-US')} ج.م` : ' باللائحة';
    executiveSummaryArabic += ` تمت الموافقة${procMention}${limitMention}. الحالة معتمدة ومكتملة ولا توجد متطلبات ناقصة.`;
  } else if ((status as string) === 'conditionally_approved') {
    executiveSummaryArabic += ` تمت الموافقة بشروط: ${approvedAmountLimit ? `سقف مالي ${approvedAmountLimit.toLocaleString('en-US')} ج.م` : ''} ${patientSharePercentage !== null ? `بنسبة تحمل ${patientSharePercentage}%` : ''}. ${coverageConditions ? `(${coverageConditions})` : ''}`.trim();
  } else if (status === 'pending_information') {
    executiveSummaryArabic += ` جهة التعاقد تطلب استيفاء بيانات/تقارير (${coverageConditions || 'تقرير طبي'}) قبل البت في الموافقة.`;
  } else if (status === 'refused') {
    executiveSummaryArabic += ` تم رفض تغطية الإجراء من قبل جهة التأمين.`;
  } else if (hasSubstantiveReplies) {
    executiveSummaryArabic += ` توجد مراسلات متبادلة على الإيميل بانتظار التأكيد النهائي.`;
  } else {
    executiveSummaryArabic += ` تم إرسال الطلب الأصلي وبانتظار رد جهة التعاقد.`;
  }

  // 7. Draft reply & CM WhatsApp
  const year = input.priceListYear === 'Cash' ? '2026' : (input.priceListYear || '2026');
  const officer = input.contractorOfficer || 'مسئول السيلز المختص';
  const matchedLines = matchedProcedures
    .filter((p) => p.status === 'matched')
    .map((p, idx) => `${idx + 1}- ${p.matchedName}`)
    .join('\n');
  const unmatchedLines = matchedProcedures
    .filter((p) => p.status === 'unmatched')
    .map((p) => ` - ${p.serviceName}${(p as any).suggestedPrice ? ` : مطلوب موافقة سعرية بمبلغ ${Number((p as any).suggestedPrice).toLocaleString('en-US')} ج.م` : ''}`)
    .join('\n');

  let suggestedDraftReply = `Price list: Elite Hospital ${year}
Contractor: ${input.contractor}
المسئول من قسم السيلز: ${officer}
Corporate Email: corporate@elitehospital.org
 
الإجراءات المتواجدة بلائحة أسعار التعاقد:
${matchedLines || 'لا توجد إجراءات مطابقة مباشرة باللائحة'}`;

  if (unmatchedLines) {
    suggestedDraftReply += `\n\n[⚠️ الإجراءات التالية غير مدرجة في لائحة أسعار التعاقد (مطلوب موافقة سعرية):\n${unmatchedLines}]`;
  }
  suggestedDraftReply += `\n\n@corporate@elitehospital.org`;

  const cmWhatsappMessage = generateCmWhatsappMessage({
    patientName: input.patientName,
    bed: input.bed || '',
    contractorNormalized: input.contractor,
    contractorRaw: input.contractor,
    requestedServices: effectiveServices,
    matchedProcedures,
    diagnosis: extractedClinicalIndication || input.diagnosis,
    status,
    hasExistingApproval: status === 'approved',
    creditLimit: approvedAmountLimit,
    creditLimitText: approvedAmountLimit ? `${approvedAmountLimit.toLocaleString('en-US')} EGP` : undefined,
    existingApprovalSnippet: approvalSnippet || procedureInReply,
  } as any);

  return {
    status,
    statusReasonArabic,
    patientSharePercentage,
    approvedAmountLimit,
    coverageConditions,
    confidenceScore: hasApproval || hasRefusal ? 0.92 : hasPendingInfo ? 0.88 : 0.75,
    extractedOfficerHint: extractedOfficerHint || undefined,
    extractedClinicalIndication: extractedClinicalIndication || undefined,
    isAutoReply: detectedAutoReply,
    executiveSummaryArabic,
    matchedProcedures,
    suggestedDraftReply,
    cmWhatsappMessage,
  };
}

/**
 * Unified Contextual AI Agent (Gemini):
 * Reads full chronological email thread history, reasons over true approval/refusal state,
 * extracts deep financial terms (co-pay %, cap in EGP), reformulates clinical text into standardized
 * procedures against contract pricelists, produces an executive Arabic context summary,
 * and generates tailored email drafts and CM WhatsApp messages in a single pass.
 */
export async function analyzeThreadWithUnifiedAI(input: UnifiedThreadInput): Promise<UnifiedThreadOutput> {
  const key = getGeminiApiKey();
  if (!key || isQuotaPaused()) {
    return analyzeThreadWithHeuristics(input);
  }

  const ai = new GoogleGenAI({ apiKey: key });

  const knownDemo: KnownDemographics = {
    patientName: input.patientName,
    mrn: input.mrn,
    bed: input.bed,
  };

  // Format thread messages chronologically with PHI redaction
  const messagesFormatted = input.threadMessages
    .map((m, idx) => {
      const sanitizedBody = redactPhiFromText(m.body, knownDemo).trim().slice(0, 1500);
      const sanitizedSubject = redactPhiFromText(m.subject, knownDemo);
      return `--- [Message ${idx + 1}] ---
Sender: Insurance/Hospital Staff
Date: ${m.date}
Subject: ${sanitizedSubject}
Content:
${sanitizedBody}
------------------------`;
    })
    .join('\n\n');

  // Format candidate pricelist rows (lean indexed format)
  const candidateRowsFormatted = input.candidatePricelistRows
    .slice(0, 30)
    .map((c) => {
      const ar = c.nameArabic ? ` | Ar: ${c.nameArabic}` : '';
      const sec = c.sectionName ? ` | Sec: ${c.sectionName}` : '';
      return `[ID: ${c.id}] ${c.nameEnglish}${ar}${sec}`;
    })
    .join('\n');

  const servicesFormatted = input.initialServices
    .map((s, idx) => `[Srv ${idx}]: "${redactPhiFromText(s.name, knownDemo)}" (Price: ${s.rawPrice})`)
    .join('\n');

  const sanitizedDiagnosis = redactPhiFromText(input.diagnosis || '', knownDemo);

  const promptText = `You are a Senior Hospital Contracting & Insurance AI Specialist at Elite Hospital.
Analyze the following de-identified inpatient approval request email thread and extract structured operational and financial intelligence.

<ContractContext>
Contractor / Insurance Company: "${input.contractor}"
Price List Year: "${input.priceListYear === 'Cash' ? '2026' : (input.priceListYear || '2026')}"
Clinical Specialty / Indication: "${sanitizedDiagnosis || 'Inpatient admission'}"
</ContractContext>

<RequestedServices>
${servicesFormatted}
</RequestedServices>

<EmailThreadHistoryChronological>
${messagesFormatted || 'No prior email messages. Only initial approval request.'}
</EmailThreadHistoryChronological>

<CandidatePricelistRows>
${candidateRowsFormatted || 'No pricelist candidates provided.'}
</CandidatePricelistRows>

YOUR TASKS:
1. STATUS DETERMINATION & CHRONOLOGY RULE (CRITICAL):
   - Strictly analyze the thread CHRONOLOGICALLY from oldest to newest.
   - The thread status is determined strictly by the LATEST substantive message from Approvals / Insurance Company.
   - If an earlier email asked for medical reports or x-rays, but a subsequent reply says "لا مانع من الدخول..." or "approved", the case is 'approved'. Prior inquiries or requests for documentation are considered SUPERSEDED and RESOLVED.
   - Standard closing boilerplate (e.g. "ويرجى موافاتنا بالتكلفة التقديرية محدثة في حالة الاحتياج لمد الاقامة أو رفع الحد الاقصى" or "مع موافاتنا بكافة الفحوصات والتكلفة التقديرية في حالة الاحتياج لرفع الحد الاقصى أو مد الاقامة") is NOT a blocking condition! It is standard corporate closing text. Set status to 'approved' and approvedAmountLimit to the numeric limit.
   - 'approved': Completely approved, or approved with a monetary cap / credit limit (e.g. "الحد الأقصى لهذه الموافقة 85 الف جنيه" -> 85000).
   - 'conditionally_approved': ONLY used when there is an active, unfulfilled mandatory condition (e.g. deductible deposit required first, or specific pre-authorization needed). Do NOT use if already approved.
   - 'partially_approved': Some procedures are approved, while others are excluded or refused.
   - 'pending_information': Insurance's LATEST reply is actively waiting for clinical reports, pathology, or labs before making a decision.
   - 'refused': Denied, not covered, or rejected.
   - 'new_request': Initial request sent, no reply received yet.

2. FINANCIAL & TERMS EXTRACTION:
   - patientSharePercentage: Integer (e.g. 10 for 10% co-payment/تحمل). Use -1 if not mentioned.
   - approvedAmountLimit: Numeric monetary cap in EGP (e.g. 45000 or 85000) if specified (e.g. "الحد الأقصى لهذه الموافقة 85 الف جنيه" -> 85000, "الحد الأقصى للموافقة 45 الف جنيه" -> 45000). Use -1 if not capped.
   - coverageConditions: Must be empty string "" if the case is approved! Only populate if actively pending unfulfilled clinical reports.

3. EXECUTIVE CONTEXT SUMMARY (Arabic):
   - A concise 2-sentence Arabic summary synthesizing the final state.
   - If approved: state clearly that the procedure/admission is approved with the credit limit, and that the case is confirmed with no missing requirements.

4. CLINICAL PROCEDURE & DOCTOR NARRATIVE MATCHING:
   - DOCTOR NARRATIVE DECONSTRUCTION: When requested services contain unstructured clinical narratives (e.g. "patient had bilateral lower limb weakness due to diabetes and hx of strokes and on physiotherapy sessions" or "المريضة تعاني من ارتفاع في درجة الحرارة و تحتاج الي مد فترة حجزها لعمل التحاليل... مع عمل اشعة مقطعية علئ المخ"), you MUST extract:
     a) The actual medical procedure requested (e.g. "Physiotherapy Sessions" or "Stay Extension" or "Laparoscopic Appendectomy").
     b) The clinical indication in Arabic (الداعي الطبي) (e.g. "المريض يعاني من ضعف بالطرفين السفليين بسبب مرض داء السكري ، مع تاريخ مرضي من الجلطات") and populate extractedClinicalIndication.
   - For each requested service [Srv 0, 1...], identify which Candidate ID from <CandidatePricelistRows> matches it best. If none match clinically, use -1.
   - Clinical rule: TEE (Transesophageal Echocardiography) must NEVER match standard surface Echo (TTE).
   - IMMUNOGLOBULIN SPECIFICITY (CRITICAL): IgA, IgG, IgM, IgE are distinct antibodies and must NEVER match a different isotype. For example, Tissue transglutaminase (IgG) must NEVER match Tissue transglutaminase (IgA). Anti-DGP IgG must NEVER match Anti-DGP IgA.
   - DISTINCT LABORATORY TESTS: Tissue transglutaminase (tTG) is completely distinct from Anti-Deaminated gluten peptide (anti-DGP). Calprotectin in stool, ANA (IFA), and Anti-DNA (d.s) are distinct diagnostic investigations.
   - DISTINCT CSF & MICROBIOLOGY INVESTIGATIONS (CRITICAL):
     * CSF culture is microbiological culture (must NEVER match CSF analysis).
     * CSF analysis (Chemistry & cell count) is routine chemical/cytological fluid count.
     * PCR panel for Meningitis, CSF (Bacterial & Viral) is multiplex molecular PCR panel.
     * Lactate, CSF is specific biochemical measurement of cerebrospinal fluid lactate.
     * Gram stain is direct microscopy stain.
     * Cytology for fluids is dedicated cytopathological cell study.
     NEVER assign 'CSF analysis (Chemistry & cell count)' to culture, PCR panel, lactate, gram stain, or cytology! Each test must map to its own exact candidate. NEVER collapse multiple different tests into a single candidate row!

5. OFFICIAL RESPONSE & CM WHATSAPP DRAFTING:
   - suggestedDraftReply: Professional corporate email draft in Arabic/English responding to the latest thread state.
   - cmWhatsappMessage: Case Management WhatsApp message format:
     Line 1: *${input.patientName}*${input.bed ? ` - ${input.bed.startsWith('Bed') || input.bed.startsWith('Observation') || input.bed.startsWith('ICU') ? input.bed : `Bed ${input.bed}`}` : ''}
     Line 2: ${input.contractor}
     Line 3:
       - If approved: *تمت الموافقة على: <Procedure Name in Arabic/English> (حد أقصى: <limit>)*
       - If pending: *المطلوب موافقة <action verb: عمل / سحب تحليل / إجراء / تركيب / جلسات> <Procedure Name in Arabic with English>*
       - If the approval is a price approval ("موافقة سعرية بمبلغ X"): NEVER say "الحد الأقصى" / "سقف" / "حد أقصى"; write *تمت الموافقة على: <Procedure> - موافقة سعرية بمبلغ X*
       - If someone must bring/make a price approval ("إحضار / عمل موافقة سعرية بمبلغ X"): write *مطلوب موافقة سعرية بمبلغ X على: <Procedure>*
     Line 4 (if clinical indication exists): الداعي الطبي: <Clinical Indication in Arabic>

6. RESILIENCE & EDGE CASE RULES:
   - Automated Out of Office (OOO) / System auto-replies: Set isAutoReply to true. Do NOT treat OOO as a clinical or operational decision!
   - Forwarded chains: When an email is forwarded (e.g. 'FYI', 'Forwarded message'), extract the decision from the internal quoted text of the insurance company.
   - Vague single-word replies: 'ok', 'done', 'تم', 'معتمد', 'موافق' -> 'approved'. 'no', 'مرفوض', 'لا' -> 'refused'.
   - Negations: 'cannot approve', 'not approved', 'لا يمكننا الموافقة', 'غير مغطى', 'Not approved until X' MUST NEVER be classified as approved.
   - Officer Signature Extraction: If the email signature/sign-off mentions a name or officer (e.g. 'Regards, Dr. Tarek' or 'مسئول الموافقات / ديانا'), extract it into extractedOfficerHint.
   - Confidence Score: Return a realistic confidenceScore between 0.0 and 1.0 (e.g. 0.95 for clear approvals, 0.65 for ambiguous threads).`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      status: {
        type: Type.STRING,
        enum: ['approved', 'conditionally_approved', 'partially_approved', 'pending_information', 'refused', 'new_request'],
        description: 'The overall operational approval status.',
      },
      statusReasonArabic: {
        type: Type.STRING,
        description: 'Brief 1-line Arabic explanation of why this status was determined.',
      },
      patientSharePercentage: {
        type: Type.INTEGER,
        description: 'Patient co-insurance or deductible % (e.g. 0, 10, 20). Return -1 if not mentioned.',
      },
      approvedAmountLimit: {
        type: Type.NUMBER,
        description: 'Approved monetary limit in EGP if mentioned. Return -1 if not capped.',
      },
      coverageConditions: {
        type: Type.STRING,
        description: 'Prerequisites, required reports, or restrictions.',
      },
      confidenceScore: {
        type: Type.NUMBER,
        description: 'Confidence score between 0.0 and 1.0.',
      },
      extractedOfficerHint: {
        type: Type.STRING,
        description: 'Name of the officer or signatory extracted from the email signature, or empty string.',
      },
      extractedClinicalIndication: {
        type: Type.STRING,
        description: 'The extracted clinical indication in Arabic (الداعي الطبي) explaining the symptoms/diagnosis for this approval request, or empty string.',
      },
      isAutoReply: {
        type: Type.BOOLEAN,
        description: 'True if the latest email is an automated out-of-office or delivery failure notification.',
      },
      executiveSummaryArabic: {
        type: Type.STRING,
        description: 'A 2-3 sentence clear Arabic executive summary.',
      },
      matchedProcedureIndices: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            requestedIndex: { type: Type.INTEGER },
            candidateId: { type: Type.INTEGER },
          },
          required: ['requestedIndex', 'candidateId'],
        },
      },
      suggestedDraftReply: {
        type: Type.STRING,
        description: 'Official corporate draft reply.',
      },
      cmWhatsappMessage: {
        type: Type.STRING,
        description: 'Standardized 3-line Case Manager WhatsApp message.',
      },
    },
    required: [
      'status',
      'statusReasonArabic',
      'patientSharePercentage',
      'approvedAmountLimit',
      'coverageConditions',
      'executiveSummaryArabic',
      'matchedProcedureIndices',
      'suggestedDraftReply',
      'cmWhatsappMessage',
    ],
  };

  // PHI De-identification Guardrail Assertion
  const demoCheck = assertZeroDemographics(promptText, knownDemo);
  if (!demoCheck.isClean) {
    console.error('[PHI Violation Intercepted] Demographics detected in outgoing prompt:', demoCheck.violations);
    throw new Error(`De-identification check failed: ${demoCheck.violations.join('; ')}`);
  }

  const candidateModels = RECOMMENDED_GEMINI_MODELS;
  for (const model of candidateModels) {
    try {
      const response = await executeWithRateLimitRetry(
        () => Promise.race([
          ai.models.generateContent({
            model,
            contents: [{ parts: [{ text: promptText }] }],
            config: {
              temperature: 0,
              responseMimeType: 'application/json',
              responseSchema,
            },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout querying Gemini model ${model}`)), 12000)
          ),
        ]),
        { maxRetries: 1, initialDelayMs: 400 }
      );

      const parsed = JSON.parse(response.text || '{}');
      if (!parsed.status) {
        continue;
      }

      // Reconstruct matched procedures
      const matchedProcedures: Array<{ serviceName: string; matchedName: string; status: 'matched' | 'unmatched' }> = [];
      const matchMap = new Map<number, number>();
      if (Array.isArray(parsed.matchedProcedureIndices)) {
        for (const item of parsed.matchedProcedureIndices) {
          matchMap.set(item.requestedIndex, item.candidateId);
        }
      }

      input.initialServices.forEach((srv, idx) => {
        const candId = matchMap.get(idx);
        const cand = typeof candId === 'number' && candId >= 0 ? input.candidatePricelistRows.find((c) => c.id === candId) : null;
        if (cand) {
          const displayName = cand.nameArabic
            ? `${cand.nameArabic} (${cand.nameEnglish})`
            : cand.nameEnglish;
          matchedProcedures.push({
            serviceName: srv.name,
            matchedName: displayName,
            status: 'matched',
          });
        } else {
          matchedProcedures.push({
            serviceName: srv.name,
            matchedName: srv.name,
            status: 'unmatched',
          });
        }
      });

      return {
        status: parsed.status as ApprovalGranularStatus,
        statusReasonArabic: parsed.statusReasonArabic || '',
        patientSharePercentage: parsed.patientSharePercentage !== -1 ? parsed.patientSharePercentage : null,
        approvedAmountLimit: parsed.approvedAmountLimit !== -1 ? parsed.approvedAmountLimit : null,
        coverageConditions: parsed.coverageConditions || '',
        executiveSummaryArabic: parsed.executiveSummaryArabic || '',
        matchedProcedures,
        confidenceScore: typeof parsed.confidenceScore === 'number' ? parsed.confidenceScore : 0.95,
        extractedOfficerHint: parsed.extractedOfficerHint ? String(parsed.extractedOfficerHint).trim() : undefined,
        extractedClinicalIndication: parsed.extractedClinicalIndication ? String(parsed.extractedClinicalIndication).trim() : undefined,
        isAutoReply: Boolean(parsed.isAutoReply),
        suggestedDraftReply: parsed.suggestedDraftReply || '',
        cmWhatsappMessage: parsed.cmWhatsappMessage || '',
      };
    } catch (err: any) {
      const msg = (err?.message || String(err)).toLowerCase();
      console.warn(`[Unified AI Agent] Model ${model} failed:`, err?.message || err);
      if (msg.includes('429') || msg.includes('resource_exhausted')) {
        markQuotaPaused(45000);
      }
      if (msg.includes('403') || msg.includes('permission_denied') || msg.includes('api key not valid')) {
        break; // API key is rejected; fallback to heuristics
      }
    }
  }

  // Graceful fallback to deterministic heuristic analysis
  return analyzeThreadWithHeuristics(input);
}

/**
 * Retrieves the Gemini API key from localStorage, import.meta.env, or process.env.
 */
export function getGeminiApiKey(): string {
  if (typeof window !== 'undefined') {
    const local = localStorage.getItem(GEMINI_STORAGE_KEY);
    if (local && local.trim().length > 0) {
      return local.trim();
    }
  }

  const envVite = typeof import.meta !== 'undefined' ? (import.meta as any).env?.VITE_GEMINI_API_KEY : '';
  if (envVite && typeof envVite === 'string' && envVite.trim().length > 0) {
    return envVite.trim();
  }

  const envProcess = typeof process !== 'undefined' ? (process.env?.GEMINI_API_KEY || process.env?.VITE_GEMINI_API_KEY) : '';
  if (envProcess && typeof envProcess === 'string' && envProcess.trim().length > 0) {
    return envProcess.trim();
  }

  return '';
}

/**
 * Persists the user's Gemini API key to localStorage.
 */
export function setGeminiApiKey(key: string): void {
  if (typeof window !== 'undefined') {
    if (key.trim()) {
      localStorage.setItem(GEMINI_STORAGE_KEY, key.trim());
    } else {
      localStorage.removeItem(GEMINI_STORAGE_KEY);
    }
  }
}

/**
 * Checks whether a valid Gemini API key is configured.
 */
export function isGeminiConfigured(): boolean {
  return getGeminiApiKey().length > 10;
}

/**
 * Executes AI semantic procedure matching against candidates with model fallback.
 * Uses compact index-based prompt format and candidateId response schema for ultra-fast generation.
 */
export async function matchProceduresWithAI(
  unmatchedProcedures: SelectedProcedure[],
  candidates: ProcedureResult[]
): Promise<ProcedureResult[]> {
  const key = getGeminiApiKey();

  // Local candidate heuristic fallback helper
  const runLocalCandidateMatching = (): ProcedureResult[] => {
    const matches: ProcedureResult[] = [];
    for (const proc of unmatchedProcedures) {
      const qNorm = normalizeArabic(normalizeText(proc.name));
      const qWords = qNorm.split(/\s+/).filter((w) => w.length > 2);
      let bestCand: ProcedureResult | null = null;
      let maxOverlap = 0;

      for (const cand of candidates) {
        const cNorm = normalizeArabic(normalizeText(`${cand.nameEnglish} ${cand.nameArabic || ''}`));
        let overlap = 0;
        for (const w of qWords) {
          if (cNorm.includes(w)) overlap++;
        }
        if (overlap > maxOverlap) {
          maxOverlap = overlap;
          bestCand = cand;
        }
      }

      if (bestCand && maxOverlap > 0) {
        matches.push({
          ...bestCand,
          requestedProcedureName: proc.name,
        });
      }
    }
    return matches;
  };

  if (!key) {
    throw new Error(
      "Gemini API key is not configured. Please click 'AI Settings' in the top header to enter your API key, or set GEMINI_API_KEY in .env.local."
    );
  }

  if (unmatchedProcedures.length === 0) {
    return [];
  }

  if (candidates.length === 0) {
    throw new Error(
      "No candidate pricelist items could be identified for AI semantic matching. Try broadening your search query."
    );
  }

  if (isQuotaPaused()) {
    console.warn('[Gemini AI] Quota currently paused due to rate limits (429), using local candidate fallback.');
    return runLocalCandidateMatching();
  }

  const ai = new GoogleGenAI({ apiKey: key });

  const proceduresListText = unmatchedProcedures
    .map(
      (p, idx) =>
        `${idx + 1}. English: "${p.name}"${p.arabic ? ` / Arabic: "${p.arabic}"` : ''}`
    )
    .join('\n');

  // Compact indexed text: eliminates multi-kilobyte JSON syntax overhead
  const candidatesLines = candidates
    .map((c, idx) => {
      const arPart = c.nameArabic ? ` | Ar: ${c.nameArabic}` : '';
      const secPart = c.sectionName ? ` | Sec: ${c.sectionName}` : '';
      return `[${idx}] ${c.nameEnglish}${arPart}${secPart}`;
    })
    .join('\n');

  const promptText = `You are an expert AI medical assistant for Elite Hospital.
Below is a numbered list of candidate pricing rows from the hospital's official pricelists:

<CandidatePricelist>
${candidatesLines}
</CandidatePricelist>

Match each of the following requested clinical procedures with the pricing rows above:
${proceduresListText}

STRICT CLINICAL EXTRACTION RULES:
1. Handle clinical abbreviations with or without dots (e.g., "EEG" matches "ELECTROENCEPHALOGRAPHY (EEG)", "ECG" matches "Electrocardiogram").
2. Handle synonyms and common clinical variations (e.g., "Echo" matches "Echocardiography").
3. Transesophageal Echocardiography is TEE or T.E.E (موجات فوق صوتية على القلب عن طريق المريء / إيكو بالمنظار). It is an endoscopic cardiac procedure that must NEVER be matched with standard surface Echocardiography (TTE). Only match TEE with Transesophageal Echocardiography.
4. IMMUNOGLOBULIN SPECIFICITY: IgA, IgG, IgM, IgE are distinct antibodies and must NEVER match a different isotype (e.g. IgG must NEVER match IgA, and IgA must NEVER match IgG).
5. DISTINCT CLINICAL TESTS: Tissue transglutaminase is distinct from Anti-Deaminated gluten peptide (anti-DGP). Calprotectin, ANA, and Anti-DNA are completely distinct tests. Never collapse different tests into a single candidate!
6. ONLY select candidates that truly match the requested procedure by their numeric [ID]. If no candidate is an appropriate clinical match, omit it.
7. Return a JSON array with 'candidateId' (integer ID) and 'requestedProcedureName' (exact requested English name). If none match, return an empty array [].`;

  // Lean response schema: LLM outputs only the numeric index and requested name (~15-30 tokens)
  const responseSchema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        candidateId: {
          type: Type.INTEGER,
          description:
            'The numeric index [0, 1, 2...] of the matching candidate row from CandidatePricelist.',
        },
        requestedProcedureName: {
          type: Type.STRING,
          description:
            "The exact English name from the prompt's requested list that this candidate belongs to.",
        },
      },
      required: ['candidateId', 'requestedProcedureName'],
    },
  };

  // Try candidate models in order: gemini-2.5-flash -> gemini-2.0-flash -> gemini-1.5-flash
  // PHI De-identification Guardrail Assertion
  const demoCheck = assertZeroDemographics(promptText);
  if (!demoCheck.isClean) {
    console.error('[PHI Violation Intercepted] Demographics detected in outgoing prompt:', demoCheck.violations);
    throw new Error(`De-identification check failed: ${demoCheck.violations.join('; ')}`);
  }

  const candidateModels = RECOMMENDED_GEMINI_MODELS;
  let lastError: any = null;

  for (const model of candidateModels) {
    try {
      // 8-second timeout per model attempt to prevent UI hangs
      const response = await executeWithRateLimitRetry(
        () => Promise.race([
          ai.models.generateContent({
            model,
            contents: [
              {
                parts: [{ text: promptText }],
              },
            ],
            config: {
              temperature: 0, // Deterministic greedy search for maximum speed
              responseMimeType: 'application/json',
              responseSchema,
            },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout querying Gemini model ${model}`)), 8000)
          ),
        ]),
        { maxRetries: 1, initialDelayMs: 300 }
      );

      const parsed = JSON.parse(response.text || '[]') as Array<{
        candidateId: number;
        requestedProcedureName: string;
      }>;

      // Reconstruct full ProcedureResult objects instantly in memory with 100% data fidelity
      const matches: ProcedureResult[] = [];
      const seenMatch = new Set<string>();

      for (const item of parsed) {
        if (
          typeof item.candidateId === 'number' &&
          item.candidateId >= 0 &&
          item.candidateId < candidates.length
        ) {
          const cand = candidates[item.candidateId];
          const matchKey = `${cand.nameEnglish}|${cand.sourceFile}|${cand.price}|${item.requestedProcedureName}`;
          if (!seenMatch.has(matchKey)) {
            seenMatch.add(matchKey);
            matches.push({
              ...cand,
              requestedProcedureName: item.requestedProcedureName,
            });
          }
        }
      }

      return matches;
    } catch (err: any) {
      lastError = err;
      const msg = (err?.message || String(err)).toLowerCase();
      console.warn(`Gemini model ${model} failed, trying fallback:`, msg);

      // If it's a 403 (Permission denied / Invalid API key), don't retry models as the key is rejected
      if (
        msg.includes('403') ||
        msg.includes('api key not valid') ||
        msg.includes('permission_denied')
      ) {
        throw new Error(
          'Gemini API Key rejected (403 Permission Denied). Please verify that your API key is active and has access to Gemini in Google AI Studio.'
        );
      }
      // If it's a 429 quota exhausted, pause quota and allow next model attempt
      if (msg.includes('429') || msg.includes('resource_exhausted')) {
        markQuotaPaused(45000);
      }
    }
  }

  // If all models failed due to 429 rate limit or quota pause, fall back safely to local candidate matching
  const is429 = (lastError?.message || '').toLowerCase().includes('429') ||
                (lastError?.message || '').toLowerCase().includes('resource_exhausted') ||
                isQuotaPaused();
  if (is429) {
    console.warn('[Gemini AI] Quota exhausted across models; returning local candidate matching.');
    return runLocalCandidateMatching();
  }

  throw lastError || new Error('Failed to query Gemini AI model.');
}

/**
 * Extracts ONLY specific medical procedures, tests, or surgeries from unstructured doctor notes or clinical narratives using Gemini AI.
 * Strips clinical history, tumor details, symptoms, patient backstory, and doctor names.
 */
export async function extractProceduresFromTextWithAI(clinicalText: string): Promise<string[]> {
  const localFallback = (): string[] => {
    if (!clinicalText || !clinicalText.trim()) return [];
    const parsed = parseDoctorNarrative(clinicalText);
    if (parsed.cleanServices && parsed.cleanServices.length > 0) {
      return parsed.cleanServices.map((s) => s.name);
    }
    if (parsed.primaryProcedure) {
      return [parsed.primaryProcedure];
    }
    return [clinicalText.trim()];
  };

  const key = getGeminiApiKey();
  if (!key || !clinicalText || clinicalText.trim().length === 0 || isQuotaPaused()) {
    return localFallback();
  }

  const ai = new GoogleGenAI({ apiKey: key });

  const sanitizedText = redactPhiFromText(clinicalText);

  const promptText = `You are a medical records extraction specialist at Elite Hospital.
Given the following de-identified doctor note or clinical email text, extract ONLY the specific medical procedure(s), test(s), investigation(s), or surgery requested for approval.

Doctor Note / Clinical Text:
"""
${sanitizedText.trim()}
"""

CRITICAL EXTRACTION RULES:
1. Extract ONLY the requested medical procedure name (in English and/or Arabic as written).
2. Completely EXCLUDE:
   - Patient history or backstory (e.g. "طفل يعانى من ورم", "المريض يعاني من سقوط بالقدم")
   - Clinical indications or reasons (e.g. "متابعة بعد استئصال الورم", "لحين الشفاء")
   - Doctor names or specialties (e.g. "استشاري المخ والاعصاب")
   - Symptoms or physical findings (e.g. "ضعف عام في الجزء الايسر")
3. If an explicit English procedure name or investigation is mentioned (e.g., "MRI BRAIN WITH CONTRAST", "Bed Side Endoscopic Tracheostomy", "ankle foot orthosis"), ALWAYS include it as the core procedure.
4. Return a JSON array of strings containing the extracted procedure names (e.g. ["MRI Brain With Contrast"]). If none found, return [].`;

  // PHI De-identification Guardrail Assertion
  const demoCheck = assertZeroDemographics(promptText);
  if (!demoCheck.isClean) {
    console.error('[PHI Violation Intercepted] Demographics detected in outgoing prompt:', demoCheck.violations);
    throw new Error(`De-identification check failed: ${demoCheck.violations.join('; ')}`);
  }

  const candidateModels = RECOMMENDED_GEMINI_MODELS;
  for (const model of candidateModels) {
    try {
      const response = await executeWithRateLimitRetry(
        () => Promise.race([
          ai.models.generateContent({
            model,
            contents: [{ parts: [{ text: promptText }] }],
            config: {
              temperature: 0,
              responseMimeType: 'application/json',
            },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout querying Gemini')), 6000)
          ),
        ]),
        { maxRetries: 1, initialDelayMs: 250 }
      );

      const parsed = JSON.parse(response.text || '[]');
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch (err: any) {
      const msg = (err?.message || String(err)).toLowerCase();
      if (msg.includes('429') || msg.includes('resource_exhausted')) {
        markQuotaPaused(45000);
      }
      console.warn(`[AI Procedure Extract] Model ${model} failed:`, err);
    }
  }

  return localFallback();
}

/**
 * Uses Gemini AI to deeply understand doctor clinical narratives, extracting both
 * clean procedures and the Arabic clinical indication (الداعي الطبي) with high medical reasoning.
 * Falls back safely to deterministic parser if offline or API key is unconfigured.
 */
export async function analyzeDoctorNarrativeWithAI(clinicalText: string): Promise<ParsedDoctorNarrative> {
  const local = parseDoctorNarrative(clinicalText);
  const key = getGeminiApiKey();
  if (!key || !clinicalText || clinicalText.trim().length === 0 || isQuotaPaused()) {
    return local;
  }

  const ai = new GoogleGenAI({ apiKey: key });
  const sanitizedText = redactPhiFromText(clinicalText);

  const promptText = `You are a clinical coding and medical necessity specialist at Elite Hospital.
Analyze the following doctor narrative note from an inpatient insurance approval request:

Clinical Note:
"""
${sanitizedText.trim()}
"""

Extract structured clinical intent:
1. primaryProcedure: The core requested medical procedure, surgery, investigation, or stay extension (in English/Arabic). Exclude patient history or symptoms.
2. secondaryProcedures: Any additional requested procedures, imaging, or stay extensions (array of strings).
3. clinicalIndicationAr: Formal medical indication and diagnosis in Arabic explaining why this procedure is necessary (e.g. "المريض يعاني من ضعف بالطرفين السفليين بسبب مرض داء السكري ، مع تاريخ مرضي من الجلطات").
4. urgency: "routine" | "urgent" | "emergency".
5. category: "surgery" | "radiology" | "laboratory" | "physiotherapy" | "rehabilitation" | "cardiology" | "stay_extension" | "procedure".

Return JSON only.`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      primaryProcedure: { type: Type.STRING },
      secondaryProcedures: { type: Type.ARRAY, items: { type: Type.STRING } },
      clinicalIndicationAr: { type: Type.STRING },
      urgency: { type: Type.STRING, enum: ['routine', 'urgent', 'emergency'] },
      category: {
        type: Type.STRING,
        enum: ['surgery', 'radiology', 'laboratory', 'physiotherapy', 'rehabilitation', 'cardiology', 'stay_extension', 'procedure'],
      },
    },
    required: ['primaryProcedure', 'secondaryProcedures', 'clinicalIndicationAr', 'urgency', 'category'],
  };

  const candidateModels = RECOMMENDED_GEMINI_MODELS;
  for (const model of candidateModels) {
    try {
      const response = await executeWithRateLimitRetry(
        () => Promise.race([
          ai.models.generateContent({
            model,
            contents: [{ parts: [{ text: promptText }] }],
            config: {
              temperature: 0,
              responseMimeType: 'application/json',
              responseSchema,
            },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout querying Gemini')), 6000)
          ),
        ]),
        { maxRetries: 1, initialDelayMs: 250 }
      );

      const parsed = JSON.parse(response.text || '{}');
      if (parsed.primaryProcedure) {
        const cleanServices: Array<{ name: string; rawPrice?: number }> = [
          { name: parsed.primaryProcedure, rawPrice: 0 },
        ];
        if (Array.isArray(parsed.secondaryProcedures)) {
          for (const s of parsed.secondaryProcedures) {
            cleanServices.push({ name: s, rawPrice: 0 });
          }
        }
        return {
          primaryProcedure: parsed.primaryProcedure,
          secondaryProcedures: Array.isArray(parsed.secondaryProcedures) ? parsed.secondaryProcedures : [],
          clinicalIndicationAr: parsed.clinicalIndicationAr || local.clinicalIndicationAr,
          urgency: parsed.urgency || local.urgency,
          category: parsed.category || local.category,
          hasMultipleProcedures: cleanServices.length > 1,
          cleanServices,
        };
      }
    } catch (err: any) {
      const msg = (err?.message || String(err)).toLowerCase();
      if (msg.includes('429') || msg.includes('resource_exhausted')) {
        markQuotaPaused(45000);
      }
      console.warn(`[AI Narrative Analysis] Model ${model} failed, using local fallback:`, err);
    }
  }

  return local;
}

/**
 * Generates an optimized, professional 3-line Case Manager WhatsApp message.
 * Formats strictly locally via deterministic template engine to eliminate PHI transmission over the wire.
 */
export async function generateCmWhatsappWithAI(record: InpatientApprovalRecord): Promise<string> {
  return generateCmWhatsappMessage(record);
}
