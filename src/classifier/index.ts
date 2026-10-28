/**
 * Main 7-pass approval-reply classification and two-tier pricing orchestrator.
 *
 * Passes:
 *   1. Thread reconstruction + attachment OCR + auto-reply filtering
 *   2. Per-item decision ledger (Gemini, temperature 0, JSON schema)
 *   3. Independent verifier (separate Gemini call + deterministic cue checks)
 *   4. Medical coverage matching (glossary + top-5 candidates + Gemini adjudicator + code guards)
 *   5. Two-tier pricing in code (Contractor pricelist first, then 2026 gross list as موافقة سعرية)
 *   6. Scope and quantity separation
 *   7. Advisory history check (learned stats; never changes status, coverage, or price)
 *
 * Idempotent on source_message_id. Never overwrites a human-locked status.
 */
import { type KnownDemographics } from '../lib/deidentifier';
import { setApprovedAliasRules } from './glossary';
import { type Adjudicator, type Adjudication } from './coverage';
import { decide } from './decide';
import {
  buildPriceApprovalDraft,
  ewsDraftSender,
  loadRecipientConfig,
  mayAutoSend,
  sendPriceApprovalDraft,
  type DraftSender,
  type RecipientConfig,
} from './draft';
import {
  checkHistory,
  getActiveRules,
  recordClassificationOutcomes,
  retrieveFewShotsForLedger,
  type LearningStore,
} from './learning/store';
import {
  enforceScope,
  resolveRevisions,
  runLedgerPass,
  validateLedger,
  type RequestedItem,
} from './ledger';
import {
  AuditedLlmClient,
  GeminiLlmClient,
  MODELS,
  SupabaseLlmAuditSink,
  type LlmClient,
} from './llm';
import { extractAttachmentText, type BinaryAttachment } from './ocr';
import {
  CashDataPricelistProvider,
  DefaultContractResolver,
  type ContractResolver,
  type PricelistProvider,
} from './pricelist';
import { priceItems } from './pricing';
import { ADJUDICATOR_JSON_SCHEMA, ADJUDICATOR_SYSTEM_PROMPT } from './prompts';
import { extractApprovalReference, reconstructThread } from './text';
import type {
  Candidate,
  ClassificationResult,
  RawThreadMessage,
  ThreadStatus,
} from './types';
import { runVerifier } from './verifier';

export * from './types';
export * from './text';
export * from './glossary';
export * from './coverage';
export * from './pricelist';
export * from './pricing';
export * from './patterns';
export * from './ledger';
export * from './verifier';
export * from './decide';
export * from './draft';
export * from './ocr';
export * from './notify';
export * from './llm';
export * from './prompts';
export * from './learning/store';
export * from './learning/supabaseStore';
export * from './eval';

export class LlmAdjudicator implements Adjudicator {
  constructor(
    private llm: LlmClient,
    private ctx: { known?: KnownDemographics; approvalKey?: string } = {}
  ) {}
  async adjudicate(item: { text: string; canonical_en: string | null }, candidates: Candidate[]): Promise<Adjudication> {
    const candList = candidates
      .map((c, idx) => `${idx}: [code=${c.row.code ?? 'none'}] EN="${c.row.nameEn}" | AR="${c.row.nameAr}"`)
      .join('\n');
    const prompt = `REQUESTED ITEM: "${item.text}"${item.canonical_en ? ` (canonical: "${item.canonical_en}")` : ''}\n\nCANDIDATES:\n${candList}`;
    return this.llm.generateJson<Adjudication>({
      pass: 'adjudicator',
      model: MODELS.flash,
      system: ADJUDICATOR_SYSTEM_PROMPT,
      prompt,
      schema: ADJUDICATOR_JSON_SCHEMA,
      known: this.ctx.known,
      approvalKey: this.ctx.approvalKey,
    });
  }
}

