/**
 * Deterministic Arabic/English decision cues. Used ONLY as a safety cross-check on model
 * output (verifier pass, validation) – never as the primary classifier. Mirrors
 * resources/arabic-mail-patterns.md.
 */
import { normalizeArabicLight } from './text';

/** Pattern key: Arabic-light + ة→ه + lower-case + collapsed whitespace/punctuation. */
export function patKey(s: string): string {
  return normalizeArabicLight(s || '')
    .replace(/ة/g, 'ه')
    .replace(/[ؤئ]/g, 'ء')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// All Arabic below is written in patKey form (ا plain, ي, ه for ة).
const REJECT = [
  /غير موافق/, /عدم الموافقه/, /لا يمكن/, /لا نوافق/, /لم يتم الموافقه/, /لم نوافق/, /مرفوض/, /نعتذر/, /تعذر/, /يرفض/, /تم الرفض/, /لا يغطي/, /غير مغطي/, /خارج التغطيه/, /مستثني/,
  /\bnot approved\b/, /\bdeclined?\b/, /\brejected\b/, /\bcannot be approved\b/, /\bunable to approve\b/, /\bnot covered\b/, /\bdenied\b/, /\bwe regret\b/,
];
const CONDITION = [
  /بشرط/, /شريطه/, /يرجي ارفاق/, /يرجي ارسال/, /برجاء ارسال/, /برجاء ارفاق/, /نرجو ارسال/, /نرجو ارفاق/, /مطلوب/, /يلزم/, /بعد استيفاء/, /بعد ارسال/, /مع ارفاق/,
  /\bsubject to\b/, /\bprovided that\b/, /\bplease (send|provide|attach|share)\b/, /\bpending (the )?(report|documents?)\b/, /\bon condition\b/,
];
const APPROVE = [
  /لا مانع/, /لا يوجد مانع/, /تمت الموافقه/, /تم الموافقه/, /موافق(ه)? علي/, /(?:^| )موافق(?: |$)/, /نوافق/, /تم الاعتماد/, /تم اعتماد/, /اعتماد/, /تمت الموافقه/,
  /\bapproved\b/, /\bwe approve\b/, /\bno objection\b/, /\bgranted\b/, /\bapproval (is )?(given|granted)\b/,
];
const PENDING = [
  /تم الاستلام/, /جاري الدراسه/, /جاري المراجعه/, /تحت الدراسه/, /تحت المراجعه/, /تم التحويل للطبيب المراجع/, /تم التحويل الي الطبيب/, /سيتم الرد/, /سنوافيكم/, /قيد الدراسه/, /قيد المراجعه/,
  /\bunder review\b/, /\breceived\b/, /\bbeing reviewed\b/, /\bwill revert\b/, /\bwill get back\b/, /\backnowledged\b/, /\bin process\b/,
];

const any = (res: RegExp[], t: string) => res.some((r) => r.test(t));

export type CueDecision = 'APPROVED' | 'CONDITIONAL' | 'REJECTED' | 'PENDING' | null;

/** "لا مانع" is approval even though it contains "لا". Rejection cues are tested first. */
const NEGATED_APPROVAL =
  /غير موافق|لا نوافق|لم نوافق|لم يتم الموافقه|عدم الموافقه|لا يمكن الموافقه|\bnot approved\b|\bcannot be approved\b|\bunable to approve\b|\bno approval\b/g;

export function inferCueDecision(quote: string): CueDecision {
  const t = patKey(quote);
  if (!t) return null;
  const rej = any(REJECT, t);
  const app = any(APPROVE, t.replace(NEGATED_APPROVAL, ' '));
  const cond = any(CONDITION, t);
  if (rej && app) return null; // genuinely mixed in one quote: make no deterministic claim
  if (rej) return 'REJECTED';
  if (app && cond) return 'CONDITIONAL';
  if (app) return 'APPROVED';
  if (cond) return 'CONDITIONAL';
  if (any(PENDING, t)) return 'PENDING';
  return null;
}

export const isRejectionCue = (q: string) => any(REJECT, patKey(q));
export const isPendingCue = (q: string) => inferCueDecision(q) === 'PENDING';

/** "تمام" / "ماشي" / "ok" with no item or reference. */
const BARE_ACK = /^(?:(?:تمام|ماشي|اوكي|اوك|تم|ok|okay|okey|done|👍)[\s.!،,]*)+$/;
export const isBareAck = (quote: string) => BARE_ACK.test(patKey(quote).replace(/\s+/g, ' '));

/** Authority markers: language suggesting a medical review decision. */
export const MEDICAL_AUTHORITY = /(الطبيب المراجع|المراجع الطبي|المدير الطبي|اللجنه الطبيه|لجنه طبيه|medical (review|director|officer|committee)|reviewing doctor|medical approval)/;
export const hasMedicalAuthority = (t: string) => MEDICAL_AUTHORITY.test(patKey(t));

/** Loose containment test for "is this quote really in that text?" */
export function quoteInText(quote: string, text: string): boolean {
  const q = patKey(quote);
  const t = patKey(text);
  if (!q) return false;
  if (t.includes(q)) return true;
  // allow ellipses: every fragment must appear, in order
  const frags = quote.split(/…|\.{3,}|\[\.\.\.\]/).map(patKey).filter((f) => f.length >= 3);
  if (frags.length > 1) {
    let pos = 0;
    for (const f of frags) {
      const at = t.indexOf(f, pos);
      if (at < 0) return false;
      pos = at + f.length;
    }
    return true;
  }
  return false;
}
