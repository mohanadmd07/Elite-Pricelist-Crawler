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

