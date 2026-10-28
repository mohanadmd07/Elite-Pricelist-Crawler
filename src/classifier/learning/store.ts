/**
 * Section F: Self-learning store, stats computation, Pass 7 history check, few-shot masking,
 * rule proposals, promotion gate, and forget command.
 *
 * Strict guarantees:
 * 1. Learned data contains NO patient identifiers (codes/enums/hashes only; few-shots masked).
 * 2. History is ADVISORY ONLY: checkHistory returns hints and anomaly flags, never mutates
 *    decisions, coverage, or prices.
 * 3. Per-insurer isolation: insurer A's stats are never queried for insurer B.
 * 4. Only finalized outcomes (APPROVED/REJECTED, or HUMAN_CONFIRMED) are learned.
 * 5. Only APPROVED rules are applied; promotions must pass the golden-set gate.
 */
import { assertZeroDemographics, type KnownDemographics } from '../../lib/deidentifier';
import { normalizeArabic } from '../../lib/arabic-normalizer';
import { aliasKey, normalizeItem } from '../glossary';
import { maskPhi } from '../llm';
import { patKey } from '../patterns';
import { sha256 } from '../text';
import type { FewShotExample } from '../ledger';
import type {
  ClassificationResult,
  HistoryHint,
  ItemCategory,
  LedgerItem,
  PricedLine,
  RejectionType,
  ThreadStatus,
} from '../types';

export type LabelSource = 'HUMAN_CONFIRMED' | 'AUTO_VERIFIED';
export type OutcomeDecision = 'approved' | 'conditional' | 'rejected';
export type RuleType = 'PHRASE' | 'ALIAS' | 'DOCUMENT_REQUIREMENT' | 'PRICELIST_SUGGESTION' | 'POLICY_NOTE';
export type RuleStatus = 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'RETIRED';

export interface ApprovalOutcomeRow {
  id: string; // sha256(source_approval_hash | canonical_procedure)
  insurer_id: string;
  canonical_procedure: string;
  category: ItemCategory;
  decision: OutcomeDecision;
  rejection_type: RejectionType | null;
  conditions: string[]; // controlled vocabulary codes ONLY
  info_requested: string[]; // controlled vocabulary codes ONLY
  quantity_requested: number | null;
  quantity_approved: number | null;
  amount_cap: number | null;
  copay_percent: number | null;
  validity_days: number | null;
  decided_at: string;
  turnaround_hours: number | null;
  label_source: LabelSource;
  source_approval_hash: string;
  contract_missing: boolean;
  observed_alias: string | null;
  created_at: string;
}

export interface InsurerProcedureStatsRow {
  insurer_id: string;
  canonical_procedure: string;
  n: number;
  approved_n: number;
  conditional_n: number;
  rejected_n: number;
  rejection_type_counts: Record<string, number>;
  top_conditions: string[];
  top_info_requested: string[];
  info_requested_counts: Record<string, number>;
  typical_approved_qty: number | null;
  weighted: { approved_share: number; conditional_share: number; rejected_share: number };
  recent_decisions: Array<{ decision: OutcomeDecision; decided_at: string }>;
  last_decided_at: string | null;
  window_months: number;
  updated_at: string;
}

export interface LearnedRuleRow {
  id: string;
  insurer_id: string | null;
  rule_key: string;
  rule_text: string;
  rule_type: RuleType;
  evidence_count: number;
  example_hashes: string[];
  status: RuleStatus;
  payload: Record<string, any>;
  proposed_at: string;
  decided_by: string | null;
  decided_at: string | null;
}

export interface FewShotPoolRow {
  id: string;
  insurer_id: string;
  category: ItemCategory;
  language: string;
  masked_snippet: string;
  expected_output: Record<string, any>;
  created_at: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  target_id: string | null;
  actor: string | null;
  details: Record<string, any>;
  created_at: string;
}

