/**
 * Pass 2 (ledger), Pass 6 (scope & quantity separation) and the deterministic validation
 * that sits between the model and every downstream decision.
 *
 * Principle: the model proposes; code verifies. Validation can only make a ledger stricter
 * (downgrade an approval to PENDING, raise review flags). It never upgrades anything.
 */
import { aliasKey, normalizeItem } from './glossary';
import { dice } from './coverage';
import { MODELS, type LlmClient } from './llm';
import { LEDGER_JSON_SCHEMA, LEDGER_SYSTEM_PROMPT } from './prompts';
import { hasMedicalAuthority, isBareAck, quoteInText } from './patterns';
import { extractApprovalReference } from './text';
import type {
  ItemCategory,
  ItemDecision,
  Ledger,
  LedgerItem,
  ReconstructedMessage,
  RejectionType,
  SpeakerRole,
  ThreadStatus,
} from './types';
import type { KnownDemographics } from '../lib/deidentifier';

export interface RequestedItem {
  text: string;
  category?: ItemCategory;
  quantity?: number | null;
}

export interface FewShotExample {
  snippet: string;
  expected: string;
}

// ------------------------------------------------------------------ prompt --

export function buildLedgerPrompt(opts: {
  messages: ReconstructedMessage[];
  requested: RequestedItem[];
  fewShots?: FewShotExample[];
  insurerName?: string;
}): string {
  const out: string[] = [];
  out.push(`INSURER: ${opts.insurerName ?? 'unknown'}`);
  out.push('ITEMS REQUESTED BY THE HOSPITAL (every one must appear in "items"; use NOT_ADDRESSED if the insurer did not answer it):');
  opts.requested.forEach((r, i) => out.push(`${i + 1}. ${r.text}${r.quantity ? ` (qty ${r.quantity})` : ''}`));
  if (opts.fewShots?.length) {
    out.push('\nPHRASING EXAMPLES from past threads (language patterns ONLY; they say nothing about this case):');
    opts.fewShots.forEach((f, i) => out.push(`Example ${i + 1}:\n${f.snippet}\n=> ${f.expected}`));
  }
  out.push('\nTHREAD (chronological). Auto-replies are omitted.');
  for (const m of opts.messages.filter((x) => !x.isAutoReply)) {
    out.push(`\n[MESSAGE id=${m.messageId} role_guess=${m.role} from=${m.sender} date=${m.date}]`);
    out.push(`NEW CONTENT:\n${m.newContent || '(empty)'}`);
    for (const a of m.attachments) out.push(`ATTACHMENT id=${a.evidenceId} name=${a.name} (PRIMARY EVIDENCE):\n${a.text.slice(0, 6000)}`);
    if (m.quotedContent) out.push(`QUOTED HISTORY (context only, NOT a decision):\n${m.quotedContent.slice(0, 1500)}`);
  }
  out.push('\nUse evidence_message_id = the message id (for attachment evidence use the attachment id shown). Quote evidence verbatim.');
  return out.join('\n');
}

export function chooseModel(messages: ReconstructedMessage[], opts: { retry?: boolean } = {}): string {
  const insurerMsgs = messages.filter((m) => m.role.startsWith('INSURER') && !m.isAutoReply).length;
  return insurerMsgs > 2 || opts.retry ? MODELS.pro : MODELS.flash;
}

// --------------------------------------------------------------- sanitizing --

const CATS: ItemCategory[] = ['ADMISSION', 'PROCEDURE', 'IMPLANT_DEVICE', 'MEDICATION', 'INVESTIGATION', 'ICU_DAYS', 'ROOM_CLASS', 'CONSULTATION', 'OTHER'];
const DECS: ItemDecision[] = ['APPROVED', 'CONDITIONAL', 'REJECTED', 'INFO_REQUESTED', 'PENDING', 'NOT_ADDRESSED'];
const STATUSES: ThreadStatus[] = ['APPROVED', 'PARTIAL', 'REJECTED', 'PENDING', 'UNCLEAR'];
const REJ: RejectionType[] = ['MEDICAL_NECESSITY', 'COVERAGE_EXCLUSION', 'LIMIT_EXCEEDED', 'WAITING_PERIOD', 'PRE_EXISTING', 'NOT_PREAUTHORIZED', 'POLICY_EXPIRED', 'WRONG_PROVIDER', 'OTHER'];
const ROLES: SpeakerRole[] = ['INSURER_MEDICAL_REVIEWER', 'INSURER_ADMIN', 'HOSPITAL', 'CORPORATE_SALES', 'AUTO_REPLY', 'UNKNOWN'];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);

