/**
 * Pass 3: independent verifier. A separate model call re-reads the ORIGINAL thread against
 * the ledger, plus deterministic cue checks in code so a negation error is caught even if the
 * model verifier misses it. Any disagreement ⇒ needs_human_review (status is not "fixed" by
 * the verifier; corrections are surfaced to a human).
 */
import { MODELS, type LlmClient } from './llm';
import { VERIFIER_JSON_SCHEMA, VERIFIER_SYSTEM_PROMPT } from './prompts';
import { inferCueDecision } from './patterns';
import type { ItemDecision, Ledger, LedgerItem, ReconstructedMessage, Verification } from './types';
import type { KnownDemographics } from '../lib/deidentifier';

const approvalLike = (d: ItemDecision) => d === 'APPROVED' || d === 'CONDITIONAL';

/** Deterministic cross-check: does the evidence quote's own wording contradict the decision? */
export function cueCorrections(items: LedgerItem[]): Verification['corrections'] {
  const out: Verification['corrections'] = [];
  for (const i of items) {
    if (!i.evidence_quote || i.decision === 'NOT_ADDRESSED') continue;
    const cue = inferCueDecision(i.evidence_quote);
    if (!cue) continue;
    const d = i.decision;
    let bad: string | null = null;
    if (cue === 'REJECTED' && approvalLike(d)) bad = `quote reads as a REJECTION but ledger says ${d}`;
    else if (cue === 'APPROVED' && d === 'REJECTED') bad = 'quote reads as an APPROVAL but ledger says REJECTED';
    else if (cue === 'CONDITIONAL' && d === 'APPROVED') bad = 'quote carries a condition/request but ledger says APPROVED (full)';
    else if (cue === 'PENDING' && (d === 'APPROVED' || d === 'REJECTED')) bad = `quote is an acknowledgement / under review but ledger says ${d}`;
    if (bad) out.push({ item: i.text_original, issue: bad, fix: `Re-read the quote "${i.evidence_quote}"; expected ${cue}` });
  }
  return out;
}

export function buildVerifierPrompt(ledger: Ledger, messages: ReconstructedMessage[], requestedTexts: string[]): string {
  const thread = messages
    .filter((m) => !m.isAutoReply)
    .map((m) => `[MESSAGE id=${m.messageId} role=${m.role} date=${m.date}]\nNEW:\n${m.newContent}\n${m.attachments.map((a) => `ATTACHMENT ${a.evidenceId}:\n${a.text.slice(0, 4000)}`).join('\n')}\nQUOTED:\n${m.quotedContent.slice(0, 1000)}`)
    .join('\n\n');
  return `REQUESTED ITEMS:\n${requestedTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nTHREAD:\n${thread}\n\nLEDGER (JSON):\n${JSON.stringify({ thread_status: ledger.thread_status, items: ledger.items }, null, 1)}`;
}

export async function runVerifier(
  llm: LlmClient,
  opts: {
    ledger: Ledger;
    items: LedgerItem[]; // post-validation items actually used downstream
    messages: ReconstructedMessage[];
    requestedTexts: string[];
    known?: KnownDemographics;
    approvalKey?: string;
    redact?: (s: string) => string;
  }
): Promise<Verification> {
  const redact = opts.redact ?? ((s: string) => s);
  const corrections: Verification['corrections'] = [...cueCorrections(opts.items)];
  try {
    const res: any = await llm.generateJson({
      pass: 'verifier',
      model: MODELS.flash,
      system: VERIFIER_SYSTEM_PROMPT,
      prompt: redact(buildVerifierPrompt({ ...opts.ledger, items: opts.items }, opts.messages, opts.requestedTexts)),
      schema: VERIFIER_JSON_SCHEMA,
      known: opts.known,
      approvalKey: opts.approvalKey,
    });
    if (res?.verdict === 'CORRECTIONS' && Array.isArray(res.corrections)) {
      for (const c of res.corrections) {
        if (c && typeof c.item === 'string') corrections.push({ item: c.item, issue: String(c.issue ?? ''), fix: String(c.fix ?? '') });
      }
      if (!res.corrections.length) corrections.push({ item: '*', issue: 'Verifier reported CORRECTIONS without detail', fix: '' });
    } else if (res?.verdict !== 'OK') {
      corrections.push({ item: '*', issue: 'Verifier returned an invalid verdict', fix: '' });
    }
  } catch (e: any) {
    // a verifier that cannot run is a disagreement we cannot rule out
    corrections.push({ item: '*', issue: `Verifier unavailable: ${e?.message || e}`, fix: '' });
  }
  return { verdict: corrections.length ? 'CORRECTIONS' : 'OK', corrections };
}
