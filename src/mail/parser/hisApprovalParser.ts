/**
 * HIS Approval Email Parser
 * Extracts clinical diagnosis, patient demographics, requested services, prices,
 * financial terms (credit limit / ceiling), refusal state, and replies.
 */

import * as cheerio from 'cheerio';
import { cleanContractorName, stripSentFromSignatures } from '../../lib/arabic-normalizer';
import { extractCleanProcedurePhrase } from '../../lib/whatsapp-generator';
import { ParsedApprovalEmail, RawMailMessage } from '../types';

export const REFUSAL_KEYWORDS = [
  'غير مغطى',
  'غير مغطاه',
  'غير مغطاة',
  'غير مغطي',
  'مرفوض',
  'رفض',
  'غير معتمد',
  'not approved',
  'rejected',
  'نعتذر عن الموافقة',
  'نعتذر عن الموافقه',
  'خارج التغطية',
  'خارج التغطيه',
];

export const APPROVAL_KEYWORDS = [
  'لا مانع',
  'approved',
  'approve',
  'معتمد',
  'موافقة سعرية',
  'موافقه سعريه',
  'تمت الموافقة',
  'تمت الموافقه',
  'موافقة باللائحة',
  'موافقه باللائحه',
  'يضاف علي الفاتوره',
  'يضاف على الفاتورة',
  'بفاتوره الشراء',
  'بفاتورة الشراء',
  'موافق',
  'تسعيرة سعرية',
  'تسعيره سعريه',
  'تسعيرة',
  'تسعيره',
];

export function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

export function cleanTextFromHtml(input: string): string {
  if (!input) return '';
  return input
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractCreditLimit(text: string): { limit?: number; formatted?: string } {
  if (!text) return {};
  const normalized = text.normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e]/g, ' ');

  const pattern =
    /(?:الحد\s+ال[اأإآ]قص[ىي]|بحد\s+[اأإآ]قص[ىي]|سقف\s+الموافق[ةه]|بمبلغ\s+لا\s+يتجاوز|في\s+حدود|موافق[ةه](?:\s+سعري[ةه])?\s+بمبلغ|معتمد\s+بمبلغ|لا\s+مانع(?:[^\d\n\r]{0,30})بمبلغ|تحصيل\s+مبلغ|مبلغ\s+(?:ت[اأإآ]مين\s+)?)(?:[^\d\n\r]{0,25})(\d+(?:[\.,]\d+)?)\s*(الف|ألف|الاف|آلاف|k)?/i;
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

export function detectRefusal(text: string, subject: string): { hasRefusal: boolean; snippet: string } {
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
      const end = Math.min(combined.length, idx + kw.length + 80);
      let snippet = stripSentFromSignatures(combined.substring(start, end)).trim();
      if (start > 0) snippet = '...' + snippet;
      if (end < combined.length) snippet = snippet + '...';

      return { hasRefusal: true, snippet };
    }
  }

  return { hasRefusal: false, snippet: '' };
}

export function detectExistingApproval(
  text: string,
  subject: string
): { hasApproval: boolean; snippet: string; creditLimit?: number; creditLimitText?: string } {
  const normText = (text || '').normalize('NFKC');
  const normSubj = (subject || '').normalize('NFKC');

  const refusalCheck = detectRefusal(normText, normSubj);
  if (refusalCheck.hasRefusal) {
    return { hasApproval: false, snippet: '' };
  }

  const cleanBody = cleanTextFromHtml(normText);
  const cleanSubj = cleanTextFromHtml(normSubj);
  const combined = `${cleanSubj} ${cleanBody}`.trim();
  const normalized = combined
    .toLowerCase()
    .replace(/[إأآ]/g, 'ا')
    .replace(/ة/g, 'ه');

  const credit = extractCreditLimit(combined);

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

  const attachedIdx = approvalSearchText.search(/مرفق\s+(?:تقرير\s+)?(?:ال)?موافق/);
  if (attachedIdx !== -1) {
    const start = Math.max(0, attachedIdx - 25);
    const end = Math.min(combined.length, attachedIdx + 80);
    let snippet = stripSentFromSignatures(combined.substring(start, end)).trim();
    if (start > 0) snippet = '...' + snippet;
    return { hasApproval: true, snippet, creditLimit: credit.limit, creditLimitText: credit.formatted };
  }

  for (const kw of APPROVAL_KEYWORDS) {
    const kwNorm = kw
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[إأآ]/g, 'ا')
      .replace(/ة/g, 'ه');

    const idx =
      kwNorm === 'موافق'
        ? approvalSearchText.search(/(?<![\u0600-\u06FF])موافق(?![\u0600-\u06FF])/)
        : approvalSearchText.indexOf(kwNorm);
    if (idx !== -1) {
      const start = Math.max(0, idx - 25);
      const end = Math.min(combined.length, idx + kw.length + 80);
      let snippet = stripSentFromSignatures(combined.substring(start, end)).trim();
      if (start > 0) snippet = '...' + snippet;
      if (end < combined.length) snippet = snippet + '...';

      return {
        hasApproval: true,
        snippet,
        creditLimit: credit.limit,
        creditLimitText: credit.formatted,
      };
    }
  }

  if (credit.limit && approvalSearchText === normalized) {
    return {
      hasApproval: true,
      snippet: stripSentFromSignatures(combined.substring(0, 120)).trim(),
      creditLimit: credit.limit,
      creditLimitText: credit.formatted,
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
    /بتاريخ\s+.+كتب/i.test(rawContent);

  if (isReSubject || hasInReplyTo || hasReferences || hasQuotedMarkers) {
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
        replySnippet = stripSentFromSignatures(s).substring(0, 120);
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

  // 3. Fallback regex extraction
  if (!patientName) {
    const pMatch =
      fullText.match(/Patient Name:\s*([^<\n\r]+?)(?=\s*(?:Contractor|Visit|Admission|Physician|Diagnosis|Bed|Request|Selected|جهة|الجهة|الرقم|$))/i) ||
      fullText.match(/(?:حاله|حالة)\s*[:\/]\s*([^<\n\r]+?)(?=\s*(?:Contractor|Visit|Admission|Physician|Diagnosis|Bed|Request|Selected|جهة|الجهة|الرقم|$))/i);
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
      fullText.match(/(?:جهة\s*التعاقد|الجهة\s*التعاقدية)\s*[:\s]+([^<\n\r]+?)(?=\s+(?:التشخيص|الطبيب|رقم|تاريخ|$))/i);
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
    const cleanDetails = extractCleanProcedurePhrase(requestDetails);
    if (cleanDetails && cleanDetails.length > 3) {
      requestedServices.push({
        name: cleanDetails,
        rawPrice: 0,
      });
    }
  }

  // Detect state conditions
  const refusal = detectRefusal(fullText, msg.subject);
  const approval = detectExistingApproval(fullText, msg.subject);
  const replies = detectReplies({
    subject: msg.subject,
    text: msg.textBody,
    html: msg.htmlBody,
  });

  const credit = extractCreditLimit(fullText);

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
      patientSharePercentage: null,
      coverageConditions: approval.snippet || undefined,
    },
    hasReplies: replies.hasReplies,
    hasExistingApproval: approval.hasApproval,
    isRefused: refusal.hasRefusal,
    statusReasonArabic: refusal.hasRefusal
      ? refusal.snippet
      : approval.hasApproval
      ? approval.snippet
      : undefined,
    attachments: msg.attachments || [],
    rawBody: msg.htmlBody || msg.textBody || '',
  };
}