export interface CorrectionRow {
  id: string;
  approval_id: string;
  field: string;
  model_value: string | null;
  human_value: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

// ------------------------------------------------ controlled vocabularies ---

const DOC_CODES: Array<[string, RegExp]> = [
  ['MEDICAL_REPORT', /medical report|detailed report|clinical report|تقرير طبي|تقرير مفصل/i],
  ['ICD_CODE', /\bicd\b|icd[-\s]?10|تشخيص كودي|كود التشخيص/i],
  ['CLINICAL_INDICATION', /indication|justification|سبب طبي|دواعي|مبرر طبي/i],
  ['IMAGING_REPORT', /\b(ct|mri|ultrasound|echo|x-?ray|imaging|radiology)\b|اشعه|أشعة|رنين|مقطعيه|سونار|ايكو/i],
  ['LAB_RESULTS', /\b(lab|pathology|biopsy|culture|cbc|creatinine)\b|تحاليل|معمل|مزرعه|باثولوجي|عينه/i],
  ['CONSENT_OR_ID', /policy card|id copy|national id|صوره البطاقه|كارنيه|بطاقه التامين/i],
  ['OPERATIVE_NOTE', /operative|op note|surgical note|تقرير العمليه/i],
  ['COST_BREAKDOWN', /breakdown|itemized|تفصيل التكلفه|بيان اسعار|عرض سعر/i],
];

const CONDITION_CODES: Array<[string, RegExp]> = [
  ['COPAY_APPLIES', /co-?pay|patient share|تحمل|نسبه تحمل/i],
  ['AMOUNT_CAP', /max(imum)?|limit|cap\b|حد اقصي|بحد اقصي/i],
  ['LOS_LIMIT', /\bdays?\b|\bnights?\b|ايام|يوم فقط|لمده/i],
  ['PACKAGE_RATE', /package|شامل|باكدج/i],
  ['SINGLE_SESSION', /one session|single session|جلسه واحده/i],
  ['PRIOR_REPORT_REQUIRED', /report|تقرير|اشعه|تحاليل/i],
  ['NETWORK_PROVIDER_ONLY', /network|in-?network|داخل الشبكه/i],
];

export function canonicalizeInfoCodes(raw: string[] = []): string[] {
  const out = new Set<string>();
  for (const s of raw) {
    const t = patKey(s);
    let matched = false;
    for (const [code, re] of DOC_CODES) {
      if (re.test(t) || re.test(s)) {
        out.add(code);
        matched = true;
      }
    }
    if (!matched && t) out.add('OTHER_DOCUMENT');
  }
  return [...out];
}

export function canonicalizeConditionCodes(raw: string[] = []): string[] {
  const out = new Set<string>();
  for (const s of raw) {
    const t = patKey(s);
    let matched = false;
    for (const [code, re] of CONDITION_CODES) {
      if (re.test(t) || re.test(s)) {
        out.add(code);
        matched = true;
      }
    }
    if (!matched && t) out.add('OTHER_CONDITION');
  }
  return [...out];
}

/** Asserts that a text or serialized object contains zero patient demographic patterns. */
export function assertNoPhi(text: string, known?: KnownDemographics): void {
  const check = assertZeroDemographics(text, known);
  if (!check.isClean) {
    throw new Error(`PHI leak blocked in learning store: ${check.violations.join('; ')}`);
  }
  if (/\[PATIENT_NAME_REDACTED\]/.test(text)) return; // already masked placeholder is fine
  if (/(?:patient\s*name|اسم\s*المريض)\s*[:=]\s*\S+/i.test(text)) {
    throw new Error('PHI leak blocked: labeled patient name detected');
  }
}

export const insurerKey = (insurer: string): string => normalizeArabic(insurer || '').trim() || (insurer || '').trim().toLowerCase();

export const hashApprovalSource = (sourceMessageId: string): string =>
  sha256(`elite-outcome-v1|${sourceMessageId}`);

// ------------------------------------------------------------ store trait ---

export interface LearningStore {
  upsertOutcome(row: ApprovalOutcomeRow): Promise<void>;
  getOutcomesByInsurer(insurerId: string, canonicalProcedure?: string): Promise<ApprovalOutcomeRow[]>;
  getAllOutcomes(): Promise<ApprovalOutcomeRow[]>;
  deleteOutcome(idOrSourceHash: string): Promise<ApprovalOutcomeRow[]>;
  upsertStats(row: InsurerProcedureStatsRow): Promise<void>;
  getStats(insurerId: string, canonicalProcedure: string): Promise<InsurerProcedureStatsRow | null>;
  deleteStats(insurerId: string, canonicalProcedure: string): Promise<void>;
  upsertRule(row: LearnedRuleRow): Promise<LearnedRuleRow>;
  getRules(filter?: { insurerId?: string; status?: RuleStatus; type?: RuleType }): Promise<LearnedRuleRow[]>;
  updateRuleStatus(id: string, status: RuleStatus, decidedBy: string): Promise<LearnedRuleRow | null>;
  addFewShot(row: FewShotPoolRow): Promise<void>;
  getFewShots(insurerId: string, category?: ItemCategory, limit?: number): Promise<FewShotPoolRow[]>;
  addCorrection(row: Omit<CorrectionRow, 'id' | 'created_at'>): Promise<CorrectionRow>;
  addAudit(entry: Omit<AuditEntry, 'id' | 'created_at'>): Promise<AuditEntry>;
  getAudits(): Promise<AuditEntry[]>;
}

export class InMemoryLearningStore implements LearningStore {
  outcomes = new Map<string, ApprovalOutcomeRow>();
  stats = new Map<string, InsurerProcedureStatsRow>();
  rules = new Map<string, LearnedRuleRow>();
  fewShots = new Map<string, FewShotPoolRow>();
  corrections: CorrectionRow[] = [];
  audits: AuditEntry[] = [];