export interface ClassifyThreadInput {
  approvalId?: string;
  sourceMessageId: string;
  insurer: string;
  patientName: string;
  mrn?: string;
  bed?: string;
  physician?: string;
  requested: RequestedItem[];
  messages: Array<
    Omit<RawThreadMessage, 'attachments'> & {
      attachments?: Array<BinaryAttachment | { name: string; text: string }>;
    }
  >;
  amountCapOverride?: number | null;
  priceApprovalStatus?: 'DRAFT' | 'SENT' | 'APPROVED' | 'REFUSED' | null;
  humanLockedStatus?: ThreadStatus | null;
  alreadyClassifiedSourceMessageId?: string | null;
  previousResult?: ClassificationResult | null;
  dryRun?: boolean;
  learningEnabled?: boolean;
}

export interface ClassifyDeps {
  llm: LlmClient;
  contractResolver?: ContractResolver;
  pricelistProvider?: PricelistProvider;
  adjudicator?: Adjudicator;
  learningStore?: LearningStore | null;
  draftSender?: DraftSender;
  recipientConfig?: RecipientConfig;
  env?: Record<string, string | undefined>;
}

export function isClassifierEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.CLASSIFIER_ENABLED || '').toLowerCase() === 'true';
}

export function isLearningEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LEARNING_ENABLED || '').toLowerCase() === 'true';
}

