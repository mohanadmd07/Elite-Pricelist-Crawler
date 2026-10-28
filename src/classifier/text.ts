/**
 * Pass 1 helpers: Arabic normalization, auto-reply detection, quoted/new split,
 * approval-reference extraction, request matching. Pure functions, no I/O.
 */
import crypto from 'crypto';
import { cleanTextFromHtml } from '../mail/parser/hisApprovalParser';
import type {
  ApprovalRequestRef,
  RawThreadMessage,
  ReconstructedMessage,
  SpeakerRole,
} from './types';

/**
 * Spec normalization: strip tashkeel + tatweel, أ/إ/آ→ا, ى→ي, Arabic-Indic (and
 * Persian) digits→0-9. Deliberately lighter than lib/arabic-normalizer's
 * normalizeArabic (which also folds ة→ه and strips punctuation) so evidence
 * quotes and references stay readable. Use normalizeArabic for fuzzy keys.
 */
export function normalizeArabicLight(input: string): string {
  if (!input) return '';
  return input
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي');
}

export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------- auto replies ----

const AUTO_REPLY_RE =
  /(out\s*of\s*(the\s*)?office|automatic\s*reply|auto[-\s]?reply|autoreply|undeliverable|delivery\s*status\s*notification|read\s*receipt|has\s*been\s*read|رد\s*تلقائي|خارج\s*المكتب|اجازه\s*سنويه|إجازة\s*سنوية|اجازة\s*سنوية|إيصال\s*قراءة)/i;

export function isAutoReply(subject: string, body: string, sender = ''): boolean {
  const head = normalizeArabicLight(`${subject}\n${(body || '').slice(0, 400)}`);
  if (AUTO_REPLY_RE.test(head) || AUTO_REPLY_RE.test(subject || '')) return true;
  return /mailer-daemon|postmaster|no-?reply/i.test(sender);
}

// ----------------------------------------------------------- quoted split ---

const QUOTE_HEADER_RES: RegExp[] = [
  /^\s*-{2,}\s*(original message|forwarded message|الرسالة الأصلية)/i,
  /^\s*_{5,}\s*$/,
  /^\s*(from|sent|من)\s*:\s*.+/i,
  /^\s*on\s.+\bwrote:\s*$/i,
  /^\s*في\s.+\bكتب\b.*:\s*$/,
  /^\s*(date|التاريخ)\s*:\s*.+/i,
];

/**
 * Splits a body into the author's NEW content and QUOTED history.
 * Inline replies (new text interleaved between ">" quoted lines) are preserved:
 * ">"-prefixed lines are quoted, but un-prefixed lines between them stay in
 * newContent, and the quoted line they answer is kept adjacent in `inline`.
 */
export function splitNewVsQuoted(body: string): { newContent: string; quotedContent: string; inline: string } {
  const lines = (body || '').replace(/\r/g, '').split('\n');
  const hasInlineQuotes = lines.some((l) => /^\s*>/.test(l));
  const newLines: string[] = [];
  const quoted: string[] = [];
  const inline: string[] = [];
  let inTail = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inTail && !hasInlineQuotes && QUOTE_HEADER_RES.some((re) => re.test(line))) {
      // everything from the first header on is the quoted tail
      inTail = true;
    }
    if (inTail) {
      quoted.push(line);
      continue;
    }
    if (/^\s*>/.test(line)) {
      quoted.push(line.replace(/^\s*>+\s?/, ''));
      inline.push(`[QUOTED] ${line.replace(/^\s*>+\s?/, '')}`);
    } else {
      if (line.trim()) inline.push(`[REPLY] ${line}`);
      newLines.push(line);
    }
  }
  return {
    newContent: newLines.join('\n').trim(),
    quotedContent: quoted.join('\n').trim(),
    inline: hasInlineQuotes ? inline.join('\n') : '',
  };
}

// ------------------------------------------------------------- roles --------

const MEDICAL_REVIEW_RE =
  /(medical\s*(review|director|officer|committee)|reviewing\s*doctor|الطبيب\s*المراجع|المراجع\s*الطبي|المدير\s*الطبي|اللجنه\s*الطبيه|لجنه\s*طبيه|الاستشاري\s*المراجع|medical\s*approval)/i;

export function hasMedicalReviewLanguage(text: string): boolean {
  return MEDICAL_REVIEW_RE.test(normalizeArabicLight(text));
}