  async upsertOutcome(row: ApprovalOutcomeRow): Promise<void> {
    assertNoPhi(JSON.stringify(row));
    const existing = this.outcomes.get(row.id);
    // Human confirmation never gets overwritten by an auto label.
    if (existing && existing.label_source === 'HUMAN_CONFIRMED' && row.label_source === 'AUTO_VERIFIED') return;
    this.outcomes.set(row.id, row);
  }
  async getOutcomesByInsurer(insurerId: string, canonicalProcedure?: string): Promise<ApprovalOutcomeRow[]> {
    const k = insurerKey(insurerId);
    return [...this.outcomes.values()].filter(
      (o) => o.insurer_id === k && (!canonicalProcedure || o.canonical_procedure === canonicalProcedure)
    );
  }
  async getAllOutcomes(): Promise<ApprovalOutcomeRow[]> {
    return [...this.outcomes.values()];
  }
  async deleteOutcome(idOrSourceHash: string): Promise<ApprovalOutcomeRow[]> {
    const removed: ApprovalOutcomeRow[] = [];
    for (const [k, v] of this.outcomes) {
      if (k === idOrSourceHash || v.source_approval_hash === idOrSourceHash) {
        removed.push(v);
        this.outcomes.delete(k);
      }
    }
    return removed;
  }
  async upsertStats(row: InsurerProcedureStatsRow): Promise<void> {
    this.stats.set(`${row.insurer_id}|${row.canonical_procedure}`, row);
  }
  async getStats(insurerId: string, canonicalProcedure: string): Promise<InsurerProcedureStatsRow | null> {
    return this.stats.get(`${insurerKey(insurerId)}|${canonicalProcedure}`) ?? null;
  }
  async deleteStats(insurerId: string, canonicalProcedure: string): Promise<void> {
    this.stats.delete(`${insurerKey(insurerId)}|${canonicalProcedure}`);
  }
  async upsertRule(row: LearnedRuleRow): Promise<LearnedRuleRow> {
    const key = `${row.insurer_id ?? '*'}|${row.rule_key}`;
    for (const [id, existing] of this.rules) {
      if (`${existing.insurer_id ?? '*'}|${existing.rule_key}` === key) {
        // Never overwrite a human decision on a rule when re-proposing.
        const merged: LearnedRuleRow = {
          ...existing,
          evidence_count: row.evidence_count,
          example_hashes: row.example_hashes,
          payload: row.payload,
        };
        this.rules.set(id, merged);
        return merged;
      }
    }
    this.rules.set(row.id, row);
    return row;
  }
  async getRules(filter?: { insurerId?: string; status?: RuleStatus; type?: RuleType }): Promise<LearnedRuleRow[]> {
    const ins = filter?.insurerId ? insurerKey(filter.insurerId) : undefined;
    return [...this.rules.values()].filter(
      (r) =>
        (!ins || r.insurer_id === ins || r.insurer_id === null) &&
        (!filter?.status || r.status === filter.status) &&
        (!filter?.type || r.rule_type === filter.type)
    );
  }
  async updateRuleStatus(id: string, status: RuleStatus, decidedBy: string): Promise<LearnedRuleRow | null> {
    const r = this.rules.get(id);
    if (!r) return null;
    const updated: LearnedRuleRow = { ...r, status, decided_by: decidedBy, decided_at: new Date().toISOString() };
    this.rules.set(id, updated);
    return updated;
  }
  async addFewShot(row: FewShotPoolRow): Promise<void> {
    assertNoPhi(row.masked_snippet);
    assertNoPhi(JSON.stringify(row.expected_output));
    this.fewShots.set(row.id, row);
  }
  async getFewShots(insurerId: string, category?: ItemCategory, limit = 3): Promise<FewShotPoolRow[]> {
    const k = insurerKey(insurerId);
    const all = [...this.fewShots.values()].filter((f) => f.insurer_id === k);
    const exact = category ? all.filter((f) => f.category === category) : all;
    const pool = exact.length >= limit ? exact : [...exact, ...all.filter((f) => !exact.includes(f))];
    return pool.slice(0, limit);
  }
  async addCorrection(row: Omit<CorrectionRow, 'id' | 'created_at'>): Promise<CorrectionRow> {
    const full: CorrectionRow = { ...row, id: sha256(`${row.approval_id}|${row.field}|${Date.now()}`).slice(0, 24), created_at: new Date().toISOString() };
    this.corrections.push(full);
    return full;
  }
  async addAudit(entry: Omit<AuditEntry, 'id' | 'created_at'>): Promise<AuditEntry> {
    const full: AuditEntry = { ...entry, id: sha256(`${entry.action}|${entry.target_id}|${Date.now()}`).slice(0, 24), created_at: new Date().toISOString() };
    this.audits.push(full);
    return full;
  }
  async getAudits(): Promise<AuditEntry[]> {
    return [...this.audits];
  }
}

// --------------------------------------------------- F2: label eligibility --

export function isEligibleForLearning(opts: {
  status: ThreadStatus;
  confidence: number;
  needsHumanReview: boolean;
  verificationOk: boolean;
  humanConfirmed?: boolean;
}): { eligible: boolean; labelSource: LabelSource | null } {
  if (opts.humanConfirmed) {
    if (opts.status === 'PENDING' || opts.status === 'UNCLEAR') return { eligible: false, labelSource: null };
    return { eligible: true, labelSource: 'HUMAN_CONFIRMED' };
  }
  if (opts.needsHumanReview || !opts.verificationOk || opts.confidence < 0.9) {
    return { eligible: false, labelSource: null };
  }
  if (opts.status === 'APPROVED' || opts.status === 'REJECTED') {
    return { eligible: true, labelSource: 'AUTO_VERIFIED' };
  }
  return { eligible: false, labelSource: null };
}

function itemDecisionToOutcome(d: LedgerItem['decision']): OutcomeDecision | null {
  if (d === 'APPROVED') return 'approved';
  if (d === 'CONDITIONAL' || d === 'INFO_REQUESTED') return 'conditional';
  if (d === 'REJECTED') return 'rejected';
  return null;
}

function scrubbedAlias(text: string, canonical: string, known?: KnownDemographics): string | null {
  const masked = maskPhi(text, known).trim();
  if (!masked || masked.includes('[') || masked.length > 80) return null;
  if (aliasKey(masked) === aliasKey(canonical)) return null;
  return masked;
}

/**
 * Records finalized or human-confirmed outcomes for an approval and refreshes stats
 * for each touched (insurer, canonical_procedure). Idempotent on (sourceMessageId, procedure).
 */
export async function recordClassificationOutcomes(
  store: LearningStore,
  params: {
    insurer: string;
    sourceMessageId: string;
    result: Pick<ClassificationResult, 'status' | 'confidence' | 'needs_human_review' | 'verification' | 'items' | 'priced'>;
    decidedAt?: string;
    requestedAt?: string;
    humanConfirmed?: boolean;
    known?: KnownDemographics;
  }
): Promise<ApprovalOutcomeRow[]> {
  const elig = isEligibleForLearning({
    status: params.result.status,
    confidence: params.result.confidence,
    needsHumanReview: params.result.needs_human_review,
    verificationOk: !params.result.verification || params.result.verification.verdict === 'OK',
    humanConfirmed: params.humanConfirmed,
  });
  if (!elig.eligible || !elig.labelSource) return [];

  const ins = insurerKey(params.insurer);
  const srcHash = hashApprovalSource(params.sourceMessageId);
  const decidedAt = params.decidedAt || new Date().toISOString();
  const turnaround =
    params.requestedAt && !Number.isNaN(new Date(params.requestedAt).getTime())
      ? Math.max(0, Number(((new Date(decidedAt).getTime() - new Date(params.requestedAt).getTime()) / 3600000).toFixed(2)))
      : null;

  const written: ApprovalOutcomeRow[] = [];
  const touched = new Set<string>();

  for (let idx = 0; idx < params.result.items.length; idx++) {
    const it = params.result.items[idx];
    const dec = itemDecisionToOutcome(it.decision);
    if (!dec) continue;
    const norm = normalizeItem(it.text_original);
    const canonical = (it.canonical_en || norm.canonical_en || aliasKey(it.text_original)).trim();
    if (!canonical) continue;
    const priced: PricedLine | undefined = params.result.priced?.[idx];
    const contractMissing = dec === 'approved' && priced?.price_source === 'LIST_2026_PRICE_APPROVAL';
    let validityDays: number | null = null;
    if (it.validity_until) {
      const vd = Math.round((new Date(it.validity_until).getTime() - new Date(decidedAt).getTime()) / 86400000);
      if (Number.isFinite(vd) && vd > 0 && vd < 366) validityDays = vd;
    }
    const row: ApprovalOutcomeRow = {
      id: sha256(`${srcHash}|${canonical}`),
      insurer_id: ins,
      canonical_procedure: canonical,
      category: it.category,
      decision: dec,
      rejection_type: dec === 'rejected' ? (it.rejection_type ?? 'OTHER') : null,
      conditions: canonicalizeConditionCodes(it.conditions),
      info_requested: canonicalizeInfoCodes(it.info_requested),
      quantity_requested: it.quantity_requested ?? null,
      quantity_approved: it.quantity_approved ?? null,
      amount_cap: it.amount_cap ?? null,
      copay_percent: it.copay_percent ?? null,
      validity_days: validityDays,
      decided_at: decidedAt,
      turnaround_hours: turnaround,
      label_source: elig.labelSource,
      source_approval_hash: srcHash,
      contract_missing: contractMissing,
      observed_alias: scrubbedAlias(it.text_original, canonical, params.known),
      created_at: new Date().toISOString(),
    };
    await store.upsertOutcome(row);
    written.push(row);
    touched.add(canonical);
  }

  for (const proc of touched) {
    await recomputeStatsForPair(store, ins, proc);
  }
  return written;
}

// --------------------------------------------------- F4: stats computation --

export interface StatsOptions {
  windowMonths?: number;
  halfLifeMonths?: number;
  now?: Date;
}

export function computeStatsFromOutcomes(
  insurerId: string,
  canonicalProcedure: string,
  outcomes: ApprovalOutcomeRow[],
  opts: StatsOptions = {}
): InsurerProcedureStatsRow | null {
  const windowMonths = opts.windowMonths ?? (Number(process.env.LEARNING_WINDOW_MONTHS) || 24);
  const halfLifeMonths = opts.halfLifeMonths ?? (Number(process.env.LEARNING_HALF_LIFE_MONTHS) || 6);
  const now = opts.now ?? new Date();
  const cutoffMs = now.getTime() - windowMonths * 30.4375 * 86400000;
  const halfLifeMs = halfLifeMonths * 30.4375 * 86400000;

  const filtered = outcomes
    .filter((o) => o.insurer_id === insurerKey(insurerId) && o.canonical_procedure === canonicalProcedure)
    .filter((o) => new Date(o.decided_at).getTime() >= cutoffMs)
    .sort((a, b) => new Date(b.decided_at).getTime() - new Date(a.decided_at).getTime());

  if (!filtered.length) return null;

  let approved_n = 0;
  let conditional_n = 0;
  let rejected_n = 0;
  let wApp = 0;
  let wCond = 0;
  let wRej = 0;
  const rejCounts: Record<string, number> = {};
  const condCounts: Record<string, number> = {};
  const infoCounts: Record<string, number> = {};
  const qtys: number[] = [];

  for (const o of filtered) {
    const ageMs = Math.max(0, now.getTime() - new Date(o.decided_at).getTime());
    const decay = Math.pow(0.5, ageMs / halfLifeMs);
    const labelW = o.label_source === 'HUMAN_CONFIRMED' ? 1.0 : 0.5;
    const w = decay * labelW;
    if (o.decision === 'approved') {
      approved_n++;
      wApp += w;
    } else if (o.decision === 'conditional') {
      conditional_n++;
      wCond += w;
    } else {
      rejected_n++;
      wRej += w;
      const rt = o.rejection_type || 'OTHER';
      rejCounts[rt] = (rejCounts[rt] || 0) + 1;
    }
    for (const c of o.conditions) condCounts[c] = (condCounts[c] || 0) + 1;
    for (const d of o.info_requested) infoCounts[d] = (infoCounts[d] || 0) + 1;
    if (o.quantity_approved != null && o.quantity_approved > 0) qtys.push(o.quantity_approved);
  }

  const wSum = wApp + wCond + wRej || 1;
  qtys.sort((a, b) => a - b);
  const medianQty = qtys.length ? qtys[Math.floor(qtys.length / 2)] : null;
  const topKeys = (m: Record<string, number>) =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k]) => k);

  return {
    insurer_id: insurerKey(insurerId),
    canonical_procedure: canonicalProcedure,
    n: filtered.length,
    approved_n,
    conditional_n,
    rejected_n,
    rejection_type_counts: rejCounts,
    top_conditions: topKeys(condCounts),
    top_info_requested: topKeys(infoCounts),
    info_requested_counts: infoCounts,
    typical_approved_qty: medianQty,
    weighted: {
      approved_share: Number((wApp / wSum).toFixed(4)),
      conditional_share: Number((wCond / wSum).toFixed(4)),
      rejected_share: Number((wRej / wSum).toFixed(4)),
    },
    recent_decisions: filtered.slice(0, 10).map((o) => ({ decision: o.decision, decided_at: o.decided_at })),
    last_decided_at: filtered[0]?.decided_at ?? null,
    window_months: windowMonths,
    updated_at: now.toISOString(),
  };
}