export async function classifyApprovalThread(
  input: ClassifyThreadInput,
  deps: ClassifyDeps
): Promise<ClassificationResult> {
  // Idempotency: if this exact source_message_id was already classified, return the prior result.
  if (
    input.alreadyClassifiedSourceMessageId &&
    input.alreadyClassifiedSourceMessageId === input.sourceMessageId &&
    input.previousResult
  ) {
    return { ...input.previousResult, skipped: 'IDEMPOTENT' };
  }

  const known: KnownDemographics = {
    patientName: input.patientName,
    mrn: input.mrn,
    bed: input.bed,
    physician: input.physician,
  };
  const approvalKey = input.approvalId || input.sourceMessageId;

  // Apply only APPROVED alias rules from the learning store.
  if (deps.learningStore) {
    const aliasRules = await getActiveRules(deps.learningStore, input.insurer, 'ALIAS');
    setApprovedAliasRules(
      aliasRules
        .map((r) => ({ alias: String(r.payload?.alias || ''), canonical_en: String(r.payload?.canonical_en || '') }))
        .filter((x) => x.alias && x.canonical_en)
    );
  }

  // Pass 1: OCR any binary attachments, then reconstruct the thread.
  const rawWithText: RawThreadMessage[] = [];
  for (const m of input.messages) {
    const atts: Array<{ name: string; text: string }> = [];
    for (const a of m.attachments || []) {
      if ('text' in a && typeof a.text === 'string' && !('mimeType' in a)) {
        if (a.text) atts.push({ name: a.name, text: a.text });
      } else {
        const txt = await extractAttachmentText(deps.llm, a as BinaryAttachment, { known, approvalKey, env: deps.env });
        if (txt) atts.push({ name: a.name, text: txt });
      }
    }
    rawWithText.push({ ...m, attachments: atts });
  }
  const reconstructed = reconstructThread(rawWithText);

  // Few-shot retrieval (phrasing patterns only; no stats are passed to Pass 2).
  const primaryCategory = input.requested[0]?.category;
  const fewShots = await retrieveFewShotsForLedger(deps.learningStore, input.insurer, primaryCategory);

  // Pass 2: Per-item decision ledger.
  const ledgerRun = await runLedgerPass(deps.llm, {
    messages: reconstructed,
    requested: input.requested,
    fewShots,
    insurerName: input.insurer,
    known,
    approvalKey,
  });

  // Deterministic ledger validation (quote provenance, speaker role, auto-replies, bare acks, admin authority).
  const validated = validateLedger(ledgerRun.ledger, reconstructed, { requestedCount: Math.max(1, input.requested.length) });

  // Revisions & conflicts across messages + Pass 6 scope separation.
  const rev = resolveRevisions(validated.items, reconstructed);
  const scoped = enforceScope(rev.items, input.requested);

  // Pass 3: Independent verifier (separate Gemini call + deterministic cue checks).
  const verification = await runVerifier(deps.llm, {
    ledger: ledgerRun.ledger,
    items: scoped.items,
    messages: reconstructed,
    requestedTexts: input.requested.map((r) => r.text),
    known,
    approvalKey,
  });

  const reviewReasons = [
    ...(ledgerRun.ledger.review_reasons || []),
    ...validated.reasons,
    ...(verification.verdict === 'CORRECTIONS'
      ? verification.corrections.map((c) => `VERIFIER_DISAGREEMENT: ${c.item} — ${c.issue}`)
      : []),
  ];

  // Pass 4 & Pass 5: Coverage matching and two-tier pricing in code.
  const contractResolver = deps.contractResolver ?? new DefaultContractResolver();
  const pricelistProvider = deps.pricelistProvider ?? new CashDataPricelistProvider();
  const adjudicator = deps.adjudicator ?? new LlmAdjudicator(deps.llm, { known, approvalKey });

  const contract = await contractResolver.resolve(input.insurer);
  const contractRows = contract ? await pricelistProvider.loadRows(contract.year) : [];
  const list2026Rows = contract && contract.year === 2026 ? contractRows : await pricelistProvider.loadRows(2026);

  const pricing = await priceItems({
    items: scoped.items,
    contract,
    contractRows,
    list2026Rows,
    deps: { adjudicator },
  });
  reviewReasons.push(...pricing.flags);

  // Amount cap from ledger items or explicit override.
  const itemCaps = scoped.items.map((i) => i.amount_cap).filter((c): c is number => typeof c === 'number' && c > 0);
  const amountCap = input.amountCapOverride ?? (itemCaps.length ? Math.min(...itemCaps) : null);

  // Pass 7: Advisory history check (snapshots items first to guarantee zero mutation).
  const snapshotBeforeHistory = JSON.stringify({
    items: scoped.items,
    priced: pricing.priced,
    coverage: pricing.coverage,
  });
  const history = await checkHistory(deps.learningStore, input.insurer, scoped.items);
  if (
    JSON.stringify({ items: scoped.items, priced: pricing.priced, coverage: pricing.coverage }) !==
    snapshotBeforeHistory
  ) {
    throw new Error('Invariant violation: checkHistory mutated ledger, coverage, or pricing');
  }
  if (history.anomalies.length) {
    reviewReasons.push(...history.anomalies);
  }

  // Section C: Final decision rules (history is NOT an input; anomalies only set needs_human_review).
  const decision = decide({
    items: scoped.items,
    confidence: ledgerRun.ledger.confidence,
    priced: pricing.priced,
    resolvedTotal: pricing.resolved_total,
    amountCap,
    conflicts: rev.conflicts,
    reviewReasons,
    priceApprovalStatus: input.priceApprovalStatus ?? null,
    humanLockedStatus: input.humanLockedStatus ?? null,
  });

  const needsHumanReview =
    decision.needs_human_review ||
    validated.needs_human_review ||
    verification.verdict === 'CORRECTIONS' ||
    history.anomalies.length > 0;

  // Section E: Price-approval draft (English, internal Corporate Sales only, only LIST_2026_PRICE_APPROVAL lines).
  const approvalRef =
    ledgerRun.ledger.approval_reference ||
    reconstructed.map((m) => extractApprovalReference(m.decisionText)).find(Boolean) ||
    null;

  const recipientCfg = deps.recipientConfig ?? loadRecipientConfig(deps.env);
  const draft = buildPriceApprovalDraft(
    {
      patientName: input.patientName,
      approvalRef,
      insurer: input.insurer,
      lines: pricing.priced,
    },
    recipientCfg
  );

  let priceApprovalStatus: ClassificationResult['price_approval_status'] =
    input.priceApprovalStatus ?? (draft ? 'DRAFT' : null);

  if (
    draft &&
    !input.dryRun &&
    priceApprovalStatus === 'DRAFT' &&
    mayAutoSend({ needsHumanReview, priced: pricing.priced, env: deps.env })
  ) {
    const sent = await sendPriceApprovalDraft(draft, deps.draftSender ?? ewsDraftSender, recipientCfg);
    if (sent.sent) priceApprovalStatus = 'SENT';
  }

  const result: ClassificationResult = {
    source_message_id: input.sourceMessageId,
    status: decision.status,
    approval_reference: approvalRef,
    items: scoped.items,
    confidence: ledgerRun.ledger.confidence,
    needs_human_review: needsHumanReview,
    review_reasons: decision.reasons,
    rejection_reason_ar: decision.rejection_reason_ar,
    rejection_reason_en: decision.rejection_reason_en,
    rejection_type: decision.rejection_type,
    evidence_quote: decision.evidence_quote,
    model_version: ledgerRun.model,
    verification,
    coverage: pricing.coverage,
    priced: pricing.priced,
    contractor_pricelist_id: pricing.contractor_pricelist_id,
    contract_total: pricing.contract_total,
    price_approval_total: pricing.price_approval_total,
    price_approval_required: decision.price_approval_required,
    price_approval_draft_en: draft?.body ?? null,
    price_approval_status: priceApprovalStatus,
    amount_cap: amountCap,
    cap_gap: decision.cap_gap,
    history_hints: history.hints,
    anomalies: history.anomalies,
    not_addressed: scoped.notAddressed,
    requested_questions: decision.requested_questions,
    conflicts: rev.conflicts,
    classified_at: new Date().toISOString(),
    ...(input.humanLockedStatus ? { skipped: 'HUMAN_LOCKED' as const } : {}),
  };

  // Section F4: event-driven outcome recording when learning is enabled and not in dry-run.
  const learnOn = input.learningEnabled ?? isLearningEnabled(deps.env);
  if (learnOn && !input.dryRun && deps.learningStore) {
    await recordClassificationOutcomes(deps.learningStore, {
      insurer: input.insurer,
      sourceMessageId: input.sourceMessageId,
      result,
      known,
    });
  }

  return result;
}

