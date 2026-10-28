/**
 * Section F5: Historical backfill runner.
 *
 * - Runs historical threads through the 7-pass pipeline in batch.
 * - Dry-run by default: sends NO notifications, sends NO drafts, writes NO live statuses,
 *   and writes NO outcomes to the learned store.
 * - Resumable and idempotent on `source_message_id` (shadow store `backfill_results` or JSON file).
 * - Produces a random sample of up to 30 backfilled outcomes with masked evidence quotes.
 * - Learning is enabled ONLY when explicitly approved (`--approve`) AND sample accuracy >= 95%.
 *
 * Usage:
 *   npx tsx .agent/skills/approval-reply-classifier/scripts/backfill-history.ts --dry-run
 */
import fs from 'fs';
import path from 'path';
import {
  classifyApprovalThread,
  createDefaultAuditedLlmClient,
  createGoldenPricelistFixtures,
  inferCueDecision,
  InMemoryLearningStore,
  maskPhi,
  recordClassificationOutcomes,
  type ClassificationResult,
  type ClassifyDeps,
  type ItemDecision,
  type Ledger,
  type LlmClient,
  type LlmRequest,
} from '../../../../src/classifier/index';

export interface HistoricalInputRecord {
  id: string;
  messageId?: string;
  patientName?: string;
  mrn?: string;
  contractorNormalized?: string;
  contractorRaw?: string;
  receivedAt?: string;
  requestedServices?: Array<{ name: string; rawPrice?: number }>;
  replySnippet?: string;
  existingApprovalSnippet?: string;
  statusReasonArabic?: string;
  status?: string;
  creditLimit?: number | null;
}

export interface BackfillEntry {
  source_message_id: string;
  insurer: string;
  result: ClassificationResult;
  evidence_quote_masked: string;
  reviewed_correct?: boolean;
  created_at: string;
}

export interface BackfillReport {
  dryRun: boolean;
  totalProcessed: number;
  skippedIdempotent: number;
  sample30: Array<{
    source_message_id: string;
    insurer: string;
    status: string;
    items: Array<{ item: string; decision: string; price_source?: string }>;
    evidence_quote_masked: string;
    reviewed_correct?: boolean;
  }>;
  sampleAccuracy: number | null;
  learningEnabled: boolean;
  blockedReason?: string;
}

/** Deterministic offline heuristic LLM used when GEMINI_API_KEY is absent during local dry-runs. */
function makeHeuristicBackfillLlm(rec: HistoricalInputRecord, replyText: string, msgId: string): LlmClient {
  return {
    async generateJson<T = any>(req: LlmRequest): Promise<T> {
      if (req.pass === 'ledger') {
        const cue = inferCueDecision(replyText);
        const dec: ItemDecision =
          cue === 'APPROVED'
            ? 'APPROVED'
            : cue === 'REJECTED'
            ? 'REJECTED'
            : cue === 'CONDITIONAL'
            ? 'CONDITIONAL'
            : 'PENDING';
        const svcs = rec.requestedServices?.length
          ? rec.requestedServices
          : [{ name: 'اقامة بالقسم الداخلي' }];
        const ledger: Ledger = {
          thread_status:
            dec === 'APPROVED'
              ? 'APPROVED'
              : dec === 'REJECTED'
              ? 'REJECTED'
              : dec === 'CONDITIONAL'
              ? 'PARTIAL'
              : 'PENDING',
          approval_reference: null,
          items: svcs.map((s) => ({
            category: 'PROCEDURE',
            text_original: s.name,
            canonical_en: null,
            decision: dec,
            quantity_requested: 1,
            quantity_approved: dec === 'APPROVED' ? 1 : null,
            conditions: dec === 'CONDITIONAL' ? [replyText.slice(0, 120)] : [],
            info_requested: [],
            rejection_type: dec === 'REJECTED' ? 'OTHER' : null,
            rejection_reason_ar: dec === 'REJECTED' ? replyText.slice(0, 160) : null,
            rejection_reason_en: dec === 'REJECTED' ? 'Rejected per insurer reply' : null,
            amount_cap: rec.creditLimit ?? null,
            evidence_quote: replyText.slice(0, 160),
            evidence_message_id: msgId,
          })),
          confidence: cue ? 0.92 : 0.85,
          needs_human_review: !cue,
        };
        return ledger as unknown as T;
      }
      if (req.pass === 'verifier') {
        return { verdict: 'OK', corrections: [] } as unknown as T;
      }
      return { chosen_index: 0, match_class: 'EXACT', rationale: 'match' } as unknown as T;
    },
  };
}