export async function recomputeStatsForPair(
  store: LearningStore,
  insurerId: string,
  canonicalProcedure: string,
  opts?: StatsOptions
): Promise<InsurerProcedureStatsRow | null> {
  const outcomes = await store.getOutcomesByInsurer(insurerId, canonicalProcedure);
  const stats = computeStatsFromOutcomes(insurerId, canonicalProcedure, outcomes, opts);
  if (stats) await store.upsertStats(stats);
  else await store.deleteStats(insurerId, canonicalProcedure);
  return stats;
}

export async function recomputeAllStats(store: LearningStore, opts?: StatsOptions): Promise<number> {
  const all = await store.getAllOutcomes();
  const pairs = new Set(all.map((o) => `${o.insurer_id}|${o.canonical_procedure}`));
  let count = 0;
  for (const p of pairs) {
    const [ins, proc] = p.split('|');
    const s = computeStatsFromOutcomes(ins, proc, all, opts);
    if (s) {
      await store.upsertStats(s);
      count++;
    }
  }
  return count;
}

// ------------------------------------------------ Pass 7: history check -----

export const MIN_HISTORY_SAMPLE = 5;

export function detectDrift(recent: Array<{ decision: OutcomeDecision }>): boolean {
  if (recent.length < 6) return false;
  const last3 = recent.slice(0, 3).map((r) => r.decision);
  if (!last3.every((d) => d === last3[0])) return false;
  const older = recent.slice(3);
  const opposite = older.filter((r) => r.decision !== last3[0]).length;
  return opposite / older.length >= 0.7;
}