/** Coerces untrusted model JSON into a Ledger. Unknown enum values degrade to the SAFE side. */
export function sanitizeLedger(raw: any): Ledger {
  const items: LedgerItem[] = (Array.isArray(raw?.items) ? raw.items : []).map((i: any): LedgerItem => {
    const text = str(i?.text_original) ?? '';
    const norm = normalizeItem(text);
    return {
      category: CATS.includes(i?.category) ? i.category : (norm.entry?.category as ItemCategory) ?? 'OTHER',
      text_original: text,
      canonical_en: str(i?.canonical_en) ?? norm.canonical_en,
      decision: DECS.includes(i?.decision) ? i.decision : 'PENDING', // unknown never becomes an approval
      quantity_requested: num(i?.quantity_requested),
      quantity_approved: num(i?.quantity_approved),
      conditions: strs(i?.conditions),
      info_requested: strs(i?.info_requested),
      rejection_type: REJ.includes(i?.rejection_type) ? i.rejection_type : null,
      rejection_reason_ar: str(i?.rejection_reason_ar),
      rejection_reason_en: str(i?.rejection_reason_en),
      validity_until: str(i?.validity_until),
      amount_cap: num(i?.amount_cap),
      copay_percent: num(i?.copay_percent),
      evidence_quote: typeof i?.evidence_quote === 'string' ? i.evidence_quote : '',
      evidence_message_id: typeof i?.evidence_message_id === 'string' ? i.evidence_message_id : '',
    };
  });
  const conf = num(raw?.confidence);
  return {
    thread_status: STATUSES.includes(raw?.thread_status) ? raw.thread_status : 'UNCLEAR',
    approval_reference: str(raw?.approval_reference),
    messages: (Array.isArray(raw?.messages) ? raw.messages : [])
      .filter((m: any) => typeof m?.message_id === 'string')
      .map((m: any) => ({ message_id: m.message_id, speaker_role: ROLES.includes(m.speaker_role) ? m.speaker_role : 'UNKNOWN', contains_decision: !!m.contains_decision })),
    items,
    confidence: conf === null ? 0 : Math.max(0, Math.min(1, conf)),
    needs_human_review: !!raw?.needs_human_review,
    review_reasons: strs(raw?.review_reasons),
  };
}

// ---------------------------------------------------------------- the pass ---

export interface LedgerPassResult {
  ledger: Ledger;
  model: string;
  escalated: boolean;
}

export async function runLedgerPass(
  llm: LlmClient,
  opts: {
    messages: ReconstructedMessage[];
    requested: RequestedItem[];
    fewShots?: FewShotExample[];
    insurerName?: string;
    known?: KnownDemographics;
    approvalKey?: string;
    /** redaction applied to the prompt before it leaves the process */
    redact?: (s: string) => string;
  }
): Promise<LedgerPassResult> {
  // NOTE: no historical statistics are passed here (bias). Few-shots are phrasing only.
  const redact = opts.redact ?? ((s: string) => s);
  const prompt = redact(buildLedgerPrompt(opts));
  let model = chooseModel(opts.messages);
  const call = async (m: string) =>
    sanitizeLedger(
      await llm.generateJson({ pass: 'ledger', model: m, system: LEDGER_SYSTEM_PROMPT, prompt, schema: LEDGER_JSON_SCHEMA, known: opts.known, approvalKey: opts.approvalKey })
    );
  let ledger = await call(model);
  let escalated = false;
  const conflicted = detectConflicts(ledger.items, opts.messages).length > 0;
  if (model === MODELS.flash && (ledger.confidence < 0.8 || conflicted)) {
    model = MODELS.pro;
    escalated = true;
    ledger = await call(model);
  }
  return { ledger, model, escalated };
}

// ------------------------------------------------------------- validation ----

export interface ValidationOutcome {
  items: LedgerItem[];
  reasons: string[];
  needs_human_review: boolean;
}

const baseId = (id: string) => id.split('#att:')[0];
const isDecisionLike = (d: ItemDecision) => d === 'APPROVED' || d === 'CONDITIONAL' || d === 'REJECTED' || d === 'INFO_REQUESTED';
const isApprovalLike = (d: ItemDecision) => d === 'APPROVED' || d === 'CONDITIONAL';

