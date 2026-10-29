/**
 * Core type definitions for Elite Hospital Pricelist Explorer
 */

export interface ProcedureProvenanceSource {
  file: string;
  sha256?: string;
  page?: number;
  sheet?: string;
  extractor?: string;
}

export interface ProcedureResult {
  nameArabic: string;
  nameEnglish: string;
  price: string;
  sectionName: string;
  sourceFile: string;
  /** Hospital service code (e.g. P.318) when present in the source workbook */
  code?: string;
  /** True for send-out tests marked with ** in the pricelist */
  outsourced?: boolean;
  /** Set when a manual override could not be priced against any live catalog year */
  priceUnresolved?: boolean;
  requestedProcedureName?: string;
  /** Additive provenance and audit trail */
  sources?: ProcedureProvenanceSource[];
  extractor?: string;
  extractorVersion?: string;
  confidence?: number;
  flags?: string[];
}

export interface CompanyInfo {
  id?: string;
  name: string;
  priceListYear: string;
  discount: number;
  responsiblePerson?: string;
  contractorOfficer?: string;
  aliases?: string[];
}

export interface StandardProcedure {
  english: string;
  arabic: string;
}

export interface SelectedProcedure {
  id: string;
  name: string;
  arabic?: string;
  isCustom?: boolean;
}

export interface SearchStatus {
  foundCount: number;
  pendingCount: number;
  isExtendingToAI: boolean;
  stage: 'idle' | 'local' | 'ai' | 'done';
  aiError?: string;
}

export interface CalculatedPrice {
  original: number;
  discounted: number;
  currency: string;
}

export interface PricelistDocument {
  name: string;
  path: string;
}

export interface SaveSearchOptions {
  companyName?: string;
  priceListYear?: string;
  aiUsed?: boolean;
}

export interface UserSearchRecord {
  id: string;
  userId: string;
  query: string;
  resultCount: number;
  timestamp?: any;
  companyName?: string;
  priceListYear?: string;
  aiUsed?: boolean;
}

export type ApprovalGranularStatus =
  | 'received'
  | 'parsed'
  | 'matched'
  | 'sent'
  | 'approved'
  | 'conditionally_approved'
  | 'partially_approved'
  | 'pending_information'
  | 'refused'
  | 'new_request'
  | 'draft_created'
  | 'answered'
  | 'unanswered'
  | 'needs_review'
  | 'pending_manual_draft';

export interface InpatientApprovalRecord {
  id: string;
  messageId: string;
  receivedAt: any;
  patientName: string;
  mrn: string;
  diagnosis: string;
  admissionType?: string;
  bed?: string;
  physician?: string;
  contractorRaw: string;
  contractorNormalized: string;
  priceListYear: string;
  contractorOfficer: string;
  requestedServices: Array<{
    name: string;
    rawPrice: number;
  }>;
  matchedProcedures: Array<{
    serviceName: string;
    matchedName: string;
    code?: string;
    status: 'matched' | 'unmatched';
    /** For unlisted procedures: price of the same procedure in another pricelist (EGP) */
    suggestedPrice?: number;
    suggestedFrom?: string;
  }>;
  status: ApprovalGranularStatus;
  draftBody: string;
  suggestedDraftReply?: string;
  draftedAt: any;
  answeredAt?: any;

  // Granular Context & Financial Terms extracted by AI
  patientSharePercentage?: number | null; // e.g. 10 (10% co-payment)
  approvedAmountLimit?: number | null;    // e.g. 25000 (EGP limit)
  coverageConditions?: string;            // Conditions e.g. "مشروط بتقرير الباثولوجي"
  aiThreadSummary?: string;               // 2-3 sentence executive summary in Arabic
  statusReasonArabic?: string;            // Explanation of why status was determined

  // Reply and Approval State Detection
  hasReplies?: boolean;
  replySnippet?: string;
  hasExistingApproval?: boolean;
  existingApprovalSnippet?: string;
  /** Instruction (e.g. from patient accounts) that a price approval (موافقة سعرية) must be brought */
  priceApprovalRequested?: boolean;
  priceApprovalAmount?: number | null;
  isRefused?: boolean;
  refusalSnippet?: string;
  manualDraftRequested?: boolean;
  cmWhatsappMessage?: string;
  exchangeItemId?: string;
  exchangeChangeKey?: string;
  creditLimit?: number;
  creditLimitText?: string;

  // Caching & Exchange Sync Identifiers
  conversationId?: string;
  threadKey?: string;
  threadHash?: string;
  lastExchangeItemId?: string;
  lastExchangeChangeKey?: string;
  aiProcessingStatus?: 'processed' | 'fallback_heuristic' | 'pending_quota';

  // Additive medical-aware approval-reply classifier fields
  classifierStatus?: 'APPROVED' | 'PARTIAL' | 'REJECTED' | 'PENDING' | 'UNCLEAR';
  statusLockedByHuman?: boolean;
  itemsJson?: any[];
  requestedItems?: any[];
  rejectionReasonAr?: string | null;
  rejectionReasonEn?: string | null;
  rejectionType?: string | null;
  evidenceQuote?: string | null;
  confidence?: number;
  needsHumanReview?: boolean;
  reviewReasons?: string[];
  classifiedAt?: string;
  sourceMessageId?: string;
  modelVersion?: string;
  coverageResultsJson?: any[];
  pricedItemsJson?: any[];
  historyHintsJson?: any[];
  contractorPricelistId?: string | null;
  contractTotal?: number;
  priceApprovalTotal?: number;
  priceApprovalRequired?: boolean;
  priceApprovalDraftEn?: string | null;
  priceApprovalStatus?: 'DRAFT' | 'SENT' | 'APPROVED' | 'REFUSED' | null;
  priceApprovalSentTo?: string | null;
  priceApprovalSentAt?: string | null;
  approvalReference?: string | null;
}


export interface CompanyConfigRecord {
  id: string;
  name: string;
  aliases: string[];
  priceListYear: string;
  contractorOfficer: string;
  discountPercentage?: number;
  updatedAt?: any;
  updatedBy?: string;
}

export interface AutomationSettings {
  isPaused: boolean;
  pausedAt?: any;
  pausedBy?: string;
  lastRunAt?: any;
  pollingIntervalSeconds?: number;
  isSyncing?: boolean;
  lastSyncCompletedAt?: any;
  lastSyncCount?: number;
  lastSyncDurationMs?: number;
  syncStateToken?: string;
  syncError?: string | null;
  triggerSync?: any;
}