/**
 * Pass 7: produces advisory history hints and anomaly flags per item.
 * NEVER modifies items, decisions, coverage, prices, or status.
 */
export async function checkHistory(
  store: LearningStore | null | undefined,
  insurer: string,
  items: readonly LedgerItem[]
): Promise<{ hints: HistoryHint[]; anomalies: string[] }> {
  if (!store || !insurer) return { hints: [], anomalies: [] };
  const ins = insurerKey(insurer);
  const hints: HistoryHint[] = [];
  const anomalies: string[] = [];

  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const norm = normalizeItem(it.text_original);
    const canonical = (it.canonical_en || norm.canonical_en || aliasKey(it.text_original)).trim();
    const stats = canonical ? await store.getStats(ins, canonical) : null;

    if (!stats || stats.n < MIN_HISTORY_SAMPLE) {
      hints.push({
        item_index: idx,
        canonical_procedure: canonical,
        insufficient: true,
        n: stats?.n ?? 0,
        anomalies: [],
      });
      continue;
    }

    const itemAnomalies: string[] = [];
    const appPct = Math.round((stats.approved_n / stats.n) * 100);
    const rejPct = Math.round((stats.rejected_n / stats.n) * 100);
    const curApproved = it.decision === 'APPROVED' || it.decision === 'CONDITIONAL';
    const curRejected = it.decision === 'REJECTED';

    // 1. Contradicts strong history (>= 5 outcomes and >= 80% the other way).
    if (curApproved && stats.rejected_n / stats.n >= 0.8) {
      itemAnomalies.push(`ANOMALY_CONTRADICTS_REJECT_HISTORY: ${canonical} approved but historically rejected ${rejPct}% (${stats.rejected_n}/${stats.n})`);
    } else if (curRejected && stats.approved_n / stats.n >= 0.8) {
      itemAnomalies.push(`ANOMALY_CONTRADICTS_APPROVE_HISTORY: ${canonical} rejected but historically approved ${appPct}% (${stats.approved_n}/${stats.n})`);
    }

    // 2. Historical COVERAGE_EXCLUSION but current thread approves.
    if (curApproved && (stats.rejection_type_counts['COVERAGE_EXCLUSION'] || 0) > 0) {
      itemAnomalies.push(`ANOMALY_PRIOR_COVERAGE_EXCLUSION: ${canonical} has prior COVERAGE_EXCLUSION rejections for this insurer`);
    }

    // 3. Thread requests documents or conditions never seen before for this procedure.
    const curDocs = canonicalizeInfoCodes(it.info_requested).filter((c) => c !== 'OTHER_DOCUMENT');
    const unseenDocs = curDocs.filter((d) => !stats.info_requested_counts[d]);
    if (unseenDocs.length) {
      itemAnomalies.push(`ANOMALY_NEW_DOCUMENT_REQUEST: ${canonical} requests [${unseenDocs.join(', ')}] not seen in ${stats.n} prior outcomes`);
    }

    // 4. Possible policy change: 3 most recent outcomes diverge from earlier pattern.
    const drift = detectDrift(stats.recent_decisions);
    if (drift) {
      itemAnomalies.push(`ANOMALY_POSSIBLE_POLICY_CHANGE: ${canonical} recent 3 outcomes diverge from earlier pattern`);
    }

    const topRej = Object.entries(stats.rejection_type_counts)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }));

    hints.push({
      item_index: idx,
      canonical_procedure: canonical,
      insufficient: false,
      n: stats.n,
      approved_n: stats.approved_n,
      conditional_n: stats.conditional_n,
      rejected_n: stats.rejected_n,
      approved_pct: appPct,
      rejected_pct: rejPct,
      top_rejection_types: topRej,
      usual_conditions: stats.top_conditions,
      usual_documents: stats.top_info_requested,
      typical_approved_qty: stats.typical_approved_qty,
      last_decided_at: stats.last_decided_at,
      possible_policy_change: drift,
      anomalies: itemAnomalies,
    });
    anomalies.push(...itemAnomalies);
  }

  return { hints, anomalies };
}

