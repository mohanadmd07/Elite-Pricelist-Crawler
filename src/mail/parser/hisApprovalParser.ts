/**
 * HIS Approval Email Parser
 * Extracts clinical diagnosis, patient demographics, requested services, prices,
 * financial terms (credit limit / ceiling), refusal state, and replies.
 */

import * as cheerio from 'cheerio';
import { cleanContractorName, stripSentFromSignatures, extractRefusalReason } from '../../lib/arabic-normalizer';
import { extractCleanProcedurePhrase, extractClinicalIndication, translateClinicalIndicationToArabic } from '../../lib/whatsapp-generator';
import { parseDoctorNarrative, translateDoctorIndication } from '../../lib/doctorNarrativeParser';
import { ParsedApprovalEmail, RawMailMessage } from '../types';

export const REFUSAL_KEYWORDS = [
  'الحالة كاش',
  'الحاله كاش',
  'المريض كاش',
  'المريضة كاش',
  'المريضه كاش',
  'تم الرفض على السيستم',
  'تم الرفض على السستم',
  'تم الرفض علي السيستم',
  'تم الرفض علي السستم',
  'مرفوض على السيستم',
  'مرفوض علي السيستم',
  'مرفوض على السستم',
  'مرفوض علي السستم',
  'تم الرفض من جهة التعاقد',
  'تم الرفض',
  'تم رفض',
  'رفض الطلب',
  'رفض طلب',
  'طلب مرفوض',
  'مرفوض',
  'مرفوضة',
  'مرفوضه',
  'المتابعة الحسابية',
  'المتابعه الحسابيه',
  'برجاء المتابعة الحسابية',
  'برجاء المتابعه الحسابيه',
  'يتم التحصيل كاش لحين احضار موافقه',
  'يتم التحصيل كاش لحين احضار موافقة',
  'تحصيل كاش لحين احضار موافقه',
  'تحصيل كاش لحين احضار موافقة',
  'يتم التحصيل كاش',
  'التحصيل كاش',
  'تحصيل كاش',
  'غير مغطى برجاء ارسال الاهل للتغطيه',
  'غير مغطى برجاء ارسال الاهل للتغطية',
  'غير مغطى برجاء إرسال الأهل للتغطية',
  'غير مغطي برجاء ارسال الاهل للتغطيه',
  'غير مغطي برجاء ارسال الاهل للتغطية',
  'غير مغطي برجاء إرسال الأهل للتغطية',
  'غير مغطى برجاء ارسال الاهل',
  'غير مغطي برجاء ارسال الاهل',
  'غير مغطى برجاء إرسال الأهل',
  'غير مغطى',
  'غير مغطاه',
  'غير مغطاة',
  'غير مغطي',
  'غير مغطيه',
  'غير مغطية',
  'غير مغطي تامينيا',
  'غير مغطى تأمينيا',
  'غير مغطى تأمينياً',
  'غير مغطي تامنيا',
  'غير مغطى تامنيا',
  'غير مغطي تامينا',
  'الحاله غير مغطاه',
  'الحالة غير مغطاة',
  'الحالة غير مغطية',
  'جميع الاجراءات للحاله غير مغطاه',
  'جميع الإجراءات للحالة غير مغطاة',
  'لعدم مد الاقامه ورفع الحد الاقصي',
  'لعدم مد الإقامة ورفع الحد الأقصى',
  'لعدم مد الاقامه',
  'لعدم مد الإقامة',
  'لعدم رفع الحد الاقصي',
  'لعدم رفع الحد الأقصى',
  'كاش طرف الاهل',
  'كاش طرف الأهل',
  'كاش طرف المريض',
  'علي حساب المريض',
  'على حساب المريض',
  'توجيه الاهل للرسيبشن',
  'توجيه الأهل للريسبشن',
  'توجيه الاهل للرسيبشن للتغطيه',
  'توجيه الأهل للريسبشن للتغطية',
  'ارسال الاهل للحسابات',
  'إرسال الأهل للحسابات',
  'ارسال الاهل للحسابات للتغطيه',
  'إرسال الأهل للحسابات للتغطية',
  'ارسال الاهل للتغطيه',
  'إرسال الأهل للتغطية',
  'توجيه الاهل للتغطيه',
  'توجيه الأهل للتغطية',
  'قسم حسابات المرضي',
  'قسم حسابات المرضى',
  'توجيه اهل الحاله لقسم حسابات المرضي',
  'توجيه أهل الحالة لقسم حسابات المرضى',
  'حسابات المرضي',
  'حسابات المرضى',
  'معمل خارجي',
  'في معمل خارجي',
  'فى معمل خارجي',
  'تنسيق عمل التحليل طرف التعاقد والمريض في معمل خارجي',
  'طرف التعاقد والمريض في معمل خارجي',
  'رفض',
  'غير معتمد',
  'not approved',
  'rejected',
  'declined',
  'refused',
  'not covered',
  'denied',
  'نعتذر عن الموافقة',
  'نعتذر عن الموافقه',
  'خارج التغطية',
  'خارج التغطيه',
  'خارج التعاقد',
];