export function inferRole(
  sender: string,
  text: string,
  ctx: { hospitalDomains?: string[]; salesDomains?: string[]; isAuto?: boolean } = {}
): SpeakerRole {
  if (ctx.isAuto) return 'AUTO_REPLY';
  const s = (sender || '').toLowerCase();
  const hospitalDomains = ctx.hospitalDomains ?? ['elitehospital.org'];
  const isHospital = hospitalDomains.some((d) => s.includes(d.toLowerCase()));
  if (isHospital) {
    if (/corporate@|sales@|fekr[iy]|فكري/i.test(sender)) return 'CORPORATE_SALES';
    return 'HOSPITAL';
  }
  if (!s || s === 'unknown') return 'UNKNOWN';
  if (hasMedicalReviewLanguage(text) || /medical|clinical|طبي/i.test(s)) return 'INSURER_MEDICAL_REVIEWER';
  return 'INSURER_ADMIN';
}

// ----------------------------------------------------------- reconstruct ----

export function reconstructThread(
  messages: RawThreadMessage[],
  opts: { hospitalDomains?: string[] } = {}
): ReconstructedMessage[] {
  return [...messages]
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .map((m) => {
      const plain = /<[a-z][\s\S]*>/i.test(m.body || '') ? cleanTextFromHtml(m.body) : m.body || '';
      const auto = isAutoReply(m.subject || '', plain, m.sender);
      const split = splitNewVsQuoted(plain);
      const newContent = split.inline || split.newContent;
      return {
        messageId: m.messageId,
        sender: m.sender,
        role: inferRole(m.sender, split.newContent, { ...opts, isAuto: auto }),
        date: m.date,
        newContent: normalizeArabicLight(newContent),
        decisionText: normalizeArabicLight(split.newContent),
        quotedContent: normalizeArabicLight(split.quotedContent),
        attachments: (m.attachments || []).map((a) => ({
          name: a.name,
          text: normalizeArabicLight(a.text),
          evidenceId: `${m.messageId}#att:${a.name}`,
        })),
        isAutoReply: auto,
      };
    });
}

// ------------------------------------------------------ approval reference ---

const REF_RES: RegExp[] = [
  /(?:approval|appr\.?|auth(?:orization)?|ref(?:erence)?|reference)\s*(?:no\.?|number|#|code)?\s*[:：#-]?\s*([A-Z0-9][A-Z0-9\-\/]{4,24})/i,
  /(?:رقم\s*(?:ال)?(?:موافق[هة]|الموافق[هة]|اعتماد|الاعتماد|مرجعي|المرجع|تصريح|التصريح)|(?:ال)?(?:موافق[هة]|اعتماد|تصريح)\s*رقم)\s*[:：#-]?\s*([A-Z0-9][A-Z0-9\-\/]{3,24})/i,
];

/** Extracts an approval reference, converting Arabic-Indic digits first. */
export function extractApprovalReference(text: string): string | null {
  const t = normalizeArabicLight(text || '');
  for (const re of REF_RES) {
    const m = t.match(re);
    if (m && /\d/.test(m[1])) return m[1].toUpperCase();
  }
  return null;
}

export interface RequestCandidate extends ApprovalRequestRef {
  id: string;
}

/**
 * Matches a reply to a request. Order: approval reference → patient name +
 * admission date → thread/conversation id. NEVER by subject alone.
 */
export function matchReplyToRequest(
  reply: { text: string; conversationId?: string | null; inReplyTo?: string | null; subject?: string },
  requests: RequestCandidate[]
): { requestId: string | null; by: 'REFERENCE' | 'PATIENT_DATE' | 'THREAD' | null } {
  const ref = extractApprovalReference(reply.text);
  if (ref) {
    const hit = requests.find((r) => r.approvalReference && r.approvalReference.toUpperCase() === ref);
    if (hit) return { requestId: hit.id, by: 'REFERENCE' };
  }
  const nText = normalizeArabicLight(reply.text).toLowerCase();
  const byPatient = requests.filter((r) => {
    if (!r.patientName || !r.admissionDate) return false;
    const name = normalizeArabicLight(r.patientName).toLowerCase().trim();
    const date = r.admissionDate.slice(0, 10);
    const dateAlt = date.split('-').reverse().join('/');
    return name.length > 3 && nText.includes(name) && (nText.includes(date) || nText.includes(dateAlt));
  });
  if (byPatient.length === 1) return { requestId: byPatient[0].id, by: 'PATIENT_DATE' };
  const ids = [reply.conversationId, reply.inReplyTo].filter(Boolean) as string[];
  if (ids.length) {
    const hit = requests.find((r) => r.conversationId && ids.includes(r.conversationId));
    if (hit) return { requestId: hit.id, by: 'THREAD' };
  }
  return { requestId: null, by: null };
}