/** Pre-emptive guidance for a new request before the insurer replies. */
export async function getPreemptiveGuidance(
  store: LearningStore,
  insurer: string,
  procedureTexts: string[]
): Promise<Array<{ procedure: string; usual_documents: string[]; top_rejection_types: string[]; sample_size: number }>> {
  const ins = insurerKey(insurer);
  const out: Array<{ procedure: string; usual_documents: string[]; top_rejection_types: string[]; sample_size: number }> = [];
  for (const t of procedureTexts) {
    const canonical = normalizeItem(t).canonical_en || aliasKey(t);
    const s = await store.getStats(ins, canonical);
    if (!s || s.n < MIN_HISTORY_SAMPLE) continue;
    out.push({
      procedure: canonical,
      usual_documents: s.top_info_requested,
      top_rejection_types: Object.keys(s.rejection_type_counts),
      sample_size: s.n,
    });
  }
  return out;
}

// --------------------------------------------------- F6: few-shot pool ------

export async function addMaskedFewShot(
  store: LearningStore,
  params: {
    insurer: string;
    category: ItemCategory;
    rawSnippet: string;
    expectedOutput: Record<string, any>;
    known?: KnownDemographics;
    language?: string;
  }
): Promise<FewShotPoolRow> {
  const masked_snippet = maskPhi(params.rawSnippet, params.known);
  const cleanExpected = JSON.parse(maskPhi(JSON.stringify(params.expectedOutput), params.known));
  assertNoPhi(masked_snippet, params.known);
  assertNoPhi(JSON.stringify(cleanExpected), params.known);
  const row: FewShotPoolRow = {
    id: sha256(`${insurerKey(params.insurer)}|${params.category}|${masked_snippet}`).slice(0, 32),
    insurer_id: insurerKey(params.insurer),
    category: params.category,
    language: params.language || 'ar',
    masked_snippet,
    expected_output: cleanExpected,
    created_at: new Date().toISOString(),
  };
  await store.addFewShot(row);
  return row;
}

