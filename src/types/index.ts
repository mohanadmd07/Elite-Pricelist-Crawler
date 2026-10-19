/**
 * Core type definitions for Elite Hospital Pricelist Explorer
 */

export interface ProcedureResult {
  nameArabic: string;
  nameEnglish: string;
  price: string;
  sectionName: string;
  sourceFile: string;
  requestedProcedureName?: string;
}

export interface CompanyInfo {
  name: string;
  priceListYear: string;
  discount: number;
  responsiblePerson?: string;
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
  }>;
  status: 'draft_created' | 'answered' | 'unanswered' | 'needs_review' | 'pending_manual_draft';
  draftBody: string;
  draftedAt: any;
  answeredAt?: any;

  // Reply and Approval State Detection
  hasReplies?: boolean;
  replySnippet?: string;
  hasExistingApproval?: boolean;
  existingApprovalSnippet?: string;
  manualDraftRequested?: boolean;
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
}