export const APPROVAL_KEYWORDS = [
  // Direct Arabic approvals
  'لا مانع',
  'لامانع',
  'لا مانع من الدخول',
  'لامانع من الدخول',
  'لا مانع من عمل اللازم',
  'لامانع من عمل اللازم',
  'لا مانع طبقا للتعاقد',
  'لامانع طبقا للتعاقد',
  'لا مانع من عمل العمليه',
  'لامانع من عمل العمليه',
  'لا مانع من عمل العملية',
  'لامانع من عمل العملية',
  'لا مانع من اجراء',
  'لامانع من اجراء',
  'لا مانع من تقديم',
  'لامانع من تقديم',
  'لا مانع وفقا للائحة',
  'لا مانع وفقا للائحه',
  'لا مانع حسب التعاقد',
  'لا مانع بأسعار التعاقد',
  'لا مانع باسعار التعاقد',

  // Attachments / Forwarded approvals
  'مرفق الموافقه',
  'مرفق الموافقة',
  'مرفق اليكم الموافقه',
  'مرفق اليكم الموافقة',
  'مرفق إليكم الموافقة',
  'مرفق إليكم الموافقه',
  'مرفق لسيادتكم الموافقة',
  'مرفق لسيادتكم الموافقه',
  'مرفق طيه الموافقة',
  'مرفق طيه الموافقه',
  'مرفق تقرير الموافقة',
  'مرفق تقرير الموافقه',
  'مرفق صورة الموافقة',
  'مرفق صوره الموافقه',
  'مرفق صوره الموافقة',

  // Price & contractual terms
  'الموافقة السعرية طرفى',
  'الموافقه السعريه طرفى',
  'الموافقة السعرية طرفنا',
  'الموافقه السعريه طرفنا',
  'الموافقة السعرية',
  'الموافقه السعريه',
  'موافقة سعرية',
  'موافقه سعريه',
  'تسعيرة سعرية',
  'تسعيره سعريه',
  'تسعيرة',
  'تسعيره',
  'تمت الموافقة',
  'تمت الموافقه',
  'تمت الموافقة على',
  'تمت الموافقه على',
  'تمت الموافقة علي',
  'تمت الموافقه علي',
  'الموافقة على',
  'الموافقه على',
  'الموافقة علي',
  'الموافقه علي',
  'موافقة باللائحة',
  'موافقه باللائحه',
  'بأسعار التعاقد',
  'باسعار التعاقد',
  'وفقا لتعليمات التشغيل',
  'وفقاً لتعليمات التشغيل',
  'طبقا للتعاقد',
  'طبقاً للتعاقد',
  'يضاف علي الفاتوره',
  'يضاف على الفاتورة',
  'بفاتوره الشراء',
  'بفاتورة الشراء',
  'معتمد',
  'موافق',
  'نحيطكم علما بالموافقة',
  'نحيطكم علما بالموافقه',

  // English approval keywords
  'approved',
  'approve',
  'approval granted',
  'approval confirmed',
  'kind regards',
];

