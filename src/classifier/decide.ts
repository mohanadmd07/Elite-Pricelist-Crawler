/**
 * Section C: decision rules. Status is derived from the item ledger, never from tone.
 * Learned history is NOT an input here (it can only add review flags later in the pipeline).
 */
import { add } from './pricelist';
import { partialQuantity, type Conflict } from './ledger';
import type { LedgerItem, PricedLine, RejectionType, ThreadStatus } from './types';

export const CONFIDENCE_FLOOR = 0.8;

export interface DecideInput {
  items: LedgerItem[];
  confidence: number;
  priced: PricedLine[];
  resolvedTotal: number;
  amountCap: number | null;
  conflicts: Conflict[];
  reviewReasons: string[];
  priceApprovalStatus: 'DRAFT' | 'SENT' | 'APPROVED' | 'REFUSED' | null;
  humanLockedStatus?: ThreadStatus | null;
}

export interface DecideOutput {
  status: ThreadStatus;
  needs_human_review: boolean;
  reasons: string[];
  price_approval_required: boolean;
  cap_gap: number | null;
  rejection_reason_ar: string | null;
  rejection_reason_en: string | null;
  rejection_type: RejectionType | null;
  evidence_quote: string | null;
  requested_questions: Array<{ item: string; question: string }>;
  partials: Array<{ item: string; approved: number; requested: number }>;
}

const BLOCKING_SOURCES = new Set(['NOT_FOUND', 'NEEDS_REVIEW', 'NO_MAPPING']);

export function decide(input: DecideInput): DecideOutput {
  const reasons = [...input.reviewReasons];
  let review = false;

  const requested_questions: DecideOutput['requested_questions'] = [];
  for (const i of input.items) {
    for (const q of i.info_requested || []) requested_questions.push({ item: i.text_original, question: q });
    for (const c of i.conditions || []) requested_questions.push({ item: i.text_original, question: c });
  }

  const partials = input.items.map((i) => ({ i, p: partialQuantity(i) })).filter((x) => x.p).map((x) => ({ item: x.i.text_original, ...x.p! }));

  const listLines = input.priced.filter((l) => l.price_source === 'LIST_2026_PRICE_APPROVAL');
  const price_approval_required = listLines.length > 0;
  const blockers = input.priced.filter((l) => BLOCKING_SOURCES.has(l.price_source));
  if (blockers.length) {
    review = true;
    for (const b of blockers) reasons.push(`${b.price_source}: ${b.item}`);
  }

  // Corporate Sales reported the insurer REFUSED the price approval ⇒ those items cannot go ahead.
  const priceRefused = price_approval_required && input.priceApprovalStatus === 'REFUSED';
  const refusedItems = new Set(priceRefused ? listLines.map((l) => l.item_index) : []);
  const eff = input.items.map((i, idx) => (refusedItems.has(idx) ? { ...i, decision: 'REJECTED' as const, rejection_type: i.rejection_type ?? ('OTHER' as RejectionType), rejection_reason_en: i.rejection_reason_en ?? 'Insurer refused the price approval' } : i));

  // Rejection reasons: Arabic verbatim + English, type
  const rejected = eff.filter((i) => i.decision === 'REJECTED');
  const rejection_reason_ar = rejected.map((i) => i.rejection_reason_ar).filter(Boolean).join(' | ') || null;
  const rejection_reason_en = rejected.map((i) => i.rejection_reason_en).filter(Boolean).join(' | ') || null;
  const types = [...new Set(rejected.map((i) => i.rejection_type).filter(Boolean))] as RejectionType[];
  const rejection_type = types[0] ?? null;
  const evidence_quote = (rejected[0] ?? eff.find((i) => i.evidence_quote))?.evidence_quote || null;

  let cap_gap: number | null = null;
  if (input.amountCap != null && input.resolvedTotal > input.amountCap) {
    cap_gap = add(input.resolvedTotal, -input.amountCap);
    reasons.push(`AMOUNT_CAP_EXCEEDED: resolved total ${input.resolvedTotal} > cap ${input.amountCap} (gap ${cap_gap})`);
  }

  const out = (status: ThreadStatus): DecideOutput => ({
    status,
    needs_human_review: review || status === 'UNCLEAR',
    reasons: [...new Set(reasons)],
    price_approval_required,
    cap_gap,
    rejection_reason_ar,
    rejection_reason_en,
    rejection_type,
    evidence_quote,
    requested_questions,
    partials,
  });

  // A human-set status is never overwritten.
  if (input.humanLockedStatus) return out(input.humanLockedStatus);

  // confidence < 0.80 ⇒ UNCLEAR + human review; UNCLEAR is never auto-approved.
  if (input.confidence < CONFIDENCE_FLOOR) {
    reasons.push(`LOW_CONFIDENCE: ${input.confidence}`);
    review = true;
    return out('UNCLEAR');
  }
  if (input.conflicts.length) {
    reasons.push(...input.conflicts.map((c) => `CONFLICT: ${c.item} — ${c.quotes.join('  ⟷  ')}`));
    review = true;
    return out('UNCLEAR');
  }
  if (reasons.some((r) => r.startsWith('UNCLEAR:'))) {
    review = true;
    return out('UNCLEAR');
  }

  const addressed = eff.filter((i) => i.decision !== 'NOT_ADDRESSED' && i.decision !== 'PENDING');
  if (!eff.length || !addressed.length) return out('PENDING');

  const allRejected = eff.every((i) => i.decision === 'REJECTED');
  if (allRejected) return out('REJECTED');

  const outstanding = eff.some((i) => i.decision !== 'APPROVED' && i.decision !== 'REJECTED');
  const anyRejected = rejected.length > 0;
  const priceOutstanding = price_approval_required && input.priceApprovalStatus !== 'APPROVED';

  const allApproved = eff.every((i) => i.decision === 'APPROVED');
  if (allApproved && !partials.length && !outstanding && !blockers.length && !priceOutstanding && cap_gap === null) return out('APPROVED');

  if (priceOutstanding) reasons.push('PRICE_APPROVAL_PENDING: status cannot be APPROVED until Corporate Sales reports the insurer decision');
  if (anyRejected || outstanding || partials.length || blockers.length || priceOutstanding || cap_gap !== null) return out('PARTIAL');
  return out('PARTIAL');
}
