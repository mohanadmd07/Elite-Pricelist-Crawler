/**
 * Shared types for the approval-reply classifier (see .agent/skills/approval-reply-classifier/SKILL.md).
 */

export type ThreadStatus = 'APPROVED' | 'PARTIAL' | 'REJECTED' | 'PENDING' | 'UNCLEAR';

export type SpeakerRole =
  | 'INSURER_MEDICAL_REVIEWER'
  | 'INSURER_ADMIN'
  | 'HOSPITAL'
  | 'CORPORATE_SALES'
  | 'AUTO_REPLY'
  | 'UNKNOWN';

export type ItemCategory =
  | 'ADMISSION'
  | 'PROCEDURE'
  | 'IMPLANT_DEVICE'
  | 'MEDICATION'
  | 'INVESTIGATION'
  | 'ICU_DAYS'
  | 'ROOM_CLASS'
  | 'CONSULTATION'
  | 'OTHER';

export type ItemDecision =
  | 'APPROVED'
  | 'CONDITIONAL'
  | 'REJECTED'
  | 'INFO_REQUESTED'
  | 'PENDING'
  | 'NOT_ADDRESSED';

export type RejectionType =
  | 'MEDICAL_NECESSITY'
  | 'COVERAGE_EXCLUSION'
  | 'LIMIT_EXCEEDED'
  | 'WAITING_PERIOD'
  | 'PRE_EXISTING'
  | 'NOT_PREAUTHORIZED'
  | 'POLICY_EXPIRED'
  | 'WRONG_PROVIDER'
  | 'OTHER';

/** Administrative rejections are everything except MEDICAL_NECESSITY. */
export const isAdministrativeRejection = (t?: RejectionType | null): boolean =>
  !!t && t !== 'MEDICAL_NECESSITY';

// ---------------------------------------------------------------- Pass 1 ----

export interface RawThreadMessage {
  messageId: string;
  /** RFC822 In-Reply-To / conversation id, when known */
  inReplyTo?: string | null;
  conversationId?: string | null;
  sender: string;
  /** ISO timestamp */
  date: string;
  subject?: string;
  body: string;
  /** Text extracted from attachments (OCR / PDF text). Primary evidence. */
  attachments?: Array<{ name: string; text: string }>;
}

export interface ReconstructedMessage {
  messageId: string;
  sender: string;
  role: SpeakerRole;
  date: string;
  /** new content incl. inline-reply markup ([QUOTED]/[REPLY]) when the sender replied inline */
  newContent: string;
  /** author's own words only (quoted lines removed); the ONLY text a decision may be evidenced from */
  decisionText: string;
  quotedContent: string;
  attachments: Array<{ name: string; text: string; evidenceId: string }>;
  isAutoReply: boolean;
}

export interface ApprovalRequestRef {
  approvalReference?: string | null;
  patientName?: string | null;
  admissionDate?: string | null;
  conversationId?: string | null;
}

// ---------------------------------------------------------------- Pass 2 ----

export interface LedgerItem {
  category: ItemCategory;
  text_original: string;
  canonical_en?: string | null;
  decision: ItemDecision;
  quantity_requested?: number | null;
  quantity_approved?: number | null;
  conditions?: string[];
  info_requested?: string[];
  rejection_type?: RejectionType | null;
  rejection_reason_ar?: string | null;
  rejection_reason_en?: string | null;
  validity_until?: string | null;
  amount_cap?: number | null;
  copay_percent?: number | null;
  evidence_quote: string;
  evidence_message_id: string;
}

export interface LedgerMessage {
  message_id: string;
  speaker_role: SpeakerRole;
  contains_decision: boolean;
}

export interface Ledger {
  thread_status: ThreadStatus;
  approval_reference?: string | null;
  messages?: LedgerMessage[];
  items: LedgerItem[];
  confidence: number;
  needs_human_review: boolean;
  review_reasons?: string[];
}

export interface Verification {
  verdict: 'OK' | 'CORRECTIONS';
  corrections: Array<{ item: string; issue: string; fix: string }>;
}