export function decodeHtmlEntities(input: string): string {
  if (!input) return '';
  let str = input;
  // Multiple decode passes to handle double-encoded entities (e.g. &amp;nbsp;)
  for (let i = 0; i < 2; i++) {
    str = str
      .replace(/&#x0*d;/gi, '\r')
      .replace(/&#0*13;/g, '\r')
      .replace(/&#x0*a;/gi, '\n')
      .replace(/&#0*10;/g, '\n')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&#0*39;/g, "'")
      .replace(/&#x2F;/gi, '/')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&');
  }
  return str.replace(/&nbsp;/gi, ' ');
}

export function cleanTextFromHtml(input: string): string {
  if (!input) return '';
  const decoded = decodeHtmlEntities(input);
  return decoded
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts the clean reply body from an email, slicing off quoted replies,
 * Outlook header dividers, hr lines, and mobile signatures.
 */
export function extractCleanReplyBody(html?: string, text?: string): string {
  if (html) {
    const decoded = decodeHtmlEntities(html);
    let cleaned = decoded
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

    const separatorRegexes = [
      /<hr[\s>]/i,
      /<div[^>]*id=["\x27]?divRplyFwdMsg["\x27]?/i,
      /<div[^>]*id=["\x27]?ms-outlook-mobile-body-separator-line["\x27]?/i,
      /<div[^>]*class=["\x27]?gmail_quote["\x27]?/i,
      /<div[^>]*class=["\x27]?gmail_attr["\x27]?/i,
      /<blockquote[\s>]/i,
      /-----Original Message-----/i,
      /----- Original Message -----/i,
      /<b[^>]*>From:<\/b>/i,
      /<b[^>]*>Sent:<\/b>/i,
      /From:\s*HIS\s*Notifications/i,
      /From:\s*Approvals/i,
      /<b>من:<\/b>/i,
      /<b>أرسلت:<\/b>/i,
    ];

    let earliestIdx = cleaned.length;
    for (const r of separatorRegexes) {
      const match = cleaned.search(r);
      if (match !== -1 && match < earliestIdx) {
        earliestIdx = match;
      }
    }

    // If no separator matched, check if this is an original approval request email
    if (earliestIdx === cleaned.length) {
      const isInitialRequest =
        /Patient\s+Information/i.test(cleaned) ||
        /SELECTED\s+SERVICES/i.test(cleaned) ||
        /Patient\s+Barcode/i.test(cleaned) ||
        /Type:\s*Request/i.test(cleaned) ||
        /Category:\s*Approval/i.test(cleaned) ||
        /HIS\s*Notifications/i.test(cleaned);
      if (isInitialRequest) {
        return '';
      }
    }

    const topHtml = cleaned.substring(0, earliestIdx);
    const $ = cheerio.load(topHtml);
    let reply = $('body').text().replace(/\s+/g, ' ').trim();
    if (!reply) {
      reply = cleanTextFromHtml(topHtml);
    }
    reply = cleanTextFromHtml(reply);
    reply = reply
      .replace(/Get Outlook for (?:iOS|Android)/gi, '')
      .replace(/Sent from my (?:iPhone|iPad|Galaxy)/gi, '')
      .replace(/تم الإرسال من (?:هاتفي|Outlook)/gi, '')
      .trim();

    // Verify reply doesn't contain approval form boilerplate
    if (
      /Patient\s+Information/i.test(reply) ||
      /SELECTED\s+SERVICES/i.test(reply) ||
      /Type:\s*Request/i.test(reply)
    ) {
      return '';
    }

    if (reply.length > 0) return reply;
  }

  // Fallback to plain text
  const textSeparators = [
    /-----Original Message-----/i,
    /----- Original Message -----/i,
    /From:\s*[^\n\r]+Sent:/i,
    /On\s+.+wrote:/i,
    /Get Outlook for/i,
    /From:\s*HIS\s*Notifications/i,
    /From:\s*Approvals/i,
  ];

  let raw = text || '';
  let cut = raw.length;
  for (const sep of textSeparators) {
    const match = raw.search(sep);
    if (match !== -1 && match < cut) {
      cut = match;
    }
  }
  const candidate = cleanTextFromHtml(raw.substring(0, cut).trim());
  if (
    /Patient\s+Information/i.test(candidate) ||
    /SELECTED\s+SERVICES/i.test(candidate) ||
    /Type:\s*Request/i.test(candidate)
  ) {
    return '';
  }
  return candidate;
}

/**
 * Splits composite clinical requests (e.g. stay extension + procedure) into discrete procedure items.
 */
export function splitClinicalRequests(text: string): string[] {
  if (!text) return [];
  const parts = text
    .split(/\s*(?:مع\s+(?:عمل|إجراء|اجراء)|بالإضافة\s+إلى\s+(?:عمل|إجراء|اجراء)?|بالاضافة\s+الي\s+(?:عمل|إجراء|اجراء)?)\s*/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 2);
  return parts.length > 0 ? parts : [text.trim()];
}

export function extractCreditLimit(text: string): { limit?: number; formatted?: string } {
  if (!text) return {};
  const normalized = text.normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e]/g, ' ');

  const pattern =
    /(?:الحد\s+ال[اأإآ]قص[ىي]|بحد\s+[اأإآ]قص[ىي]|سقف\s+الموافق[ةه]|بمبلغ\s+لا\s+يتجاوز|في\s+حدود|موافق[ةه](?:\s+سعري[ةه])?\s+بمبلغ|معتمد\s+بمبلغ|لا\s+مانع(?:[^\d\n\r]{0,30})بمبلغ|تحصيل\s+مبلغ|مبلغ\s+(?:ت[اأإآ]مين\s+)?|(?:maximum\s+)?limit(?:\s+of)?|approved\s+limit|ceiling)(?:[^\d\n\r]{0,25})(\d+(?:[\.,]\d+)?)\s*(الف|ألف|الاف|آلاف|k)?/i;
  const match = normalized.match(pattern);
  if (match) {
    let num = parseFloat(match[1].replace(/,/g, ''));
    const unit = match[2]?.toLowerCase() || '';
    if (unit.includes('الف') || unit.includes('ألف') || unit.includes('الاف') || unit.includes('آلاف') || unit === 'k') {
      num = num * 1000;
    }
    if (!isNaN(num) && num > 0) {
      return {
        limit: num,
        formatted: `${num.toLocaleString('en-US')} EGP`,
      };
    }
  }

  return {};
}

export function extractCoPayment(text: string): { percentage?: number; formatted?: string } {
  if (!text) return {};
  const normalized = text.normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e]/g, ' ');

  const pattern =
    /(?:co-?payment(?:\s+of)?|co-?pay|copay|patient\s+share|تحمل(?:\s+المريض)?|نسبة(?:\s+ال)?تحمل)(?:[^\d\n\r%]{0,25})(\d+(?:\.\d+)?)\s*(?:%|بالمائة|بالمائه|في\s+الم(?:ي|ائ)ة)?/i;
  const match = normalized.match(pattern);
  if (match) {
    const val = parseFloat(match[1]);
    if (!isNaN(val) && val > 0 && val <= 100) {
      return {
        percentage: val,
        formatted: `${val}%`,
      };
    }
  }

  const revMatch = normalized.match(/(\d+(?:\.\d+)?)\s*%\s*(?:co-?pay(?:ment)?|تحمل)/i);
  if (revMatch) {
    const val = parseFloat(revMatch[1]);
    if (!isNaN(val) && val > 0 && val <= 100) {
      return {
        percentage: val,
        formatted: `${val}%`,
      };
    }
  }

  return {};
}

export interface ConditionalCoverageResult {
  isConditional: boolean;
  conditionText?: string;
  snippet?: string;
}

/**
 * Detects conditional approvals, exclusions, or time-limited coverage in replies:
 * 1. Exceptions: "ما عدا / ماعدا / باستثناء / عدا ... غير مغطى"
 * 2. Notes: "علما بان / بأن ... غير مغطى داخل المستشفى"
 * 3. Time limits: "الحالة مغطاة لمدة يوم واحد فقط من تاريخ الخروج من العناية"
 */
export function detectConditionalCoverage(text: string, cleanReply?: string): ConditionalCoverageResult {
  const target = cleanReply && cleanReply.trim().length > 0 ? cleanReply : text || '';
  if (!target.trim()) return { isConditional: false };

  const norm = target
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[إأآ]/g, 'ا')
    .replace(/ة/g, 'ه');

  // 1. Exception pattern: ما عدا / ماعدا / باستثناء / عدا ... غير مغطى
  const exceptMatch = norm.match(/(?:ماعدا|ما\s+عدا|باستثناء|عدا)\s+(.+?)(?:غير\s+مغط[ىياه]+|خارج\s+التغطي[ةه]|كاش|طرف\s+المريض)/i);
  if (exceptMatch) {
    const item = exceptMatch[1].trim();
    return {
      isConditional: true,
      conditionText: `ما عدا ${item.toUpperCase()} غير مغطى`,
      snippet: target.trim(),
    };
  }

  // 2. Note / Exclusion pattern: علما بان / علما بأن ... غير مغطى ...
  const noteMatch = norm.match(/علما\s+(?:بان|بان)\s+(.+?غير\s+مغط[ىياه]+.*?)(?:داخل\s+المستشف[ىي]|$|\.|\n)/i);
  if (noteMatch) {
    let cond = noteMatch[1].trim();
    if (!cond.includes('داخل المستشف')) {
      cond += ' داخل المستشفى';
    }
    return {
      isConditional: true,
      conditionText: cond,
      snippet: target.trim(),
    };
  }

  // 3. Limited coverage duration pattern: مغطاة لمدة ... فقط / مغطاة لمدة يوم واحد ...
  const durationMatch = norm.match(/(?:بان\s+)?(?:الحال[ةه]\s+)?مغط[ىياه]+\s+لمد[ةه]\s+(.+?)(?:$|\.|\n)/i);
  if (durationMatch) {
    return {
      isConditional: true,
      conditionText: `مغطاة لمدة ${durationMatch[1].trim()}`,
      snippet: target.trim(),
    };
  }

  return { isConditional: false };
}

export function detectRefusal(
  text: string,
  subject: string,
  cleanReply?: string
): { hasRefusal: boolean; snippet: string; reason?: string } {
  // CRITICAL: Check if this is a conditional coverage / partial exclusion instead of a flat refusal
  const conditional = detectConditionalCoverage(text, cleanReply);
  if (conditional.isConditional) {
    return { hasRefusal: false, snippet: '' };
  }

  // If cleanReply exists, prioritize checking it directly
  if (cleanReply && cleanReply.trim().length > 0) {
    const normReply = cleanReply.normalize('NFKC').toLowerCase().replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه');
    const normSubj = (subject || '').normalize('NFKC').toLowerCase().replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه');
    const replyTarget = `${normSubj} ${normReply}`;

    for (const kw of REFUSAL_KEYWORDS) {
      const kwNorm = kw.normalize('NFKC').toLowerCase().replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه');
      if (replyTarget.includes(kwNorm)) {
        return { hasRefusal: true, snippet: cleanReply.trim(), reason: extractRefusalReason(cleanReply) };
      }
    }
    return { hasRefusal: false, snippet: '' };
  }

  const normText = (text || '').normalize('NFKC');
  const normSubj = (subject || '').normalize('NFKC');
  const cleanBody = cleanTextFromHtml(normText);
  const cleanSubj = cleanTextFromHtml(normSubj);
  const combined = `${cleanSubj} ${cleanBody}`.trim();
  const normalized = combined
    .toLowerCase()
    .replace(/[إأآ]/g, 'ا')
    .replace(/ة/g, 'ه');

  for (const kw of REFUSAL_KEYWORDS) {
    const kwNorm = kw
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[إأآ]/g, 'ا')
      .replace(/ة/g, 'ه');

    const idx = normalized.indexOf(kwNorm);
    if (idx !== -1) {
      const start = Math.max(0, idx - 25);
      const end = Math.min(combined.length, idx + kw.length + 150);
      let snippet = stripSentFromSignatures(combined.substring(start, end)).trim();
      if (start > 0) snippet = '...' + snippet;
      if (end < combined.length) snippet = snippet + '...';

      return { hasRefusal: true, snippet, reason: extractRefusalReason(snippet) };
    }
  }

  return { hasRefusal: false, snippet: '' };
}