/**
 * Re-runs decision rules when Corporate Sales updates the insurer's price-approval outcome
 * ('APPROVED' | 'REFUSED'), without re-calling the LLM.
 */
export function applyPriceApprovalOutcome(
  previous: ClassificationResult,
  newPriceStatus: 'APPROVED' | 'REFUSED'
): ClassificationResult {
  const cleanReasons = previous.review_reasons.filter((r) => !r.startsWith('PRICE_APPROVAL_PENDING'));
  const decision = decide({
    items: previous.items,
    confidence: previous.confidence,
    priced: previous.priced,
    resolvedTotal: Number((previous.contract_total + previous.price_approval_total).toPrecision(12)),
    amountCap: previous.amount_cap,
    conflicts: previous.conflicts,
    reviewReasons: cleanReasons,
    priceApprovalStatus: newPriceStatus,
  });
  return {
    ...previous,
    status: decision.status,
    needs_human_review: decision.needs_human_review || previous.anomalies.length > 0,
    review_reasons: decision.reasons,
    rejection_reason_ar: decision.rejection_reason_ar ?? previous.rejection_reason_ar,
    rejection_reason_en: decision.rejection_reason_en ?? previous.rejection_reason_en,
    rejection_type: decision.rejection_type ?? previous.rejection_type,
    price_approval_status: newPriceStatus,
  };
}

export function createDefaultAuditedLlmClient(): LlmClient {
  return new AuditedLlmClient(new GeminiLlmClient(), new SupabaseLlmAuditSink());
}