// ---------------------------------------------------------------- Pass 4/5 --

export type MatchClass = 'EXACT' | 'EQUIVALENT_SYNONYM' | 'BROADER' | 'NARROWER' | 'DIFFERENT';
export type CoverageResult = 'COVERED' | 'NEEDS_REVIEW' | 'NOT_COVERED';
export type PriceSource = 'CONTRACT' | 'LIST_2026_PRICE_APPROVAL' | 'NOT_FOUND' | 'NEEDS_REVIEW' | 'NO_MAPPING' | 'INCLUDED_IN_PACKAGE' | 'REJECTED_REFERENCE';

export interface PriceRow {
  code: string | null;
  nameEn: string;
  nameAr: string;
  /** Gross list price exactly as stored */
  price: number;
  section?: string | null;
  year: number;
  /** pricelist identifier (pricelists.id or `list-<year>`) */
  pricelistId: string;
  /** version label (pricelists.title / year + row hash) */
  pricelistVersion: string;
  isPackage?: boolean;
  packageId?: string | null;
}

export interface Candidate {
  row: PriceRow;
  score: number;
  via: 'CODE' | 'EXACT_NAME' | 'FUZZY';
}

export interface CoverageDecision {
  itemIndex: number;
  itemText: string;
  canonicalEn: string | null;
  result: CoverageResult;
  matchClass: MatchClass | null;
  rationale: string;
  chosen: Candidate | null;
  candidates: Candidate[];
  guardOverride?: string; // set when a code guard overrode the model
}

export interface PricedLine {
  item: string;
  canonical_en: string | null;
  item_index: number;
  qty: number;
  unit_price: number | null;
  line_total: number | null;
  price_source: PriceSource;
  pricelist_id: string | null;
  pricelist_version: string | null;
  matched_code: string | null;
  matched_name_en?: string | null;
  matched_name_ar?: string | null;
  match_class: MatchClass | null;
  match_score: number | null;
  /** audit trail for CONTRACT lines: list price and discount applied */
  list_price?: number | null;
  discount_percent?: number | null;
  /** NEEDS_REVIEW lines show candidates with their contract prices */
  review_candidates?: Array<{ code: string | null; name_en: string; name_ar: string; contract_price: number; score: number }>;
  reference_contract_price?: number | null; // rejected items: reference only
  note?: string;
}

// ---------------------------------------------------------------- Pass 7 ----

export interface HistoryHint {
  item_index: number;
  canonical_procedure: string;
  insufficient: boolean;
  n: number;
  approved_n?: number;
  conditional_n?: number;
  rejected_n?: number;
  approved_pct?: number;
  rejected_pct?: number;
  top_rejection_types?: Array<{ type: string; count: number }>;
  usual_conditions?: string[];
  usual_documents?: string[];
  typical_approved_qty?: number | null;
  last_decided_at?: string | null;
  possible_policy_change?: boolean;
  anomalies: string[];
}

export interface ClassificationResult {
  source_message_id: string;
  status: ThreadStatus;
  approval_reference: string | null;
  items: LedgerItem[];
  confidence: number;
  needs_human_review: boolean;
  review_reasons: string[];
  rejection_reason_ar: string | null;
  rejection_reason_en: string | null;
  rejection_type: RejectionType | null;
  evidence_quote: string | null;
  model_version: string;
  verification: Verification | null;
  coverage: CoverageDecision[];
  priced: PricedLine[];
  contractor_pricelist_id: string | null;
  contract_total: number;
  price_approval_total: number;
  price_approval_required: boolean;
  price_approval_draft_en: string | null;
  price_approval_status: 'DRAFT' | 'SENT' | 'APPROVED' | 'REFUSED' | null;
  amount_cap: number | null;
  cap_gap: number | null;
  history_hints: HistoryHint[];
  anomalies: string[];
  not_addressed: string[];
  requested_questions: Array<{ item: string; question: string }>;
  conflicts: Array<{ item: string; quotes: string[] }>;
  classified_at: string;
  skipped?: 'IDEMPOTENT' | 'HUMAN_LOCKED';
}