export function detectExistingApproval(
  text: string,
  subject: string,
  cleanReply?: string
): {
  hasApproval: boolean;
  snippet: string;
  creditLimit?: number;
  creditLimitText?: string;
  patientSharePercentage?: number;
  isConditional?: boolean;
  conditionText?: string;
} {
  // 0. Check conditional coverage first (e.g. exceptions or time limits)
  const conditional = detectConditionalCoverage(text, cleanReply);
  if (conditional.isConditional) {
    const credit = extractCreditLimit(cleanReply) || extractCreditLimit(text);
    const copay = extractCoPayment(cleanReply) || extractCoPayment(text);
    return {
      hasApproval: true,
      snippet: cleanReply?.trim() || conditional.snippet || '',
      isConditional: true,
      conditionText: conditional.conditionText,
      creditLimit: credit.limit,
      creditLimitText: credit.formatted,
      patientSharePercentage: copay.percentage,
    };
  }

  const refusalCheck = detectRefusal(text, subject, cleanReply);
  if (refusalCheck.hasRefusal) {
    return { hasApproval: false, snippet: '' };
  }

  // 1. If cleanReply exists, check cleanReply directly
  if (cleanReply && cleanReply.trim().length > 0) {
    const normReply = cleanReply
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[إأآ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/(?<![\u0600-\u06FF])لا\s*مانع/g, 'لا مانع');
    const credit = extractCreditLimit(cleanReply) || extractCreditLimit(text);
    const copay = extractCoPayment(cleanReply) || extractCoPayment(text);

    if (!/خارج\s*(?:ال)?تعاقد/.test(normReply)) {
      // Check attached approval pattern in cleanReply directly!
      const attachedMatch = normReply.search(/مرفق\s+(?:اليكم|إليكم|لسيادتكم|طيه|تقرير\s+|صورة\s+|صوره\s+)?(?:ال)?موافق/);
      if (attachedMatch !== -1) {
        return {
          hasApproval: true,
          snippet: cleanReply.trim(),
          creditLimit: credit.limit,
          creditLimitText: credit.formatted,
          patientSharePercentage: copay.percentage,
        };
      }

      const approvalSearchText = normReply
        .replace(
          /(?:الرجاء|رجاء|برجاء|نرجو|يرجي|يرجى|المطلوب|مطلوب|نطلب|طلب)\s+(?:من\s+سيادتكم\s+)?(?:ال)?موافق[ةه]?(?![\u0600-\u06FF])/g,
          ' '
        )
        .replace(
          /(?:يجب|سوف|سيتم|يتم|لاحضار|احضار|بإحضار|باحضار|عمل|اعمل|لعمل|برجاء\s+احضار)\s+(?:يتم\s+)?(?:احضار\s+)?(?:اصل\s+)?(?:ال)?موافق[ةه]?(?:\s+سعري[ةه])?(?![\u0600-\u06FF])/g,
          ' '
        );

      for (const kw of APPROVAL_KEYWORDS) {
        const kwNorm = kw
          .normalize('NFKC')
          .toLowerCase()
          .replace(/[إأآ]/g, 'ا')
          .replace(/ة/g, 'ه')
          .replace(/(?<![\u0600-\u06FF])لا\s*مانع/g, 'لا مانع');

        const idx =
          kwNorm === 'موافق'
            ? approvalSearchText.search(/(?<![\u0600-\u06FF])موافق(?![\u0600-\u06FF])/)
            : approvalSearchText.indexOf(kwNorm);
        if (idx !== -1) {
          return {
            hasApproval: true,
            snippet: cleanReply.trim(),
            creditLimit: credit.limit,
            creditLimitText: credit.formatted,
            patientSharePercentage: copay.percentage,
          };
        }
      }

      if (credit.limit) {
        return {
          hasApproval: true,
          snippet: cleanReply.trim(),
          creditLimit: credit.limit,
          creditLimitText: credit.formatted,
          patientSharePercentage: copay.percentage,
        };
      }
    }

    // Clean reply exists and has no approval -> do not bleed into older quoted thread history
    return { hasApproval: false, snippet: '' };
  }

  // 2. Fallback to full text scanning
  const normText = (text || '').normalize('NFKC');
  const normSubj = (subject || '').normalize('NFKC');
  const cleanBody = cleanTextFromHtml(normText);
  const cleanSubj = cleanTextFromHtml(normSubj);
  const combined = `${cleanSubj} ${cleanBody}`.trim();
  const normalized = combined
    .toLowerCase()
    .replace(/[إأآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/(?<![\u0600-\u06FF])لا\s*مانع/g, 'لا مانع');

  const credit = extractCreditLimit(combined);
  const copay = extractCoPayment(combined);

  if (/خارج\s*(?:ال)?تعاقد/.test(normalized)) {
    return { hasApproval: false, snippet: '' };
  }

  const approvalSearchText = normalized
    .replace(
      /(?:الرجاء|رجاء|برجاء|نرجو|يرجي|يرجى|المطلوب|مطلوب|نطلب|طلب)\s+(?:من\s+سيادتكم\s+)?(?:ال)?موافق[ةه]?(?![\u0600-\u06FF])/g,
      ' '
    )
    .replace(
      /(?:يجب|سوف|سيتم|يتم|لاحضار|احضار|بإحضار|باحضار|عمل|اعمل|لعمل|برجاء\s+احضار)\s+(?:يتم\s+)?(?:احضار\s+)?(?:اصل\s+)?(?:ال)?موافق[ةه]?(?:\s+سعري[ةه])?(?![\u0600-\u06FF])/g,
      ' '
    );

  const attachedIdx = approvalSearchText.search(/مرفق\s+(?:اليكم|إليكم|لسيادتكم|طيه|تقرير\s+|صورة\s+|صوره\s+)?(?:ال)?موافق/);
  if (attachedIdx !== -1) {
    const start = Math.max(0, attachedIdx - 25);
    const end = Math.min(combined.length, attachedIdx + 120);
    let snippet = stripSentFromSignatures(combined.substring(start, end)).trim();
    if (start > 0) snippet = '...' + snippet;
    return {
      hasApproval: true,
      snippet,
      creditLimit: credit.limit,
      creditLimitText: credit.formatted,
      patientSharePercentage: copay.percentage,
    };
  }

  for (const kw of APPROVAL_KEYWORDS) {
    const kwNorm = kw
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[إأآ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/(?<![\u0600-\u06FF])لا\s*مانع/g, 'لا مانع');

    const idx =
      kwNorm === 'موافق'
        ? approvalSearchText.search(/(?<![\u0600-\u06FF])موافق(?![\u0600-\u06FF])/)
        : approvalSearchText.indexOf(kwNorm);
    if (idx !== -1) {
      const start = Math.max(0, idx - 25);
      const end = Math.min(combined.length, idx + kw.length + 150);
      let snippet = stripSentFromSignatures(combined.substring(start, end)).trim();
      if (start > 0) snippet = '...' + snippet;
      if (end < combined.length) snippet = snippet + '...';

      return {
        hasApproval: true,
        snippet,
        creditLimit: credit.limit,
        creditLimitText: credit.formatted,
        patientSharePercentage: copay.percentage,
      };
    }
  }

  if (credit.limit && approvalSearchText === normalized) {
    return {
      hasApproval: true,
      snippet: stripSentFromSignatures(combined.substring(0, 150)).trim(),
      creditLimit: credit.limit,
      creditLimitText: credit.formatted,
      patientSharePercentage: copay.percentage,
    };
  }

  return { hasApproval: false, snippet: '' };
}

export function detectReplies(parsed: {
  subject: string;
  inReplyTo?: string;
  references?: string | string[];
  text?: string;
  html?: string | false;
  cleanReply?: string;
}): { hasReplies: boolean; snippet: string } {
  const subject = parsed.subject || '';
  const isReSubject = /^(re|رد|fw|fwd)\s*:/i.test(subject.trim());
  const hasInReplyTo = Boolean(parsed.inReplyTo);
  const hasReferences = Array.isArray(parsed.references)
    ? parsed.references.length > 0
    : Boolean(parsed.references);

  const rawContent = (parsed.text || '') + '\n' + (parsed.html || '');
  const hasQuotedMarkers =
    /-----Original Message-----/i.test(rawContent) ||
    /From:.*Sent:.*To:/is.test(rawContent) ||
    /On\s+.+wrote:/i.test(rawContent) ||
    /بتاريخ\s+.+كتب/i.test(rawContent) ||
    /id=["\x27]?divRplyFwdMsg["\x27]?/i.test(rawContent) ||
    /id=["\x27]?ms-outlook-mobile-body-separator-line["\x27]?/i.test(rawContent);

  if (isReSubject || hasInReplyTo || hasReferences || hasQuotedMarkers || (parsed.cleanReply && parsed.cleanReply.length > 0)) {
    if (parsed.cleanReply && parsed.cleanReply.length > 0) {
      return {
        hasReplies: true,
        snippet: parsed.cleanReply,
      };
    }

    let replySnippet = '';
    const cleanContent = cleanTextFromHtml(parsed.text || (parsed.html ? parsed.html : ''));
    const sentences = cleanContent.split(/[.\n\r]+/).map((s) => s.trim()).filter((s) => s.length > 4);

    for (const s of sentences) {
      if (
        !s.toLowerCase().includes('inpatient approval') &&
        !s.toLowerCase().includes('patient information') &&
        !s.toLowerCase().includes('selected services') &&
        !s.toLowerCase().includes('from:') &&
        !s.toLowerCase().includes('to:') &&
        !s.toLowerCase().includes('sent:') &&
        !s.toLowerCase().includes('subject:')
      ) {
        replySnippet = stripSentFromSignatures(s);
        if (replySnippet.length > 4) break;
      }
    }

    return {
      hasReplies: true,
      snippet: replySnippet ? `"${replySnippet}"` : '',
    };
  }

  return { hasReplies: false, snippet: '' };
}

/**
 * Parses raw HTML and subject of an approval email into structured clinical and financial fields.
 */
export function parseHisApprovalEmail(msg: RawMailMessage): ParsedApprovalEmail {
  const decodedHtml = decodeHtmlEntities(msg.htmlBody || msg.textBody || '');
  const $ = cheerio.load(decodedHtml);
  const fullText =
    $('body').text().replace(/\s+/g, ' ').trim() ||
    decodedHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // Extract MRN & Patient from Subject if available
  const subjectMatch = msg.subject.match(/(?:RE:\s*)?(?:\[URGENT\]\s*)?Inpatient Approval\s*-\s*(.+?)\s*\(MRN:\s*(\d+)\)/i);
  let patientName = subjectMatch ? subjectMatch[1].trim() : '';
  let mrn = subjectMatch ? subjectMatch[2].trim() : '';

  let admissionDate = '';
  let admissionType = 'Inpatient';
  let bed = 'Inpatient Bed';
  let physician = 'Hospital Staff';
  let contractorRaw = '';
  let diagnosis = '';
  let requestDetails = '';

  // 1. Iterate over HTML table rows
  $('tr').each((_, tr) => {
    const cells = $(tr).find('td, th');
    if (cells.length < 2) return;

    for (let i = 0; i < cells.length; i++) {
      const cellText = cells.eq(i).text().replace(/\s+/g, ' ').trim();
      const nextCell = i + 1 < cells.length ? cells.eq(i + 1) : null;
      const nextCellText = nextCell ? nextCell.text().replace(/\s+/g, ' ').trim() : '';

      if (!patientName && /^Patient(?:\s*Name)?\s*[:\s]*$/i.test(cellText) && nextCellText) {
        patientName = nextCellText;
      }
      if (!admissionDate && /^Admission(?:\s*Date)?\s*[:\s]*$/i.test(cellText) && nextCellText) {
        admissionDate = nextCellText;
      }
      if (/^(?:Admission|Visit)\s*Type\s*[:\s]*$/i.test(cellText)) {
        const fullRowText = $(tr).text();
        admissionType = fullRowText.includes('Inpatient') ? 'Inpatient' : 'Outpatient';
        const bedMatch = fullRowText.match(/Bed:\s*([^–\n<]+)/i);
        if (bedMatch) bed = bedMatch[1].replace(/Physician.*$/i, '').trim();
      }
      if ((!physician || physician === 'Hospital Staff') && /^Physician\s*[:\s]*$/i.test(cellText) && nextCellText) {
        physician = nextCellText;
      }
      if (
        !contractorRaw &&
        /^(?:Contractor(?:\s*Name)?|Company(?:\s*Name)?|Customer(?:\s*Name)?|جهة\s*التعاقد|الجهة\s*التعاقدية|اسم\s*الشركة|التعاقد|الشركة)\s*[:\s]*$/i.test(cellText) &&
        nextCellText
      ) {
        const cleaned = cleanContractorName(nextCellText);
        if (cleaned && cleaned.toLowerCase() !== 'contractor' && !cleaned.includes('مستشفى إيليت')) {
          contractorRaw = cleaned;
        }
      }
      if (!diagnosis && /^Diagnosis\s*[:\s]*$/i.test(cellText) && nextCellText) {
        diagnosis = nextCellText;
      }
    }
  });

  // 2. Iterate elements for inline key-value pairs
  $('td, th, p, div, span').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();

    if (!contractorRaw) {
      const cMatch = text.match(/^(?:Contractor(?:\s*Name)?|Company(?:\s*Name)?|جهة\s*التعاقد|الجهة\s*التعاقدية|اسم\s*الشركة)\s*[:\s]+(.+)$/i);
      if (cMatch) {
        const cleaned = cleanContractorName(cMatch[1]);
        if (cleaned && cleaned.toLowerCase() !== 'contractor' && !cleaned.includes('مستشفى إيليت')) {
          contractorRaw = cleaned;
        }
      }
    }

    if (!patientName) {
      const pMatch = text.match(/^Patient(?:\s*Name)?\s*[:\s]+(.+)$/i);
      if (pMatch) patientName = pMatch[1].trim();
    }
    if (!physician || physician === 'Hospital Staff') {
      const phMatch = text.match(/^Physician\s*[:\s]+(.+)$/i);
      if (phMatch) physician = phMatch[1].trim();
    }
    if (!diagnosis) {
      const dMatch = text.match(/^Diagnosis\s*[:\s]+(.+)$/i);
      if (dMatch) diagnosis = dMatch[1].trim();
    }
    if (!bed || bed === 'Inpatient Bed') {
      const bMatch = text.match(/Bed:\s*([^–\n<]+)/i);
      if (bMatch) bed = bMatch[1].replace(/Physician.*$/i, '').trim();
    }
    if (text.includes('Request Details')) {
      const container = $(el).closest('div, table').find('div, p, span').last().text().trim();
      if (container && container !== text) requestDetails = container;
    }
  });

  if (!requestDetails) {
    const rdMatch =
      fullText.match(/Request Details\s*[:\s]+([^<\n\r]+?)(?=\s*(?:SELECTED SERVICES|Patient|Contractor|Visit|Physician|Diagnosis|$))/i) ||
      decodedHtml.match(/Request Details\s*[:\s]+([^<\n\r]+?)(?=\s*(?:<br|<div|<p|<table|SELECTED|$))/i);
    if (rdMatch) requestDetails = rdMatch[1].trim();
  }

  // 3. Fallback regex extraction
  if (!patientName) {
    const pMatch =
      fullText.match(/Patient Name:\s*([^<\n\r]+?)(?=\s*(?:Contractor|Visit|Admission|Physician|Diagnosis|Bed|Request|Selected|جهة|الجهة|الرقم|$))/i) ||
      fullText.match(/(?:حاله|حالة)\s*[:\/]\s*([^<\n\r]+?)(?=\s*(?:Contractor|Visit|Admission|Physician|Diagnosis|Bed|Request|Selected|جهة|الجهة|الرقم|$))/i) ||
      fullText.match(/(?:اسم\s+المريض|اسم\s+الحال[ةه]|المريض|المريضة|المريضه|اسم\s+العميل)\s*[:\s]+([^<\n\r]+?)(?=\s*(?:جهة|الجهة|الرقم|التشخيص|Contractor|MRN|$))/i) ||
      decodedHtml.match(/(?:موافقة|طلب|موافقه)\s+(?:أشعة|اشعة|تحاليل|عمليات|رنين|منظار|إجراء|اجراء)\s*\/\s*([\u0600-\u06FF\s]{4,40})(?=\s*<br>|[\n\r<]|$)/i) ||
      decodedHtml.match(/(?:موافقة|طلب|موافقه)\s+(?:أشعة|اشعة|تحاليل|عمليات|رنين|منظار|إجراء|اجراء)\s*\/\s*(?:<br>|[\n\r]+)\s*([\u0600-\u06FF\s]{4,40})(?=\s*<br>|[\n\r<]|$)/i);
    if (pMatch) patientName = pMatch[1].replace(/(?:Contractor|Visit Type|MRN).*/i, '').trim();
  }

  if (!mrn) {
    const bMatch =
      fullText.match(/Patient Barcode:\s*(\d+)/i) ||
      fullText.match(/(?:MRN|الرقم الطبي)\s*[:\/\s]*(\d+)/i) ||
      msg.subject.match(/\(MRN:\s*(\d+)\)/i);
    if (bMatch) mrn = bMatch[1].trim();
  }

  if (!contractorRaw) {
    const cMatch =
      fullText.match(/Contractor(?:\s*Name)?\s*[:\s]+([^<\n\r]+?)(?=\s+(?:Visit|Admission|Physician|Diagnosis|Bed|Request|Selected|$))/i) ||
      fullText.match(/(?:جهة\s*التعاقد|الجهة\s*التعاقدية)\s*[:\s]+([^<\n\r]+?)(?=\s+(?:التشخيص|الطبيب|رقم|تاريخ|$))/i) ||
      fullText.match(/(?:^|[^\u0600-\u06FFa-zA-Z0-9])(نكست\s*كير|ميتلايف|جلوب\s*ميد|بوبا|اكسا|أكسا|الاهلي|الأهلي|ايثدكو|بترول|جاسكو|سوميد|بابتيكو|اموك|أموك|ويبكو|الرقابة\s*الاداريه|الرقابة\s*الإدارية|وزاره\s*العدل|وزارة\s*العدل|البريد\s*المصري)(?:[^\u0600-\u06FFa-zA-Z0-9]|$)/i);
    if (cMatch) {
      const candidate = cleanContractorName(cMatch[1].trim());
      if (candidate && candidate.toLowerCase() !== 'contractor' && !candidate.includes('مستشفى إيليت')) {
        contractorRaw = candidate;
      }
    }
  }

  if (!diagnosis) {
    const diagMatch = fullText.match(/Diagnosis[:\s]+([^\n\r<]+)/i);
    if (diagMatch) diagnosis = diagMatch[1].trim();
  }

  if (contractorRaw) {
    contractorRaw = cleanContractorName(contractorRaw);
  }

  // 4. Extract SELECTED SERVICES table rows
  const requestedServices: Array<{ name: string; rawPrice: number }> = [];

  $('tr').each((_, tr) => {
    const rowText = $(tr).text();
    const isExcluded =
      rowText.includes('Patient Name') ||
      rowText.includes('Admission Date') ||
      rowText.includes('Admission Type') ||
      rowText.includes('Physician') ||
      rowText.includes('Contractor') ||
      rowText.includes('Diagnosis') ||
      rowText.includes('Service Name') ||
      rowText.includes('TOTAL AMOUNT') ||
      rowText.includes('SELECTED SERVICES') ||
      rowText.includes('Bed:');

    if (!isExcluded) {
      const cells = $(tr).find('td');
      if (cells.length >= 2) {
        const srvName = cells.eq(0).text().trim();
        const priceStr = cells.eq(1).text().replace(/[^0-9.]/g, '').trim();
        const priceNum = parseFloat(priceStr);

        if (srvName && !isNaN(priceNum) && priceNum > 0) {
          requestedServices.push({
            name: srvName,
            rawPrice: priceNum,
          });
        }
      }
    }
  });

  if (requestedServices.length === 0 && requestDetails) {
    const narrative = parseDoctorNarrative(requestDetails);
    if (!diagnosis || diagnosis === 'Clinical Inpatient Evaluation') {
      if (narrative.clinicalIndicationAr && !narrative.clinicalIndicationAr.includes('قيد المتابعة')) {
        diagnosis = narrative.clinicalIndicationAr;
      } else {
        const diagMatch = requestDetails.match(/(?:يعاني|تعاني)\s+(?:المريض|المريضة|الحالة)?\s*من\s+([^و\n\r<]+)/i);
        if (diagMatch && diagMatch[1]) {
          diagnosis = diagMatch[1].trim();
        }
      }
    }

    if (narrative.cleanServices.length > 0) {
      for (const srv of narrative.cleanServices) {
        requestedServices.push({
          name: srv.name,
          rawPrice: 0,
        });
      }
    } else {
      const cleanDetails = extractCleanProcedurePhrase(requestDetails);
      const isDiagnosisCode = /^[A-Z]\d{2}(?:\.\d+)?\s*[-:]/i.test(cleanDetails);
      if (isDiagnosisCode && (!diagnosis || diagnosis === 'Clinical Inpatient Evaluation')) {
        diagnosis = cleanDetails;
      } else if (!isDiagnosisCode && cleanDetails && cleanDetails.length > 3) {
        const parts = splitClinicalRequests(cleanDetails);
        for (const part of parts) {
          requestedServices.push({
            name: part,
            rawPrice: 0,
          });
        }
      }
    }
  }

  if (diagnosis && /(?:weakness|diabetes|stroke|hypertension|appendicitis|coronary|stemi|pain|fever|patient)/i.test(diagnosis)) {
    const translatedDiag = translateDoctorIndication(diagnosis);
    if (translatedDiag && translatedDiag !== diagnosis) {
      diagnosis = translatedDiag;
    }
  }

  // Extract clean reply text if this message is a thread reply
  const cleanReply = extractCleanReplyBody(msg.htmlBody, msg.textBody);
  const isReply = /^(re|رد|fw|fwd)\s*:/i.test(msg.subject) || Boolean((msg as any).inReplyTo) || cleanReply.length > 0;

  // Detect state conditions (only applicable if message is an actual reply)
  const refusal = isReply ? detectRefusal(fullText, msg.subject, cleanReply) : { hasRefusal: false, snippet: '' };
  const approval = isReply ? detectExistingApproval(fullText, msg.subject, cleanReply) : { hasApproval: false, snippet: '' };
  const replies = isReply
    ? detectReplies({
        subject: msg.subject,
        text: msg.textBody,
        html: msg.htmlBody,
        cleanReply,
      })
    : { hasReplies: false, snippet: '' };

  const credit = isReply
    ? (cleanReply ? extractCreditLimit(cleanReply) : null) || extractCreditLimit(fullText) || {}
    : {};
  const copay = isReply
    ? (cleanReply ? extractCoPayment(cleanReply) : null) || extractCoPayment(fullText) || {}
    : {};

  return {
    patientName: patientName || 'غير مسجل',
    mrn: mrn || '000000',
    bed,
    admissionType,
    physician,
    contractorRaw: contractorRaw || 'غير محدد',
    contractorNormalized: contractorRaw ? cleanContractorName(contractorRaw) : 'غير محدد',
    priceListYear: '2025',
    diagnosis: diagnosis || 'Clinical Inpatient Evaluation',
    requestedServices,
    financialTerms: {
      approvedAmountLimit: credit.limit || null,
      patientSharePercentage: copay.percentage || null,
      coverageConditions: approval.conditionText || approval.snippet || cleanReply || undefined,
    },
    hasReplies: isReply,
    hasExistingApproval: isReply && approval.hasApproval,
    isRefused: isReply && refusal.hasRefusal,
    isConditionalApproval: isReply && Boolean(approval.isConditional),
    refusalReason: isReply && refusal.hasRefusal ? refusal.reason : undefined,
    statusReasonArabic: isReply
      ? (refusal.hasRefusal
          ? refusal.snippet
          : approval.hasApproval
          ? (approval.conditionText || approval.snippet)
          : cleanReply || undefined)
      : undefined,
    cleanReplyBody: isReply && cleanReply ? cleanReply : undefined,
    isReplyMessage: isReply,
    attachments: msg.attachments || [],
    rawBody: msg.htmlBody || msg.textBody || '',
  };
}
