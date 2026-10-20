import { GoogleGenAI, Type } from '@google/genai';
import { ProcedureResult, SelectedProcedure, InpatientApprovalRecord, ApprovalGranularStatus } from '../types';
import { cleanContractorName, normalizeArabic, normalizeText } from '../lib/arabic-normalizer';
import { generateCmWhatsappMessage } from '../lib/whatsapp-generator';

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
  // If initialServices is empty or generic, but a procedure was extracted from reply, add it
  const effectiveServices = [...input.initialServices];
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
    const cleanS = srv.name.trim().toLowerCase();

    for (const cand of input.candidatePricelistRows) {
      const eng = (cand.nameEnglish || '').toLowerCase();
      const ara = (cand.nameArabic || '').toLowerCase();
      if (eng === cleanS || ara === cleanS || (cleanS.length > 4 && (eng.includes(cleanS) || cleanS.includes(eng)))) {
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
    .map((p) => ` - ${p.serviceName}`)
    .join('\n');

  let suggestedDraftReply = `Price list: Elite Hospital ${year}
Contractor: ${input.contractor}
المسئول من قسم السيلز: ${officer}
Corporate Email: corporate@elitehospital.org
 
الإجراءات المتواجدة بلائحة أسعار التعاقد:
${matchedLines || 'لا توجد إجراءات مطابقة مباشرة باللائحة'}`;

  if (unmatchedLines) {
    suggestedDraftReply += `\n\n[⚠️ لم يتم العثور على الإجراءات التالية في لائحة أسعار التعاقد:\n${unmatchedLines}]`;
  }
  suggestedDraftReply += `\n\n@corporate@elitehospital.org`;

  const cmWhatsappMessage = generateCmWhatsappMessage({
    patientName: input.patientName,
    bed: input.bed || '',
    contractorNormalized: input.contractor,
    contractorRaw: input.contractor,
    requestedServices: effectiveServices,
    matchedProcedures,
    diagnosis: input.diagnosis,
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
  if (!key) {
    return analyzeThreadWithHeuristics(input);
  }

  const ai = new GoogleGenAI({ apiKey: key });

  // Format thread messages chronologically
  const messagesFormatted = input.threadMessages
    .map((m, idx) => {
      return `--- [Message ${idx + 1}] ---
From: ${m.sender}
Date: ${m.date}
Subject: ${m.subject}
Content:
${m.body.trim().slice(0, 1500)}
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
    .map((s, idx) => `[Srv ${idx}]: "${s.name}" (Price: ${s.rawPrice})`)
    .join('\n');

  const promptText = `You are a Senior Hospital Contracting & Insurance AI Specialist at Elite Hospital.
Analyze the following inpatient approval request email thread and extract structured operational and financial intelligence.

<PatientAndContractorInfo>
Patient Name: "${input.patientName}"
MRN: "${input.mrn}"
Bed: "${input.bed || 'Inpatient'}"
Contractor / Insurance Company: "${input.contractor}"
Diagnosis / Clinical Notes: "${input.diagnosis}"
Price List Year: "${input.priceListYear === 'Cash' ? '2026' : (input.priceListYear || '2026')}"
Contractor Officer: "${input.contractorOfficer || 'غير محدد'}"
</PatientAndContractorInfo>

<RequestedServices>
${servicesFormatted}
</RequestedServices>

<EmailThreadHistoryChronological>
${messagesFormatted || 'No prior email messages. Only initial HIS approval form.'}
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

4. CLINICAL PROCEDURE MATCHING:
   - For each requested service [Srv 0, 1...], identify which Candidate ID from <CandidatePricelistRows> matches it best. If none match clinically, use -1.
   - Clinical rule: TEE (Transesophageal Echocardiography) must NEVER match standard surface Echo (TTE).

5. OFFICIAL RESPONSE & CM WHATSAPP DRAFTING:
   - suggestedDraftReply: Professional corporate email draft in Arabic/English responding to the latest thread state.
   - cmWhatsappMessage: Exactly 3 lines for Case Management:
     Line 1: *${input.patientName}*${input.bed ? ` - ${input.bed.startsWith('Bed') || input.bed.startsWith('Observation') || input.bed.startsWith('ICU') ? input.bed : `Bed ${input.bed}`}` : ''}
     Line 2: ${input.contractor}
     Line 3:
       - If approved: *تمت الموافقة على: <Procedure Name in Arabic/English> (حد أقصى: <limit>)*
       - If pending: *المطلوب موافقة <action verb: عمل / سحب تحليل / إجراء> <Procedure Name in Arabic with English>*

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

  const candidateModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  for (const model of candidateModels) {
    try {
      const response = await Promise.race([
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
      ]);

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
        isAutoReply: Boolean(parsed.isAutoReply),
        suggestedDraftReply: parsed.suggestedDraftReply || '',
        cmWhatsappMessage: parsed.cmWhatsappMessage || '',
      };
    } catch (err: any) {
      console.warn(`[Unified AI Agent] Model ${model} failed:`, err?.message || err);
      if (err?.message?.includes('403') || err?.message?.includes('PERMISSION_DENIED')) {
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
4. ONLY select candidates that truly match the requested procedure by their numeric [ID]. If no candidate is an appropriate clinical match, omit it.
5. Return a JSON array with 'candidateId' (integer ID) and 'requestedProcedureName' (exact requested English name). If none match, return an empty array [].`;

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
  const candidateModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastError: any = null;

  for (const model of candidateModels) {
    try {
      // 8-second timeout per model attempt to prevent UI hangs
      const response = await Promise.race([
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
      ]);

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
      const msg = err?.message || String(err);
      console.warn(`Gemini model ${model} failed, trying fallback:`, msg);

      // If it's a 403 (Permission denied / Invalid API key), don't retry models as the key is rejected
      if (
        msg.includes('403') ||
        msg.includes('API key not valid') ||
        msg.includes('PERMISSION_DENIED')
      ) {
        throw new Error(
          'Gemini API Key rejected (403 Permission Denied). Please verify that your API key is active and has access to Gemini in Google AI Studio.'
        );
      }
      // If it's a 429 quota exhausted, inform user
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
        throw new Error(
          'Gemini API rate limit or quota exceeded (429). Please wait a few moments and try again.'
        );
      }
    }
  }

  throw lastError || new Error('Failed to query Gemini AI model.');
}

/**
 * Extracts ONLY specific medical procedures, tests, or surgeries from unstructured doctor notes or clinical narratives using Gemini AI.
 * Strips clinical history, tumor details, symptoms, patient backstory, and doctor names.
 */
export async function extractProceduresFromTextWithAI(clinicalText: string): Promise<string[]> {
  const key = getGeminiApiKey();
  if (!key || !clinicalText || clinicalText.trim().length === 0) {
    return [];
  }

  const ai = new GoogleGenAI({ apiKey: key });

  const promptText = `You are a medical records extraction specialist at Elite Hospital.
Given the following doctor note or clinical email text, extract ONLY the specific medical procedure(s), test(s), investigation(s), or surgery requested for approval.

Doctor Note / Clinical Text:
"""
${clinicalText.trim()}
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

  const candidateModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  for (const model of candidateModels) {
    try {
      const response = await Promise.race([
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
      ]);

      const parsed = JSON.parse(response.text || '[]');
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch (err) {
      console.warn(`[AI Procedure Extract] Model ${model} failed:`, err);
    }
  }

  return [];
}

/**
 * Generates an optimized, professional 3-line Case Manager WhatsApp message using Gemini AI.
 */
export async function generateCmWhatsappWithAI(record: InpatientApprovalRecord): Promise<string> {
  const key = getGeminiApiKey();
  if (!key) {
    throw new Error('Gemini API key is not configured.');
  }

  const ai = new GoogleGenAI({ apiKey: key });

  const patient = (record.patientName || 'المريض').trim();
  const bed = (record.bed || '').trim();
  const rawContractor = (record.contractorNormalized || record.contractorRaw || 'التعاقد').trim();
  const contractor = cleanContractorName(rawContractor) || rawContractor;

  const servicesList = (record.requestedServices || []).map((s) => s.name).join(' | ');
  const matchedList = (record.matchedProcedures || []).map((m) => m.matchedName || m.serviceName).join(' | ');
  const details = record.diagnosis || '';

  const isApproved =
    record.status === 'approved' ||
    record.status === 'conditionally_approved' ||
    Boolean(record.hasExistingApproval);

  const limitText =
    record.creditLimitText ||
    (record.creditLimit ? `${record.creditLimit.toLocaleString('en-US')} EGP` : '');

  const promptText = `You are a medical Case Management assistant at Elite Hospital.
Generate a concise, standardized 3-line WhatsApp message for the Case Manager (CM).

Patient details:
- Patient Name: "${patient}"
- Bed / Location: "${bed}"
- Contractor: "${contractor}"
- Requested services / clinical notes: "${servicesList || matchedList || details}"
- Status: ${isApproved ? 'APPROVED' : 'PENDING APPROVAL'}
- Credit Limit: ${limitText || 'None'}

Format strictly as exactly 3 lines:
Line 1: *${patient}*${bed ? ` - ${bed.startsWith('Bed') || bed.startsWith('ICU') || bed.startsWith('Observation') ? bed : `Bed ${bed}`}` : ''}
Line 2: ${contractor}
${
  isApproved
    ? `Line 3: *تمت الموافقة على: <Procedure Name in Arabic with English if available>${limitText ? ` (حد أقصى: ${limitText})` : ''}*`
    : `Line 3: *المطلوب موافقة <action verb> <Procedure Name in Arabic with English if available>*`
}

Rules:
1. Extract ONLY the requested medical procedure/investigation/surgery. Do NOT include clinical history, reasons for request, patient symptoms, or doctor names.
2. If already approved, Line 3 MUST state "*تمت الموافقة على: ...*" with the credit limit.
3. If pending approval, select the correct Arabic action prefix for Line 3:
   - "سحب تحليل ..." for laboratory tests / blood samples (e.g. "سحب تحليل هرمون الغدة الجار درقية (PTH - Parathormone)").
   - "عمل أشعة ..." or "عمل ..." for radiology/imaging/scans (e.g. "عمل أشعة رنين على المخ بالصبغة (MRI Brain With Contrast)").
   - "عمل ..." or "إجراء ..." for surgeries, endoscopies, and clinical procedures (e.g. "عمل شق حنجري بالمنظار بالسرير (Bed Side Endoscopic Tracheostomy)").
   - "تركيب ..." for catheters or orthotics/braces (e.g. "تركيب دعامة للقدم والكاحل (Ankle Foot Orthosis)").
4. Output ONLY the 3 lines with asterisks for bolding lines 1 and 3 as specified. No greetings, markdown code fences, or explanations.`;

  const candidateModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  for (const model of candidateModels) {
    try {
      const response = await Promise.race([
        ai.models.generateContent({
          model,
          contents: [{ parts: [{ text: promptText }] }],
          config: {
            temperature: 0.1,
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout querying Gemini')), 6000)
        ),
      ]);

      const text = (response.text || '').replace(/^```[\w]*\s*/i, '').replace(/```$/i, '').trim();
      const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
      if (lines.length >= 3) {
        return lines.slice(0, 3).join('\n');
      }
    } catch (err) {
      console.warn(`[AI CM WhatsApp] Model ${model} failed:`, err);
    }
  }

  throw new Error('All Gemini models failed for CM WhatsApp generation.');
}