/**
 * Every decision must be traceable to a real, non-quoted, insurer-authored text:
 *  - evidence message exists and is not an auto-reply
 *  - author is an insurer (not hospital / corporate sales)
 *  - the verbatim quote is found in the author's NEW text or an attachment, never only in quoted history
 *  - bare "ok/تمام" is not an approval unless the request it answers is unambiguous
 *  - admin staff without medical-review language or reference ⇒ human review (flag only)
 */
export function validateLedger(
  ledger: Ledger,
  messages: ReconstructedMessage[],
  ctx: { requestedCount: number } = { requestedCount: 1 }
): ValidationOutcome {
  const reasons: string[] = [];
  let review = ledger.needs_human_review;
  const byId = new Map(messages.map((m) => [m.messageId, m]));
  const ref = ledger.approval_reference || messages.map((m) => extractApprovalReference(m.decisionText)).find(Boolean) || null;

  const items = ledger.items.map((orig) => {
    const it = { ...orig };
    if (it.decision === 'NOT_ADDRESSED' || it.decision === 'PENDING') return it;
    const downgrade = (why: string) => {
      if (isApprovalLike(it.decision) || it.decision === 'INFO_REQUESTED') {
        reasons.push(`${why}: ${it.text_original}`);
        it.decision = 'PENDING';
        it.quantity_approved = null;
        review = true;
      }
    };

    const msg = byId.get(baseId(it.evidence_message_id));
    if (!msg) {
      if (it.decision === 'REJECTED') {
        reasons.push(`EVIDENCE_MESSAGE_NOT_FOUND: ${it.text_original}`);
        review = true;
      } else downgrade('EVIDENCE_MESSAGE_NOT_FOUND');
      return it;
    }
    if (msg.isAutoReply || msg.role === 'AUTO_REPLY') return (downgrade('DECISION_FROM_AUTO_REPLY'), it);
    if (msg.role === 'HOSPITAL' || msg.role === 'CORPORATE_SALES') return (downgrade('DECISION_FROM_NON_INSURER'), it);

    const att = it.evidence_message_id.includes('#att:') ? msg.attachments.find((a) => a.evidenceId === it.evidence_message_id) : undefined;
    const evidenceText = att ? att.text : `${msg.decisionText}\n${msg.attachments.map((a) => a.text).join('\n')}`;
    const inAuthor = quoteInText(it.evidence_quote, evidenceText);
    if (!inAuthor) {
      const inQuoted = it.evidence_quote && quoteInText(it.evidence_quote, msg.quotedContent);
      if (inQuoted) return (downgrade('DECISION_IN_QUOTED_TEXT_ONLY'), it);
      if (it.decision === 'REJECTED') {
        reasons.push(`EVIDENCE_QUOTE_NOT_VERBATIM: ${it.text_original}`);
        review = true;
      } else downgrade('EVIDENCE_QUOTE_NOT_VERBATIM');
      return it;
    }

    if (isApprovalLike(it.decision) && isBareAck(it.evidence_quote)) {
      if (ctx.requestedCount > 1 || !msg.quotedContent) {
        reasons.push(`UNCLEAR:BARE_ACK_AMBIGUOUS: ${it.text_original}`);
        it.decision = 'PENDING';
        review = true;
        return it;
      }
    }

    if (isApprovalLike(it.decision) && msg.role === 'INSURER_ADMIN' && !ref && !hasMedicalAuthority(`${msg.decisionText} ${it.evidence_quote}`)) {
      reasons.push(`ADMIN_DECISION_WITHOUT_MEDICAL_REVIEW: ${it.text_original}`);
      review = true;
    }
    return it;
  });

  return { items, reasons: [...new Set(reasons)], needs_human_review: review };
}

// -------------------------------------------------------------- revisions ----

export const itemKey = (i: Pick<LedgerItem, 'category' | 'canonical_en' | 'text_original'>) =>
  `${i.category}|${aliasKey(i.canonical_en || normalizeItem(i.text_original).canonical_en || i.text_original)}`;

export interface Revision {
  item: string;
  from: ItemDecision;
  to: ItemDecision;
  from_message: string;
  to_message: string;
}

export interface Conflict {
  item: string;
  quotes: string[];
}

function whenOf(id: string, messages: ReconstructedMessage[]): number {
  const m = messages.find((x) => x.messageId === baseId(id));
  return m ? new Date(m.date).getTime() : 0;
}