export async function retrieveFewShotsForLedger(
  store: LearningStore | null | undefined,
  insurer: string,
  category?: ItemCategory
): Promise<FewShotExample[]> {
  if (!store || !insurer) return [];
  const rows = await store.getFewShots(insurer, category, 3);
  return rows.map((r) => {
    assertNoPhi(r.masked_snippet);
    const exp = JSON.stringify(r.expected_output);
    assertNoPhi(exp);
    return { snippet: r.masked_snippet, expected: exp };
  });
}

// --------------------------------------------------- F4/F6: learned rules ---

export async function proposeRulesFromOutcomes(store: LearningStore, minEvidence = 3): Promise<LearnedRuleRow[]> {
  const all = await store.getAllOutcomes();
  const proposed: LearnedRuleRow[] = [];

  // 1. PRICELIST_SUGGESTION: insurer repeatedly approves an item missing from its contractor list.
  const byMissing = new Map<string, ApprovalOutcomeRow[]>();
  for (const o of all) {
    if (o.decision === 'approved' && o.contract_missing) {
      const k = `${o.insurer_id}|${o.canonical_procedure}`;
      byMissing.set(k, [...(byMissing.get(k) || []), o]);
    }
  }
  for (const [k, rows] of byMissing) {
    if (rows.length < minEvidence) continue;
    const [ins, proc] = k.split('|');
    const rule = await store.upsertRule({
      id: sha256(`PRICELIST_SUGGESTION|${k}`).slice(0, 24),
      insurer_id: ins,
      rule_key: `PRICELIST_SUGGESTION:${proc}`,
      rule_type: 'PRICELIST_SUGGESTION',
      rule_text: `Insurer "${ins}" approved "${proc}" ${rows.length} times at 2026 price approval; suggest Corporate Sales negotiate adding it to the contractor pricelist.`,
      evidence_count: rows.length,
      example_hashes: rows.slice(0, 10).map((r) => r.source_approval_hash),
      status: 'PROPOSED',
      payload: { insurer_id: ins, canonical_procedure: proc },
      proposed_at: new Date().toISOString(),
      decided_by: null,
      decided_at: null,
    });
    proposed.push(rule);
  }

  // 2. DOCUMENT_REQUIREMENT: insurer repeatedly requests a document for a procedure.
  const byDoc = new Map<string, ApprovalOutcomeRow[]>();
  for (const o of all) {
    for (const d of o.info_requested) {
      if (d === 'OTHER_DOCUMENT') continue;
      const k = `${o.insurer_id}|${o.canonical_procedure}|${d}`;
      byDoc.set(k, [...(byDoc.get(k) || []), o]);
    }
  }
  for (const [k, rows] of byDoc) {
    if (rows.length < minEvidence) continue;
    const [ins, proc, doc] = k.split('|');
    const rule = await store.upsertRule({
      id: sha256(`DOCUMENT_REQUIREMENT|${k}`).slice(0, 24),
      insurer_id: ins,
      rule_key: `DOC:${proc}:${doc}`,
      rule_type: 'DOCUMENT_REQUIREMENT',
      rule_text: `Insurer "${ins}" requires ${doc} for "${proc}" (${rows.length} cases).`,
      evidence_count: rows.length,
      example_hashes: rows.slice(0, 10).map((r) => r.source_approval_hash),
      status: 'PROPOSED',
      payload: { insurer_id: ins, canonical_procedure: proc, document: doc },
      proposed_at: new Date().toISOString(),
      decided_by: null,
      decided_at: null,
    });
    proposed.push(rule);
  }

  // 3. ALIAS: scrubbed alias observed repeatedly for a canonical procedure.
  const byAlias = new Map<string, ApprovalOutcomeRow[]>();
  for (const o of all) {
    if (!o.observed_alias) continue;
    const k = `${aliasKey(o.observed_alias)}|${o.canonical_procedure}`;
    byAlias.set(k, [...(byAlias.get(k) || []), o]);
  }
  for (const [k, rows] of byAlias) {
    if (rows.length < minEvidence) continue;
    const [alias, proc] = k.split('|');
    const rule = await store.upsertRule({
      id: sha256(`ALIAS|${k}`).slice(0, 24),
      insurer_id: null,
      rule_key: `ALIAS:${alias}->${proc}`,
      rule_type: 'ALIAS',
      rule_text: `Alias "${rows[0].observed_alias}" maps to "${proc}" (${rows.length} cases).`,
      evidence_count: rows.length,
      example_hashes: rows.slice(0, 10).map((r) => r.source_approval_hash),
      status: 'PROPOSED',
      payload: { alias: rows[0].observed_alias, canonical_en: proc },
      proposed_at: new Date().toISOString(),
      decided_by: null,
      decided_at: null,
    });
    proposed.push(rule);
  }

  return proposed;
}