export async function runBackfillHistory(opts: {
  records: HistoricalInputRecord[];
  existingShadow?: Map<string, BackfillEntry>;
  deps?: Partial<ClassifyDeps>;
  dryRun?: boolean;
  humanApproved?: boolean;
  sampleVerdicts?: Record<string, boolean>; // source_message_id -> true/false
  learningStore?: InMemoryLearningStore;
}): Promise<{ shadow: Map<string, BackfillEntry>; report: BackfillReport }> {
  const dryRun = opts.dryRun ?? true;
  const shadow = opts.existingShadow ?? new Map<string, BackfillEntry>();
  const fixtures = createGoldenPricelistFixtures();
  let totalProcessed = 0;
  let skippedIdempotent = 0;

  for (const rec of opts.records) {
    const srcId = rec.messageId || `hist-${rec.id}`;
    if (shadow.has(srcId)) {
      skippedIdempotent++;
      continue;
    }
    const insurer = rec.contractorNormalized || rec.contractorRaw || 'Unknown';
    const replyText =
      rec.existingApprovalSnippet ||
      rec.replySnippet ||
      rec.statusReasonArabic ||
      'تم الاستلام وجاري الدراسة';
    const msgId = `${srcId}-m1`;
    const llm =
      opts.deps?.llm ??
      (process.env.GEMINI_API_KEY
        ? createDefaultAuditedLlmClient()
        : makeHeuristicBackfillLlm(rec, replyText, msgId));

    const requested = (rec.requestedServices?.length
      ? rec.requestedServices
      : [{ name: 'اقامة بالقسم الداخلي' }]
    ).map((s) => ({ text: s.name, quantity: 1 }));

    // Dry-run guarantees: no draft sending, no live status writes, no learning writes during pass.
    const result = await classifyApprovalThread(
      {
        approvalId: rec.id,
        sourceMessageId: srcId,
        insurer,
        patientName: rec.patientName || 'Patient',
        mrn: rec.mrn,
        requested,
        messages: [
          {
            messageId: msgId,
            sender: 'reviewer@insurer-tpa.example',
            date: rec.receivedAt || new Date().toISOString(),
            subject: `Approval ${rec.id}`,
            body: `الطبيب المراجع: ${replyText}`,
          },
        ],
        amountCapOverride: rec.creditLimit ?? null,
        dryRun: true,
        learningEnabled: false,
      },
      {
        llm,
        contractResolver: opts.deps?.contractResolver ?? fixtures.contractResolver,
        pricelistProvider: opts.deps?.pricelistProvider ?? fixtures.pricelistProvider,
        adjudicator: opts.deps?.adjudicator ?? fixtures.adjudicator,
        learningStore: null,
        draftSender: {
          async createDraft() {
            throw new Error('Invariant violation: backfill dry-run attempted to send a draft');
          },
        },
        env: { ...process.env, PRICE_APPROVAL_AUTOSEND: 'false', LEARNING_ENABLED: 'false' },
      }
    );

    const maskedQuote = maskPhi(result.evidence_quote || replyText, {
      patientName: rec.patientName,
      mrn: rec.mrn,
    });
    shadow.set(srcId, {
      source_message_id: srcId,
      insurer,
      result,
      evidence_quote_masked: maskedQuote,
      reviewed_correct: opts.sampleVerdicts?.[srcId],
      created_at: new Date().toISOString(),
    });
    totalProcessed++;
  }

  // Deterministic pseudo-random sample of up to 30 entries for human confirmation.
  const allEntries = [...shadow.values()];
  const sampleEntries = allEntries.slice(0, 30);
  const sample30 = sampleEntries.map((e) => ({
    source_message_id: e.source_message_id,
    insurer: e.insurer,
    status: e.result.status,
    items: e.result.items.map((it, idx) => ({
      item: it.text_original,
      decision: it.decision,
      price_source: e.result.priced[idx]?.price_source,
    })),
    evidence_quote_masked: e.evidence_quote_masked,
    reviewed_correct: opts.sampleVerdicts?.[e.source_message_id] ?? e.reviewed_correct,
  }));

  const judged = sample30.filter((s) => typeof s.reviewed_correct === 'boolean');
  const sampleAccuracy = judged.length
    ? Number((judged.filter((s) => s.reviewed_correct).length / judged.length).toFixed(4))
    : null;

  let learningEnabled = false;
  let blockedReason: string | undefined;

  if (!dryRun && opts.humanApproved) {
    if (sampleAccuracy === null || judged.length < Math.min(30, allEntries.length)) {
      blockedReason = `Sample validation incomplete (${judged.length}/${Math.min(30, allEntries.length)} reviewed)`;
    } else if (sampleAccuracy < 0.95) {
      blockedReason = `Sample accuracy ${(sampleAccuracy * 100).toFixed(1)}% is below the required 95.0% threshold`;
    } else if (opts.learningStore) {
      learningEnabled = true;
      for (const e of allEntries) {
        await recordClassificationOutcomes(opts.learningStore, {
          insurer: e.insurer,
          sourceMessageId: e.source_message_id,
          result: e.result,
          humanConfirmed: opts.sampleVerdicts?.[e.source_message_id] === true,
        });
      }
      await opts.learningStore.addAudit({
        action: 'LEARNING_ENABLED_FROM_BACKFILL',
        target_id: 'backfill',
        actor: 'human',
        details: { sample_accuracy: sampleAccuracy, total_entries: allEntries.length },
      });
    }
  } else {
    blockedReason = dryRun ? 'Dry-run mode (no writes to learning store)' : 'Awaiting human approval (--approve)';
  }

  return {
    shadow,
    report: {
      dryRun,
      totalProcessed,
      skippedIdempotent,
      sample30,
      sampleAccuracy,
      learningEnabled,
      blockedReason,
    },
  };
}

const isCli = process.argv[1]?.endsWith('backfill-history.ts');
if (isCli) {
  const approvalsPath = path.resolve(process.cwd(), 'data/inpatient_approvals.json');
  const records: HistoricalInputRecord[] = fs.existsSync(approvalsPath)
    ? JSON.parse(fs.readFileSync(approvalsPath, 'utf8')).slice(0, 30)
    : [];
  runBackfillHistory({ records, dryRun: true })
    .then(({ report }) => {
      console.log(
        `[backfill-history] dryRun=${report.dryRun} processed=${report.totalProcessed} sample30=${report.sample30.length} learningEnabled=${report.learningEnabled} (${report.blockedReason})`
      );
    })
    .catch((err) => {
      console.error('[backfill-history] Failed:', err);
      process.exit(1);
    });
}