/** Same-message conflicts: body vs attached letter (or two decisions at the same instant). */
export function detectConflicts(items: LedgerItem[], messages: ReconstructedMessage[]): Conflict[] {
  const groups = new Map<string, LedgerItem[]>();
  for (const i of items) if (isDecisionLike(i.decision)) groups.set(itemKey(i), [...(groups.get(itemKey(i)) || []), i]);
  const out: Conflict[] = [];
  for (const [, g] of groups) {
    if (g.length < 2) continue;
    for (let a = 0; a < g.length; a++)
      for (let b = a + 1; b < g.length; b++) {
        const sameMsg = baseId(g[a].evidence_message_id) === baseId(g[b].evidence_message_id);
        const sameTime = whenOf(g[a].evidence_message_id, messages) === whenOf(g[b].evidence_message_id, messages);
        if ((sameMsg || sameTime) && g[a].decision !== g[b].decision) {
          out.push({ item: g[a].text_original, quotes: [g[a].evidence_quote, g[b].evidence_quote] });
        }
      }
  }
  return out;
}

/**
 * Later messages override earlier ones ONLY for the same item. A later acknowledgement
 * ("under review") never overrides an earlier real decision.
 */
export function resolveRevisions(items: LedgerItem[], messages: ReconstructedMessage[]): { items: LedgerItem[]; revisions: Revision[]; conflicts: Conflict[] } {
  const conflicts = detectConflicts(items, messages);
  const groups = new Map<string, LedgerItem[]>();
  for (const i of items) groups.set(itemKey(i), [...(groups.get(itemKey(i)) || []), i]);
  const final: LedgerItem[] = [];
  const revisions: Revision[] = [];
  for (const [, g] of groups) {
    if (g.length === 1) {
      final.push(g[0]);
      continue;
    }
    const ordered = [...g].sort((a, b) => whenOf(a.evidence_message_id, messages) - whenOf(b.evidence_message_id, messages));
    const real = ordered.filter((x) => isDecisionLike(x.decision));
    const winner = (real.length ? real : ordered)[(real.length ? real : ordered).length - 1];
    for (const x of real) {
      if (x !== winner && x.decision !== winner.decision) {
        revisions.push({ item: winner.text_original, from: x.decision, to: winner.decision, from_message: x.evidence_message_id, to_message: winner.evidence_message_id });
      }
    }
    // carry the earliest requested quantity forward when the winner omits it
    final.push({ ...winner, quantity_requested: winner.quantity_requested ?? ordered.find((x) => x.quantity_requested != null)?.quantity_requested ?? null });
  }
  return { items: final, revisions, conflicts };
}

// ------------------------------------------------- Pass 6: scope & quantity --

/**
 * Ensures each hospital-requested item has its own ledger entry. An admission approval never
 * marks a procedure approved: unanswered requested items are appended as NOT_ADDRESSED.
 */
export function enforceScope(items: LedgerItem[], requested: RequestedItem[]): { items: LedgerItem[]; notAddressed: string[] } {
  const out = [...items];
  const notAddressed: string[] = [];
  for (const r of requested) {
    const rn = normalizeItem(r.text);
    const rkey = aliasKey(rn.canonical_en || r.text);
    const hit = out.find((i) => {
      const ik = aliasKey(i.canonical_en || normalizeItem(i.text_original).canonical_en || i.text_original);
      return ik === rkey || dice(ik, rkey) >= 0.8 || aliasKey(i.text_original) === aliasKey(r.text);
    });
    if (!hit) {
      const cat = r.category ?? ((rn.entry?.category as ItemCategory) || 'PROCEDURE');
      out.push({ category: cat, text_original: r.text, canonical_en: rn.canonical_en, decision: 'NOT_ADDRESSED', quantity_requested: r.quantity ?? null, quantity_approved: null, conditions: [], info_requested: [], evidence_quote: '', evidence_message_id: '' });
      notAddressed.push(r.text);
    } else if (hit.decision === 'NOT_ADDRESSED') notAddressed.push(r.text);
  }
  return { items: out, notAddressed };
}

/** Exact numbers for partial quantity approvals ("3 of 5 days"). */
export function partialQuantity(i: LedgerItem): { approved: number; requested: number } | null {
  if (i.decision !== 'APPROVED' && i.decision !== 'CONDITIONAL') return null;
  if (i.quantity_approved == null || i.quantity_requested == null) return null;
  return i.quantity_approved < i.quantity_requested ? { approved: i.quantity_approved, requested: i.quantity_requested } : null;
}