/** Returns ONLY rules with status === 'APPROVED'. PROPOSED / REJECTED / RETIRED are ignored. */
export async function getActiveRules(store: LearningStore, insurer?: string, type?: RuleType): Promise<LearnedRuleRow[]> {
  const rules = await store.getRules({ insurerId: insurer, status: 'APPROVED', type });
  return rules.filter((r) => r.status === 'APPROVED');
}

export interface GoldenGateMetrics {
  accuracy: number;
  falseApprovalCount: number;
}

/**
 * Promotes a rule to APPROVED only if running the golden-set evaluator after applying the
 * rule causes zero false approvals and does not lower accuracy. Logs every attempt.
 */
export async function promoteRuleWithGate(
  store: LearningStore,
  params: {
    ruleId: string;
    actor: string;
    baseline: GoldenGateMetrics;
    runGoldenSetWithCandidate: () => Promise<GoldenGateMetrics>;
  }
): Promise<{ promoted: boolean; reason?: string }> {
  const after = await params.runGoldenSetWithCandidate();
  if (after.falseApprovalCount > 0 || after.accuracy < params.baseline.accuracy) {
    const reason =
      after.falseApprovalCount > 0
        ? `Golden-set regression: ${after.falseApprovalCount} false approval(s)`
        : `Golden-set accuracy dropped from ${params.baseline.accuracy} to ${after.accuracy}`;
    await store.addAudit({
      action: 'PROMOTION_BLOCKED',
      target_id: params.ruleId,
      actor: params.actor,
      details: { baseline: params.baseline, after, reason },
    });
    return { promoted: false, reason };
  }
  await store.updateRuleStatus(params.ruleId, 'APPROVED', params.actor);
  await store.addAudit({
    action: 'PROMOTE_RULE',
    target_id: params.ruleId,
    actor: params.actor,
    details: { baseline: params.baseline, after },
  });
  return { promoted: true };
}

/**
 * F7: "forget" deletes an outcome (by id or source_approval_hash) or retires a rule,
 * recomputes affected stats, and writes an audit entry.
 */
export async function forgetOutcome(
  store: LearningStore,
  idOrSourceHash: string,
  actor = 'human',
  opts?: StatsOptions
): Promise<{ deletedCount: number }> {
  const removed = await store.deleteOutcome(idOrSourceHash);
  const pairs = new Set(removed.map((r) => `${r.insurer_id}|${r.canonical_procedure}`));
  for (const p of pairs) {
    const [ins, proc] = p.split('|');
    await recomputeStatsForPair(store, ins, proc, opts);
  }
  await store.addAudit({
    action: 'FORGET_OUTCOME',
    target_id: idOrSourceHash,
    actor,
    details: { deleted_count: removed.length, pairs: [...pairs] },
  });
  return { deletedCount: removed.length };
}

export async function retireRule(store: LearningStore, ruleId: string, actor = 'human'): Promise<LearnedRuleRow | null> {
  const updated = await store.updateRuleStatus(ruleId, 'RETIRED', actor);
  await store.addAudit({ action: 'RETIRE_RULE', target_id: ruleId, actor, details: { status: 'RETIRED' } });
  return updated;
}

/**
 * F2/F4: a human confirmation or correction overwrites the auto outcome for that approval,
 * logs the diff in classification_corrections, and refreshes stats.
 */
export async function applyHumanCorrection(
  store: LearningStore,
  params: {
    approvalId: string;
    insurer: string;
    sourceMessageId: string;
    field: string;
    modelValue: string | null;
    humanValue: string;
    updatedResult: Pick<ClassificationResult, 'status' | 'confidence' | 'needs_human_review' | 'verification' | 'items' | 'priced'>;
    decidedAt?: string;
    actor?: string;
    note?: string;
  }
): Promise<void> {
  await store.addCorrection({
    approval_id: params.approvalId,
    field: params.field,
    model_value: params.modelValue,
    human_value: params.humanValue,
    note: params.note ?? null,
    created_by: params.actor ?? 'human',
  });
  // Remove any prior auto outcomes for this message before writing the human-confirmed ones.
  await store.deleteOutcome(hashApprovalSource(params.sourceMessageId));
  await recordClassificationOutcomes(store, {
    insurer: params.insurer,
    sourceMessageId: params.sourceMessageId,
    result: params.updatedResult,
    decidedAt: params.decidedAt,
    humanConfirmed: true,
  });
}
