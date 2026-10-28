/**
 * Section H: Notification formatter. Produces the structured Arabic/English summary with:
 * - Status, per-item decisions, requested items/questions, or rejection reason (AR verbatim + EN)
 * - Compact two-tier price table (Contract vs موافقة سعرية) with grand totals per source
 * - "Historical pattern (advisory, not a decision)" per item where history exists + anomaly flags
 * - Price-approval draft preview awaiting review
 * - Confirmation / correction prompt
 */
import { fmtEgp } from './draft';
import type { ClassificationResult, HistoryHint, PricedLine } from './types';

function formatHistoryLine(h: HistoryHint | undefined): string {
  if (!h) return '';
  if (h.insufficient) {
    return `Historical pattern (advisory, not a decision): insufficient history (n=${h.n})`;
  }
  const parts: string[] = [
    `Historical pattern (advisory, not a decision): n=${h.n}, approved ${h.approved_pct}% (${h.approved_n}), conditional ${h.conditional_n}, rejected ${h.rejected_pct}% (${h.rejected_n})`,
  ];
  if (h.usual_documents?.length) parts.push(`usual docs: ${h.usual_documents.join(', ')}`);
  if (h.usual_conditions?.length) parts.push(`usual conditions: ${h.usual_conditions.join(', ')}`);
  if (h.typical_approved_qty != null) parts.push(`typical qty: ${h.typical_approved_qty}`);
  if (h.possible_policy_change) parts.push('⚠️ possible policy change');
  return parts.join(' | ');
}

function sourceLabel(s: PricedLine['price_source']): string {
  if (s === 'CONTRACT') return 'Contract';
  if (s === 'LIST_2026_PRICE_APPROVAL') return 'موافقة سعرية';
  return s;
}

export function formatClassificationNotification(
  res: ClassificationResult,
  meta: { approvalId?: string; patientName?: string; insurer?: string } = {}
): string {
  const lines: string[] = [];
  lines.push(`=== Approval Classification: ${res.status}${res.needs_human_review ? ' [NEEDS HUMAN REVIEW]' : ''} ===`);
  if (meta.patientName || meta.insurer) {
    lines.push(`Patient: ${meta.patientName ?? 'N/A'} | Insurer: ${meta.insurer ?? 'N/A'} | Ref: ${res.approval_reference ?? 'N/A'}`);
  }

  lines.push('\n-- Per-Item Decisions --');
  res.items.forEach((it, idx) => {
    const qty =
      it.quantity_approved != null || it.quantity_requested != null
        ? ` (approved ${it.quantity_approved ?? '?'} of ${it.quantity_requested ?? '?'})`
        : '';
    lines.push(`${idx + 1}. [${it.category}] ${it.text_original}${it.canonical_en ? ` (${it.canonical_en})` : ''}: ${it.decision}${qty}`);
    if (it.conditions?.length) lines.push(`   Conditions: ${it.conditions.join('; ')}`);
    if (it.info_requested?.length) lines.push(`   Requested info/docs: ${it.info_requested.join('; ')}`);
    if (it.decision === 'REJECTED') {
      lines.push(`   Rejection (${it.rejection_type ?? 'OTHER'}): AR="${it.rejection_reason_ar ?? it.evidence_quote}" | EN="${it.rejection_reason_en ?? 'N/A'}"`);
    }
    const hint = res.history_hints.find((h) => h.item_index === idx);
    const hl = formatHistoryLine(hint);
    if (hl) lines.push(`   ${hl}`);
  });

  if (res.requested_questions.length) {
    lines.push('\n-- Questions / Documents Requested by Insurer --');
    for (const q of res.requested_questions) lines.push(`- ${q.item}: ${q.question}`);
  }

  lines.push('\n-- Price Table (EGP) --');
  lines.push('Item | Qty | Unit Price | Total | Source');
  for (const p of res.priced) {
    const unit = p.unit_price != null ? `EGP ${fmtEgp(p.unit_price)}` : '—';
    const tot = p.line_total != null ? `EGP ${fmtEgp(p.line_total)}` : '—';
    lines.push(`${p.item} | ${p.qty} | ${unit} | ${tot} | ${sourceLabel(p.price_source)}`);
    if (p.review_candidates?.length) {
      const cands = p.review_candidates.map((c) => `${c.name_en} (EGP ${fmtEgp(c.contract_price)}, score ${c.score})`).join('; ');
      lines.push(`   Candidates for review: ${cands}`);
    }
  }
  lines.push(`Contract Grand Total: EGP ${fmtEgp(res.contract_total)}`);
  lines.push(`موافقة سعرية Grand Total: EGP ${fmtEgp(res.price_approval_total)}`);
  if (res.cap_gap != null) {
    lines.push(`⚠️ Amount cap (${fmtEgp(res.amount_cap!)}) exceeded by EGP ${fmtEgp(res.cap_gap)}`);
  }

  if (res.anomalies.length) {
    lines.push('\n-- Advisory Anomaly Flags --');
    for (const a of res.anomalies) lines.push(`- ${a}`);
  }

  if (res.review_reasons.length) {
    lines.push('\n-- Review Reasons --');
    for (const r of res.review_reasons) lines.push(`- ${r}`);
  }

  if (res.price_approval_draft_en) {
    lines.push(`\n-- Price Approval Draft (${res.price_approval_status ?? 'DRAFT'}) --`);
    lines.push(res.price_approval_draft_en);
  }

  if (meta.approvalId) {
    lines.push(`\nConfirm or correct via UI toggle or POST /api/approvals/${meta.approvalId}/status (sets HUMAN_CONFIRMED).`);
  }
  return lines.join('\n');
}
