/**
 * Outlook Inpatient Approvals Watcher & AI Drafting Service
 * Monitors "InApprovals" folder via IMAP, parses HIS approval request emails,
 * resolves contractor -> pricelist & officer, matches procedures, appends drafts,
 * and syncs live to Firebase Firestore.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as cheerio from 'cheerio';
import * as crypto from 'crypto';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  writeBatch,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';

import { db } from '../src/firebase';
import { normalizeArabic, cleanContractorName, normalizeText, stripSentFromSignatures, cleanHisProcedureQuery, extractOriginalRequestDate } from '../src/lib/arabic-normalizer';
import { extractCleanProcedurePhrase, generateCmWhatsappMessage, extractProcedureFromApprovalReply } from '../src/lib/whatsapp-generator';
import { loadCompanies } from '../src/services/companyService';
import { searchAllProcedures } from '../src/services/procedureService';
import {
  matchProceduresWithAI,
  isGeminiConfigured,
  analyzeThreadWithUnifiedAI,
  analyzeThreadWithHeuristics,
  UnifiedThreadInput,
  UnifiedThreadOutput,
} from '../src/services/aiMatchService';
import { resolveOfficerByContractor } from '../src/services/contractorOfficerResolver';
import { InpatientApprovalRecord, CompanyConfigRecord } from '../src/types';
// @ts-ignore
import httpntlm from 'httpntlm';

// Configuration from environment (supports both IMAP_* and OUTLOOK_* aliases)
const IMAP_HOST = process.env.IMAP_HOST || process.env.OUTLOOK_IMAP_HOST || '';
const IMAP_PORT = Number(process.env.IMAP_PORT || process.env.OUTLOOK_IMAP_PORT) || 993;
const IMAP_SECURE = (process.env.IMAP_SECURE || process.env.OUTLOOK_IMAP_SECURE) !== 'false';
const IMAP_USER = process.env.IMAP_USER || process.env.OUTLOOK_IMAP_USER || '';
const IMAP_PASSWORD = process.env.IMAP_PASSWORD || process.env.OUTLOOK_IMAP_PASS || '';
const IMAP_FOLDER = process.env.IMAP_FOLDER || process.env.OUTLOOK_APPROVALS_FOLDER || 'InApprovals';
const IMAP_DRAFTS_FOLDER = process.env.IMAP_DRAFTS_FOLDER || process.env.OUTLOOK_DRAFTS_FOLDER || 'Drafts';
const POLL_INTERVAL_MS = (Number(process.env.POLL_INTERVAL_SECONDS) || 60) * 1000;
export const MAX_HISTORY_DAYS = 30;

// Exchange Web Services (EWS) detection for on-premise Exchange servers (e.g. wmail.elitehospital.org)
export const IS_EXCHANGE_EWS = IMAP_HOST.toLowerCase().includes('wmail.elitehospital.org') || IMAP_HOST.toLowerCase().includes('elitehospital.org');
export const EXCHANGE_DOMAIN = process.env.EXCHANGE_DOMAIN || 'elitehospital';
export const EXCHANGE_USERNAME = IMAP_USER.includes('@') ? IMAP_USER.split('@')[0] : IMAP_USER;
export const EWS_URL = `https://${IMAP_HOST}/EWS/Exchange.asmx`;
export const EXACT_INAPPROVALS_FOLDER_ID =
  'AAMkAGU5Y2EzNmMxLTIwZDItNDcxOC05ZTk0LTBlODJjZjkxOGU5NgAuAAAAAAA4U9epEFcNRbR5QhtWJDZyAQCVKjW+UMYOTr9U/HR/zy7WAAActvclAAA=';

// Local Persistence Paths
const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const APPROVALS_FILE = path.join(DATA_DIR, 'inpatient_approvals.json');
export const CONTRACTORS_FILE = path.join(DATA_DIR, 'contractors.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const SYNC_STATE_FILE = path.join(DATA_DIR, 'sync_state.json');

export function loadLocalSyncState(): string {
  try {
    if (!fs.existsSync(SYNC_STATE_FILE)) return '';
    const raw = fs.readFileSync(SYNC_STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed.syncState || '';
  } catch {
    return '';
  }
}

export function saveLocalSyncState(syncState: string): void {
  try {
    fs.writeFileSync(
      SYNC_STATE_FILE,
      JSON.stringify({ syncState, lastSyncedAt: new Date().toISOString() }, null, 2),
      'utf-8'
    );
  } catch (err) {
    console.error('[Watcher Storage] Error saving sync state:', err);
  }
}

/**
 * Loads locally persisted approvals and enforces the strict 30-day rolling window.
 */
export function loadLocalApprovals(): InpatientApprovalRecord[] {
  try {
    if (!fs.existsSync(APPROVALS_FILE)) return [];
    const raw = fs.readFileSync(APPROVALS_FILE, 'utf-8');
    const items = JSON.parse(raw) as InpatientApprovalRecord[];

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_HISTORY_DAYS);
    cutoff.setHours(0, 0, 0, 0);

    const valid = items.filter((item) => {
      if (!item.receivedAt) return false;
      const d =
        typeof item.receivedAt === 'string'
          ? new Date(item.receivedAt)
          : (item.receivedAt as any).seconds
          ? new Date((item.receivedAt as any).seconds * 1000)
          : new Date();
      return d >= cutoff;
    });

    if (valid.length !== items.length) {
      fs.writeFileSync(APPROVALS_FILE, JSON.stringify(valid, null, 2), 'utf-8');
    }
    return valid;
  } catch (err) {
    console.warn('[Watcher Storage] Error reading local approvals:', err);
    return [];
  }
}

export function saveLocalApprovals(records: InpatientApprovalRecord[]): void {
  try {
    fs.writeFileSync(APPROVALS_FILE, JSON.stringify(records, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Watcher Storage] Error saving local approvals:', err);
  }
}

export function upsertLocalApproval(record: InpatientApprovalRecord): void {
  const current = loadLocalApprovals();
  const idx = current.findIndex((r) => r.id === record.id);
  if (idx >= 0) {
    current[idx] = { ...current[idx], ...record };
  } else {
    current.unshift(record);
  }
  saveLocalApprovals(current);
}

export function deleteLocalApproval(id: string): void {
  const current = loadLocalApprovals();
  const filtered = current.filter((r) => r.id !== id);
  if (filtered.length !== current.length) {
    saveLocalApprovals(filtered);
  }
}

export function loadLocalContractors(): CompanyConfigRecord[] {
  try {
    if (!fs.existsSync(CONTRACTORS_FILE)) return [];
    const raw = fs.readFileSync(CONTRACTORS_FILE, 'utf-8');
    return JSON.parse(raw) as CompanyConfigRecord[];
  } catch (err) {
    console.warn('[Watcher Storage] Error reading local contractors:', err);
    return [];
  }
}

export function saveLocalContractors(records: CompanyConfigRecord[]): void {
  try {
    fs.writeFileSync(CONTRACTORS_FILE, JSON.stringify(records, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Watcher Storage] Error saving local contractors:', err);
  }
}

export function upsertLocalContractor(record: CompanyConfigRecord): void {
  const current = loadLocalContractors();
  const idx = current.findIndex(
    (c) => c.id === record.id || c.name.trim().toLowerCase() === record.name.trim().toLowerCase()
  );
  if (idx >= 0) {
    current[idx] = { ...current[idx], ...record };
  } else {
    current.push(record);
  }
  saveLocalContractors(current);
}

export function loadLocalSettings(): { isPaused: boolean; pollingIntervalSeconds: number; lastScannedAt?: string } {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return { isPaused: false, pollingIntervalSeconds: 60 };
    }
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { isPaused: false, pollingIntervalSeconds: 60 };
  }
}

export function saveLocalSettings(settings: { isPaused: boolean; pollingIntervalSeconds: number; lastScannedAt?: string }): void {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Watcher Storage] Error saving local settings:', err);
  }
}

/**
 * Purges inpatient approval records older than maxDays (default 30)
 * to strictly enforce a rolling 30-day history in Firestore & local JSON with automatic daily rollover.
 */
export async function purgeApprovalsOlderThan(days: number = MAX_HISTORY_DAYS): Promise<number> {
  // Purge local approvals
  loadLocalApprovals();

  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    cutoff.setHours(0, 0, 0, 0);
    const cutoffTimestamp = Timestamp.fromDate(cutoff);

    const colRef = collection(db, 'inpatient_approvals');
    const q = query(colRef, where('receivedAt', '<', cutoffTimestamp));
    const snap = await Promise.race([
      getDocs(q),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Purge query timeout')), 5000)),
    ]);

    if (!snap || snap.empty) return 0;

    const batch = writeBatch(db);
    snap.docs.forEach((docSnap) => {
      batch.delete(docSnap.ref);
    });
    await Promise.race([
      batch.commit(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Purge commit timeout')), 5000)),
    ]);
    console.log(`[Approvals Watcher] 30-Day Rollover: Purged ${snap.size} records older than ${days} days.`);
    return snap.size;
  } catch (err) {
    // If Firestore permissions deny unauthenticated batch or timeout, local file is already purged
    return 0;
  }
}

interface ParsedApprovalEmail {
  messageId: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  patientName: string;
  mrn: string;
  admissionDate: string;
  admissionType: string;
  bed: string;
  physician: string;
  contractorRaw: string;
  diagnosis: string;
  requestedServices: Array<{ name: string; rawPrice: number }>;
  requestDetails: string;
}

/**
 * Decodes XML/HTML entities from Exchange Web Services bodies.
 */
export function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#xD;/g, '\r')
    .replace(/&#xA;/g, '\n')
    .replace(/&nbsp;/g, ' ');
}

/**
 * Normalizes message IDs by decoding entities, stripping angle brackets, and trimming.
 */
export function cleanMsgId(raw?: string): string {
  if (!raw) return '';
  return decodeHtmlEntities(raw).replace(/[<>]/g, '').trim().toLowerCase();
}

/**
 * Extracts structured approval fields from the incoming HIS HTML email body.
 * Supports both HIS HTML table formats and key-value / request details formats.
 */
export function parseHisApprovalHtml(html: string, subject: string, messageId: string): ParsedApprovalEmail {
  const decodedHtml = decodeHtmlEntities(html || '');
  const $ = cheerio.load(decodedHtml);
  const fullText = $('body').text().replace(/\s+/g, ' ').trim() || decodedHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // Extract MRN & Patient from Subject if available
  const subjectMatch = subject.match(/(?:RE:\s*)?(?:\[URGENT\]\s*)?Inpatient Approval\s*-\s*(.+?)\s*\(MRN:\s*(\d+)\)/i);
  let patientName = subjectMatch ? subjectMatch[1].trim() : '';
  let mrn = subjectMatch ? subjectMatch[2].trim() : '';

  // Extract from HTML tables
  let admissionDate = '';
  let admissionType = '';
  let bed = '';
  let physician = '';
  let contractorRaw = '';
  let diagnosis = '';
  let requestDetails = '';

  // 1. Iterate over HTML table rows (robust row/column index mapping)
  $('tr').each((_, tr) => {
    const cells = $(tr).find('td, th');
    if (cells.length < 2) return;

    for (let i = 0; i < cells.length; i++) {
      const cellText = cells.eq(i).text().replace(/\s+/g, ' ').trim();
      const nextCell = i + 1 < cells.length ? cells.eq(i + 1) : null;
      const nextCellText = nextCell ? nextCell.text().replace(/\s+/g, ' ').trim() : '';

      // Patient Name
      if (!patientName && /^Patient(?:\s*Name)?\s*[:\s]*$/i.test(cellText)) {
        if (nextCellText) patientName = nextCellText;
      }

      // Admission Date
      if (!admissionDate && /^Admission(?:\s*Date)?\s*[:\s]*$/i.test(cellText)) {
        if (nextCellText) admissionDate = nextCellText;
      }

      // Admission / Visit Type & Bed
      if (/^(?:Admission|Visit)\s*Type\s*[:\s]*$/i.test(cellText)) {
        const fullRowText = $(tr).text();
        admissionType = fullRowText.includes('Inpatient') ? 'Inpatient' : 'Outpatient';
        const bedMatch = fullRowText.match(/Bed:\s*([^–\n<]+)/i);
        if (bedMatch) bed = bedMatch[1].trim();
      }

      // Physician
      if (!physician && /^Physician\s*[:\s]*$/i.test(cellText)) {
        if (nextCellText) physician = nextCellText;
      }

      // Contractor / Company (supports Contractor, Contractor Name, Company, جهة التعاقد, etc.)
      if (
        !contractorRaw &&
        /^(?:Contractor(?:\s*Name)?|Company(?:\s*Name)?|Customer(?:\s*Name)?|جهة\s*التعاقد|الجهة\s*التعاقدية|اسم\s*الشركة|التعاقد|الشركة)\s*[:\s]*$/i.test(cellText)
      ) {
        if (nextCellText) {
          const cleaned = cleanContractorName(nextCellText);
          if (cleaned && cleaned.toLowerCase() !== 'contractor' && !cleaned.includes('مستشفى إيليت')) {
            contractorRaw = cleaned;
          }
        }
      }

      // Diagnosis
      if (!diagnosis && /^Diagnosis\s*[:\s]*$/i.test(cellText)) {
        if (nextCellText) diagnosis = nextCellText;
      }
    }
  });

  // 2. Iterate elements for inline key-value pairs (e.g. <td>Contractor: شركة جاسكو</td>)
  $('td, th, p, div, span').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();

    if (!contractorRaw) {
      const cMatch = text.match(/^(?:Contractor(?:\s*Name)?|Company(?:\s*Name)?|جهة\s*التعاقد|الجهة\s*التعاقدية|اسم\s*الشركة)\s*[:\s]+(.+)$/i);
      if (cMatch) {
        const cleaned = cleanContractorName(cMatch[1]);
        if (cleaned && cleaned.toLowerCase() !== 'contractor' && !cleaned.includes('مستشفى إيليت')) {
          contractorRaw = cleaned;
        }
      }
    }

    if (!patientName) {
      const pMatch = text.match(/^Patient(?:\s*Name)?\s*[:\s]+(.+)$/i);
      if (pMatch) patientName = pMatch[1].trim();
    }

    if (!admissionDate && text.includes('Admission Date:')) {
      const adMatch = text.match(/Admission Date:\s*([^–\n<]+)/i);
      if (adMatch) admissionDate = adMatch[1].trim();
    }

    if (!physician) {
      const phMatch = text.match(/^Physician\s*[:\s]+(.+)$/i);
      if (phMatch) physician = phMatch[1].trim();
    }

    if (!diagnosis) {
      const dMatch = text.match(/^Diagnosis\s*[:\s]+(.+)$/i);
      if (dMatch) diagnosis = dMatch[1].trim();
    }

    if (!bed && text.includes('Bed:')) {
      const bMatch = text.match(/Bed:\s*([^–\n<]+)/i);
      if (bMatch) bed = bMatch[1].trim();
    }

    if (text.includes('Request Details')) {
      const container = $(el).closest('div, table').find('div, p, span').last().text().trim();
      if (container && container !== text) requestDetails = container;
    }
  });

  // 3. Fallback regexes
  if (!patientName) {
    const pMatch =
      fullText.match(/Patient Name:\s*([^<\n\r]+?)(?=\s*(?:Contractor|Visit|Admission|Physician|Diagnosis|Bed|Request|Selected|جهة|الجهة|الرقم|$))/i) ||
      fullText.match(/(?:حاله|حالة)\s*[:\/]\s*([^<\n\r]+?)(?=\s*(?:Contractor|Visit|Admission|Physician|Diagnosis|Bed|Request|Selected|جهة|الجهة|الرقم|$))/i);
    if (pMatch) patientName = pMatch[1].replace(/(?:Contractor|Visit Type|MRN).*/i, '').trim();
  }

  if (!mrn) {
    const bMatch =
      fullText.match(/Patient Barcode:\s*(\d+)/i) ||
      fullText.match(/(?:MRN|الرقم الطبي)\s*[:\/\s]*(\d+)/i) ||
      subject.match(/\(MRN:\s*(\d+)\)/i);
    if (bMatch) mrn = bMatch[1].trim();
  }

  if (!contractorRaw) {
    const cMatch =
      fullText.match(/Contractor(?:\s*Name)?\s*[:\s]+([^<\n\r]+?)(?=\s+(?:Visit|Admission|Physician|Diagnosis|Bed|Request|Selected|$))/i) ||
      fullText.match(/(?:جهة\s*التعاقد|الجهة\s*التعاقدية)\s*[:\s]+([^<\n\r]+?)(?=\s+(?:التشخيص|الطبيب|رقم|تاريخ|$))/i);
    if (cMatch) {
      const candidate = cleanContractorName(cMatch[1].trim());
      if (candidate && candidate.toLowerCase() !== 'contractor' && !candidate.includes('مستشفى إيليت')) {
        contractorRaw = candidate;
      }
    }
  }

  if (!diagnosis) {
    const diagMatch = fullText.match(/Diagnosis[:\s]+([^\n\r<]+)/i);
    if (diagMatch) diagnosis = diagMatch[1].trim();
  }

  // Clean contractor name (strip "Main", "شركة", "شركه", "<br>", etc.)
  if (contractorRaw) {
    contractorRaw = cleanContractorName(contractorRaw);
  }

  // Extract SELECTED SERVICES table rows
  const requestedServices: Array<{ name: string; rawPrice: number }> = [];

  $('tr').each((_, tr) => {
    const rowText = $(tr).text();
    const isExcluded =
      rowText.includes('Patient Name') ||
      rowText.includes('Admission Date') ||
      rowText.includes('Admission Type') ||
      rowText.includes('Physician') ||
      rowText.includes('Contractor') ||
      rowText.includes('Diagnosis') ||
      rowText.includes('Service Name') ||
      rowText.includes('TOTAL AMOUNT') ||
      rowText.includes('SELECTED SERVICES') ||
      rowText.includes('Bed:');

    if (!isExcluded) {
      const cells = $(tr).find('td');
      if (cells.length >= 2) {
        const srvName = cells.eq(0).text().trim();
        const priceStr = cells.eq(1).text().replace(/[^0-9.]/g, '').trim();
        const priceNum = parseFloat(priceStr);

        if (srvName && !isNaN(priceNum) && priceNum > 0) {
          requestedServices.push({
            name: srvName,
            rawPrice: priceNum,
          });
        }
      }
    }
  });

  // Fallback: If no services table found, extract requested item from Request Details
  if (requestedServices.length === 0 && requestDetails) {
    // Clean request details text to isolate the specific medical procedure
    const cleanDetails = extractCleanProcedurePhrase(requestDetails);
    if (cleanDetails && cleanDetails.length > 3) {
      requestedServices.push({
        name: cleanDetails,
        rawPrice: 0,
      });
    }
  }

  // Clean long or clinical narrative items in requestedServices
  for (const srv of requestedServices) {
    if (
      srv.name &&
      (srv.name.length > 35 ||
        srv.name.includes('\n') ||
        srv.name.includes('يعاني') ||
        srv.name.includes('يعانى') ||
        srv.name.includes('ورم'))
    ) {
      const clean = extractCleanProcedurePhrase(srv.name);
      if (clean && clean.length >= 3) {
        srv.name = clean;
      }
    }
  }

  return {
    messageId,
    subject,
    from: '',
    to: '',
    cc: '',
    patientName: patientName || '',
    mrn: mrn || '',
    admissionDate,
    admissionType: admissionType || 'Inpatient',
    bed: bed || 'Inpatient Bed',
    physician: physician || 'Hospital Staff',
    contractorRaw: contractorRaw || 'غير محدد',
    diagnosis: diagnosis || 'Clinical Inpatient Evaluation',
    requestedServices,
    requestDetails: requestDetails || fullText.slice(0, 300),
  };
}

export const CONTRACTOR_GENERIC_STOPWORDS = new Set([
  'شركة', 'شركه', 'الشركة', 'الشركه',
  'نقابة', 'نقابه', 'النقابة', 'النقابه',
  'هيئة', 'هيئه', 'الهيئة', 'الهيئه',
  'جمعية', 'جمعيه', 'الجمعية', 'الجمعيه',
  'مؤسسة', 'مؤسسه', 'المؤسسة', 'المؤسسه',
  'صندوق', 'الصندوق',
  'اتحاد', 'الاتحاد',
  'نادي', 'نادى', 'النادي', 'النادى',
  'قطاع', 'القطاع',
  'مشروع', 'المشروع', 'مشروعات', 'المشروعات',
  'للبترول', 'بترول', 'البترول', 'لتكرير',
  'المصرية', 'المصريه', 'العامة', 'العامه',
  'الخدمات', 'خدمات', 'الطبية', 'الطبيه', 'الرعاية', 'الرعايه',
  'كير', 'care', 'cash', 'كاش', 'main', 'contractor', 'تعاقد', 'عقد',
  'مصر', 'الاسكندرية', 'اسكندرية',
]);

function getDistinctContractorTokens(str: string): string[] {
  return normalizeArabic(str)
    .toLowerCase()
    .replace(/[^a-zA-Z0-9\u0600-\u06FF\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !CONTRACTOR_GENERIC_STOPWORDS.has(t));
}

function scoreContractorCandidate(
  candidateName: string,
  candidateAliases: string[] | undefined,
  targetCleaned: string
): number {
  const normCand = normalizeArabic(candidateName);
  const normTarget = normalizeArabic(targetCleaned);

  if (normCand === normTarget) return 100;
  // Exact alias match is an explicit user mapping or merge; score 100
  if (candidateAliases && candidateAliases.some((a) => normalizeArabic(a) === normTarget)) return 100;

  // Substring containment (both >= 4 chars, avoiding single stopword containment)
  if (normCand.length >= 4 && normTarget.length >= 4) {
    if (normTarget.includes(normCand)) return 80 + Math.min(normCand.length, 10);
    if (normCand.includes(normTarget)) return 75 + Math.min(normTarget.length, 10);
  }
  if (candidateAliases) {
    for (const a of candidateAliases) {
      const normA = normalizeArabic(a);
      if (normA.length >= 4 && normTarget.length >= 4) {
        if (normTarget.includes(normA)) return 80 + Math.min(normA.length, 10);
        if (normA.includes(normTarget)) return 75 + Math.min(normTarget.length, 10);
      }
    }
  }

  // Token-level distinctive overlap
  const candTokens = getDistinctContractorTokens(candidateName);
  const targetTokens = getDistinctContractorTokens(targetCleaned);
  if (candTokens.length === 0 || targetTokens.length === 0) return 0;

  let matchCount = 0;
  for (const ct of candTokens) {
    if (targetTokens.some((rt) => rt === ct || (ct.length >= 4 && rt.includes(ct)) || (rt.length >= 4 && ct.includes(rt)))) {
      matchCount++;
    }
  }

  if (matchCount > 0) {
    const ratio = matchCount / Math.max(candTokens.length, targetTokens.length);
    if (matchCount >= 2 || ratio >= 0.5) {
      return 50 + matchCount * 10;
    }
    if (matchCount === 1 && (candTokens.length === 1 || targetTokens.length === 1)) {
      return 60;
    }
  }

  return 0;
}

let cachedFirestoreCompanies: CompanyConfigRecord[] = [];
let cachedFirestoreCompaniesAt = 0;

async function getCachedFirestoreCompanies(): Promise<CompanyConfigRecord[]> {
  const now = Date.now();
  if (cachedFirestoreCompanies.length > 0 && now - cachedFirestoreCompaniesAt < 5 * 60 * 1000) {
    return cachedFirestoreCompanies;
  }
  try {
    const colRef = collection(db, 'companies_config');
    const snap = await Promise.race([
      getDocs(colRef),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    if (snap && !snap.empty) {
      cachedFirestoreCompanies = snap.docs.map((d) => d.data() as CompanyConfigRecord);
      cachedFirestoreCompaniesAt = now;

      // Sync Firestore companies into local contractors cache to prevent stale overrides
      let local = loadLocalContractors();
      let changed = false;

      // Identify any names that were merged into other companies as aliases
      const mergedAliases = new Set<string>();
      for (const fc of cachedFirestoreCompanies) {
        if (fc.aliases && Array.isArray(fc.aliases)) {
          for (const a of fc.aliases) {
            if (a.trim().toLowerCase() !== fc.name.trim().toLowerCase()) {
              mergedAliases.add(a.trim().toLowerCase());
              mergedAliases.add(normalizeArabic(a));
            }
          }
        }
      }

      // Prune local contractors whose names were merged into another company
      const initialLen = local.length;
      local = local.filter((l) => {
        const norm = normalizeArabic(l.name);
        if (mergedAliases.has(l.name.trim().toLowerCase()) || mergedAliases.has(norm)) {
          return false; // Prune merged obsolete entry!
        }
        return true;
      });
      if (local.length !== initialLen) changed = true;

      for (const fc of cachedFirestoreCompanies) {
        const idx = local.findIndex((l) => l.id === fc.id || l.name.toLowerCase() === fc.name.toLowerCase());
        if (idx >= 0) {
          if (fc.contractorOfficer && fc.contractorOfficer !== 'غير محدد' && local[idx].contractorOfficer !== fc.contractorOfficer) {
            local[idx].contractorOfficer = fc.contractorOfficer;
            changed = true;
          }
          if (fc.priceListYear && local[idx].priceListYear !== fc.priceListYear) {
            local[idx].priceListYear = fc.priceListYear;
            changed = true;
          }
          if (fc.aliases && Array.isArray(fc.aliases) && fc.aliases.length > (local[idx].aliases?.length || 0)) {
            local[idx].aliases = Array.from(new Set([...(local[idx].aliases || []), ...fc.aliases]));
            changed = true;
          }
        } else {
          local.push(fc);
          changed = true;
        }
      }
      if (changed) {
        saveLocalContractors(local);
      }
    }
  } catch {}
  return cachedFirestoreCompanies;
}

/**
 * Resolves contractor to active pricelist year and sales officer.
 * Strips "Main", "شركة", "شركه" and uses multi-tier matching (exact, aliases, substrings, token stems).
 * Prioritizes entries with defined sales officers and Firestore source of truth.
 */
export async function resolveContractor(rawName: string): Promise<{
  contractorNormalized: string;
  priceListYear: string;
  contractorOfficer: string;
}> {
  const cleanedName = cleanContractorName(rawName) || rawName.trim();
  const isCashContract =
    /كاش|cash|نادي|نادى|كارد|card|ma3ak|خصم/i.test(cleanedName) ||
    /كاش|cash|نادي|نادى|كارد|card|ma3ak|خصم/i.test(rawName);

  if (
    !cleanedName ||
    cleanedName.toLowerCase() === 'contractor' ||
    cleanedName === 'غير محدد' ||
    cleanedName.includes('مستشفى إيليت')
  ) {
    return {
      contractorNormalized: 'غير محدد',
      priceListYear: isCashContract ? '2026' : '2025',
      contractorOfficer: 'غير محدد (يتطلب تحديد منسق السيلز)',
    };
  }

  // 1. Absolute Source of Truth: contacts_table.xlsx (Contractor Officers Master List)
  const excelMatch = resolveOfficerByContractor(cleanedName);
  if (excelMatch.matched && excelMatch.confidenceScore >= 0.65) {
    return {
      contractorNormalized: excelMatch.contractorNormalized,
      priceListYear: isCashContract ? '2026' : '2025',
      contractorOfficer: excelMatch.officerName,
    };
  }

  interface Candidate {
    name: string;
    aliases?: string[];
    priceListYear?: string;
    officer: string;
    score: number;
    source: 'local' | 'firestore' | 'catalog';
  }

  const candidates: Candidate[] = [];

  // 1. Firestore companies_config collection (primary source of truth)
  const firestoreConfigs = await getCachedFirestoreCompanies();
  for (const c of firestoreConfigs) {
    const score = scoreContractorCandidate(c.name, c.aliases, cleanedName);
    if (score >= 50) {
      candidates.push({
        name: c.name,
        aliases: c.aliases,
        priceListYear: c.priceListYear || '2025',
        officer: c.contractorOfficer || 'غير محدد',
        score,
        source: 'firestore',
      });
    }
  }

  // 2. Local persisted contractors
  const localConfigs = loadLocalContractors();
  for (const c of localConfigs) {
    const score = scoreContractorCandidate(c.name, c.aliases, cleanedName);
    if (score >= 50) {
      candidates.push({
        name: c.name,
        aliases: c.aliases,
        priceListYear: c.priceListYear || '2025',
        officer: c.contractorOfficer || 'غير محدد',
        score,
        source: 'local',
      });
    }
  }

  // 3. Fallback to existing company catalog
  const catalogCompanies = await loadCompanies();
  for (const c of catalogCompanies) {
    const score = scoreContractorCandidate(c.name, undefined, cleanedName);
    if (score >= 50) {
      candidates.push({
        name: cleanContractorName(c.name) || c.name,
        priceListYear: c.priceListYear || '2025',
        officer: c.responsiblePerson || 'غير محدد',
        score,
        source: 'catalog',
      });
    }
  }

  // Pick highest scoring candidate with smart priority:
  // 1. Highest score
  // 2. Candidate with defined sales officer over 'غير محدد'
  // 3. Firestore candidate over local
  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      // 1. User-configured sources (firestore, local) strictly take precedence over static base catalog
      const aIsCustom = a.source === 'firestore' || a.source === 'local' ? 1 : 0;
      const bIsCustom = b.source === 'firestore' || b.source === 'local' ? 1 : 0;
      if (bIsCustom !== aIsCustom && (a.score >= 75 || b.score >= 75)) {
        return bIsCustom - aIsCustom;
      }

      if (b.score !== a.score) return b.score - a.score;
      const aHasOfficer = a.officer && a.officer !== 'غير محدد' && !a.officer.includes('يتطلب تحديد') ? 1 : 0;
      const bHasOfficer = b.officer && b.officer !== 'غير محدد' && !b.officer.includes('يتطلب تحديد') ? 1 : 0;
      if (bHasOfficer !== aHasOfficer) return bHasOfficer - aHasOfficer;
      if (b.source === 'firestore' && a.source !== 'firestore') return 1;
      if (a.source === 'firestore' && b.source !== 'firestore') return -1;
      return 0;
    });
    const best = candidates[0];

    // If local record doesn't have cleanedName in aliases, or has undefined officer, update it
    const localMatch = localConfigs.find((c) => c.name.toLowerCase() === best.name.toLowerCase());
    if (localMatch) {
      let mod = false;
      if (!localMatch.aliases?.includes(cleanedName)) {
        localMatch.aliases = [...(localMatch.aliases || [localMatch.name]), cleanedName];
        mod = true;
      }
      if (best.officer && best.officer !== 'غير محدد' && localMatch.contractorOfficer !== best.officer) {
        localMatch.contractorOfficer = best.officer;
        mod = true;
      }
      if (mod) upsertLocalContractor(localMatch);
    }

    const effectiveYear =
      best.priceListYear === 'Cash' ||
      isCashContract ||
      (best.aliases && best.aliases.some((a) => /كاش|cash|نادي|نادى|كارد|card|ma3ak/i.test(a)))
        ? '2026'
        : (best.priceListYear || '2025');

    return {
      contractorNormalized: best.name,
      priceListYear: effectiveYear,
      contractorOfficer: best.officer || 'غير محدد',
    };
  }

  // 4. Auto-detect new contractor: save automatically with undefined officer ('غير محدد')
  const newContractorEntry: CompanyConfigRecord = {
    id: cleanedName.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '_') || crypto.randomUUID(),
    name: cleanedName,
    aliases: [cleanedName, rawName].filter((v, i, a) => v && a.indexOf(v) === i),
    priceListYear: isCashContract ? '2026' : '2025',
    contractorOfficer: 'غير محدد',
    discountPercentage: 0,
    updatedAt: new Date().toISOString() as any,
    updatedBy: 'auto_detected',
  };

  upsertLocalContractor(newContractorEntry);
  try {
    await setDoc(
      doc(db, 'companies_config', newContractorEntry.id),
      {
        ...newContractorEntry,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    console.log(`[Contractor Auto-Detect] Registered new contractor: "${cleanedName}" with undefined officer`);
  } catch (err) {
    console.warn(`[Contractor Auto-Detect] Local registered: "${cleanedName}"`);
  }

  return {
    contractorNormalized: cleanedName,
    priceListYear: isCashContract ? '2026' : '2025',
    contractorOfficer: 'غير محدد',
  };
}

/**
 * Helper candidate scoring function for requested procedures against pricelists.
 */
function scoreCandidateProcedure(
  rowEng: string,
  rowAra: string,
  qEng: string,
  qAra: string,
  tokens: string[],
  mainNounTokens: string[]
): number {
  // Equipment usage fee mismatch protection: "رسم استخدام" vs diagnostic "رسم مخ / رسم قلب"
  if (
    (rowAra.includes('رسم استخدام') || rowAra.includes('استخدام جهاز') || /usage fee/i.test(rowEng)) &&
    (!qAra.includes('استخدام') && !/usage/i.test(qEng))
  ) {
    return 0;
  }

  // TEE (Transesophageal Echocardiography) vs Surface Echo (TTE) mismatch protection:
  // Transesophageal Echocardiography is TEE or T.E.E (موجات فوق صوتية على القلب عن طريق المريء / إيكو بالمنظار).
  // It is an endoscopic cardiac procedure that must NEVER match standard transthoracic surface Echocardiography.
  const isTeeQuery = /transesophageal|tee\b|t\.e\.e|مريء|المريء|بالمنظار/i.test(qEng + ' ' + qAra);
  const isTeeRow = /transesophageal|tee\b|t\.e\.e|مريء|المريء|بالمنظار/i.test(rowEng + ' ' + rowAra);
  if (isTeeQuery !== isTeeRow) {
    return 0;
  }

  let score = 0;
  if (qEng && rowEng) {
    if (rowEng === qEng) score += 100;
    else if (qEng.startsWith(rowEng) || rowEng.startsWith(qEng)) score += 60;
    else if (qEng.includes(rowEng) || rowEng.includes(qEng)) score += 45;
  }
  if (qAra && rowAra) {
    if (rowAra === qAra) score += 100;
    else if (qAra.startsWith(rowAra) || rowAra.startsWith(qAra)) score += 60;
    else if (qAra.includes(rowAra) || rowAra.includes(qAra)) score += 45;
  }

  let matchedMainCount = 0;
  for (const token of tokens) {
    const isMain = mainNounTokens.includes(token);
    const isExact = rowEng === token || rowAra === token;
    const hasWord =
      new RegExp(`\\b${token}\\b`, 'i').test(rowEng) ||
      rowAra.split(/\s+/).includes(token);
    if (isExact) {
      score += isMain ? 35 : 10;
      if (isMain) matchedMainCount++;
    } else if (hasWord) {
      score += isMain ? 25 : 5;
      if (isMain) matchedMainCount++;
    }
  }

  // If query has multiple main noun tokens (e.g. رسم + مخ), require all or penalize if missing
  if (
    mainNounTokens.length > 1 &&
    matchedMainCount < mainNounTokens.length &&
    (!qEng || !rowEng || (!qEng.includes(rowEng) && !rowEng.includes(qEng))) &&
    (!qAra || !rowAra || (!qAra.includes(rowAra) && !rowAra.includes(qAra)))
  ) {
    score = Math.min(score, 20);
  } else if (mainNounTokens.length === 1 && matchedMainCount === 0) {
    score = Math.min(score, 15);
  }

  return score;
}

/**
 * Matches requested procedures against the contract pricelist with AI semantic scoring.
 */
async function matchRequestedProcedures(
  services: Array<{ name: string; rawPrice: number }>,
  priceListYear: string
): Promise<Array<{ serviceName: string; matchedName: string; code?: string; status: 'matched' | 'unmatched' }>> {
  const results: Array<{ serviceName: string; matchedName: string; code?: string; status: 'matched' | 'unmatched' }> = [];

  // 1. Load active pricelist items for the corresponding year
  let pricelist: any[] = [];
  const targetYear =
    priceListYear === '2026' || priceListYear === 'Cash' || /cash|كاش/i.test(priceListYear)
      ? '2026'
      : (priceListYear === '2024' || priceListYear === '2023' ? priceListYear : '2025');
  try {
    const filePath = path.resolve(process.cwd(), 'public', `${targetYear}_cash.json`);
    if (fs.existsSync(filePath)) {
      pricelist = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (err) {
    console.warn(`[Procedure Match] Failed to read ${targetYear}_cash.json:`, err);
  }

  const anatomicalStopwords = ['قدم', 'كاحل', 'يد', 'عين', 'اذن', 'راس', 'مفصل', 'foot', 'ankle', 'wrist', 'hand', 'joint'];
  const clinicalNoise = [
    'عمل', 'سحب', 'تحليل', 'طلب', 'برجاء', 'المطلوب', 'باسم', 'باستخدام', 'تحت', 'الحاله', 'الحالة',
    'المريض', 'مريض', 'المريضة', 'مريضة', 'الطفل', 'طفل', 'الطفلة', 'طفلة', 'استشاري', 'دكتور', 'طبيب', 'كشف'
  ];

  for (const srv of services) {
    const s = srv.name.trim();
    const cleanS = cleanHisProcedureQuery(s);
    const engTokens = cleanS
      .replace(/[\u0600-\u06FF]/g, ' ')
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => (t.length >= 2 || /^[0-9]$/.test(t)) && !clinicalNoise.includes(t));
    const araTokens = cleanS
      .replace(/[a-zA-Z0-9]/g, ' ')
      .replace(/[^ \u0621-\u064A]/g, ' ')
      .split(/\s+/)
      .filter((t) => (t.length >= 2 || /^[0-9]$/.test(t)) && !clinicalNoise.includes(t));
    const allTokens = [...engTokens, ...araTokens];
    const mainNounTokens = allTokens.filter((t) => !anatomicalStopwords.includes(t));

    // Fast candidate scoring against pricelist
    const scoredCandidates: Array<{ item: any; score: number }> = [];
    if (pricelist.length > 0) {
      for (const item of pricelist) {
        const rowEng = normalizeText(item.nameEnglish);
        const rowAra = normalizeText(item.nameArabic);
        const score = scoreCandidateProcedure(rowEng, rowAra, engTokens.join(' '), araTokens.join(' '), allTokens, mainNounTokens);
        if (score >= 20) {
          scoredCandidates.push({ item, score });
        }
      }
      scoredCandidates.sort((a, b) => b.score - a.score);
    }

    const topCandidates = scoredCandidates.slice(0, 15).map((sc) => sc.item);

    // AI Semantic Matching (Gemini) just like searching
    if (topCandidates.length > 0 && isGeminiConfigured()) {
      try {
        const aiMatches = await matchProceduresWithAI(
          [{ id: '1', name: srv.name }],
          topCandidates
        );
        if (aiMatches.length > 0) {
          const aiBest = aiMatches[0];
          const displayName = aiBest.nameArabic ? `${aiBest.nameArabic} (${aiBest.nameEnglish})` : aiBest.nameEnglish;
          results.push({
            serviceName: srv.name,
            matchedName: displayName,
            status: 'matched',
          });
          continue;
        }
      } catch (aiErr) {
        console.warn(`[Procedure Match] Gemini AI matching error:`, aiErr);
      }
    }

    // High-confidence algorithmic match fallback (score >= 35)
    if (scoredCandidates.length > 0 && scoredCandidates[0].score >= 35) {
      const best = scoredCandidates[0].item;
      const displayName = best.nameArabic ? `${best.nameArabic} (${best.nameEnglish})` : best.nameEnglish;
      results.push({
        serviceName: srv.name,
        matchedName: displayName,
        status: 'matched',
      });
      continue;
    }

    // Unmatched item
    results.push({
      serviceName: srv.name,
      matchedName: srv.name,
      status: 'unmatched',
    });
  }

  return results;
}

export function cleanTextFromHtml(input: string): string {
  if (!input) return '';
  const decoded = decodeHtmlEntities(input);
  const withoutHtml = decoded
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripSentFromSignatures(withoutHtml);
}

export const REFUSAL_KEYWORDS = [
  'غير مغطى',
  'غير مغطاه',
  'غير مغطاة',
  'غير مغطي',
  'مرفوض',
  'رفض',
  'غير معتمد',
  'not approved',
  'rejected',
  'نعتذر عن الموافقة',
  'نعتذر عن الموافقه',
  'خارج التغطية',
  'خارج التغطيه',
];

export const APPROVAL_KEYWORDS = [
  'لا مانع',
  'approved',
  'approve',
  'معتمد',
  'موافقة سعرية',
  'موافقه سعريه',
  'تمت الموافقة',
  'تمت الموافقه',
  'موافقة باللائحة',
  'موافقه باللائحه',
  'يضاف علي الفاتوره',
  'يضاف على الفاتورة',
  'بفاتوره الشراء',
  'بفاتورة الشراء',
  'موافق',
  'تسعيرة سعرية',
  'تسعيره سعريه',
  'تسعيرة',
  'تسعيره',
];

/**
 * Extracts numeric approval credit limit / ceiling (الحد الأقصى للموافقة) from approval text.
 * Handles Unicode Arabic Presentation Forms through NFKC normalization,
 * as well as numbers with "ألف" / "الف" / "LE" / "EGP" / "جنيه".
 */
export function extractCreditLimit(text: string): { limit?: number; formatted?: string } {
  if (!text) return {};
  const normalized = text.normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e]/g, ' ');

  // Match approval amount / limit / ceiling patterns (including ER deposit/authorization amounts)
  const pattern = /(?:الحد\s+ال[اأإآ]قص[ىي]|بحد\s+[اأإآ]قص[ىي]|سقف\s+الموافق[ةه]|بمبلغ\s+لا\s+يتجاوز|في\s+حدود|موافق[ةه](?:\s+سعري[ةه])?\s+بمبلغ|معتمد\s+بمبلغ|لا\s+مانع(?:[^\d\n\r]{0,30})بمبلغ|تحصيل\s+مبلغ|مبلغ\s+(?:ت[اأإآ]مين\s+)?)(?:[^\d\n\r]{0,25})(\d+(?:[\.,]\d+)?)\s*(الف|ألف|الاف|آلاف|k)?/i;
  const match = normalized.match(pattern);
  if (match) {
    let num = parseFloat(match[1].replace(/,/g, ''));
    const unit = match[2]?.toLowerCase() || '';
    if (unit.includes('الف') || unit.includes('ألف') || unit.includes('الاف') || unit.includes('آلاف') || unit === 'k') {
      num = num * 1000;
    }
    if (!isNaN(num) && num > 0) {
      return {
        limit: num,
        formatted: `${num.toLocaleString('en-US')} EGP`,
      };
    }
  }

  return {};
}

/**
 * Checks if the email text or thread contains explicit refusal or "not covered" phrases.
 */
export function detectRefusal(
  text: string,
  subject: string
): { hasRefusal: boolean; snippet: string } {
  const normText = (text || '').normalize('NFKC');
  const normSubj = (subject || '').normalize('NFKC');
  const cleanBody = cleanTextFromHtml(normText);
  const cleanSubj = cleanTextFromHtml(normSubj);
  const combined = `${cleanSubj} ${cleanBody}`.trim();
  const normalized = combined
    .toLowerCase()
    .replace(/[إأآ]/g, 'ا')
    .replace(/ة/g, 'ه');

  for (const kw of REFUSAL_KEYWORDS) {
    const kwNorm = kw
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[إأآ]/g, 'ا')
      .replace(/ة/g, 'ه');

    const idx = normalized.indexOf(kwNorm);
    if (idx !== -1) {
      const start = Math.max(0, idx - 25);
      const end = Math.min(combined.length, idx + kw.length + 80);
      let snippet = stripSentFromSignatures(combined.substring(start, end)).trim();
      if (start > 0) snippet = '...' + snippet;
      if (end < combined.length) snippet = snippet + '...';

      return {
        hasRefusal: true,
        snippet,
      };
    }
  }

  return { hasRefusal: false, snippet: '' };
}

/**
 * Checks if the email text or thread contains approval phrases.
 * If an explicit refusal is detected, it is classified as refusal, not approval.
 * Normalizes Unicode Arabic presentation forms (e.g. ﻻ ﻣﺎﻧﻊ -> لا مانع) and extracts credit limit.
 */
export function detectExistingApproval(
  text: string,
  subject: string
): { hasApproval: boolean; snippet: string; creditLimit?: number; creditLimitText?: string } {
  const normText = (text || '').normalize('NFKC');
  const normSubj = (subject || '').normalize('NFKC');

  // If explicitly refused, it is NOT an approval
  const refusalCheck = detectRefusal(normText, normSubj);
  if (refusalCheck.hasRefusal) {
    return { hasApproval: false, snippet: '' };
  }

  const cleanBody = cleanTextFromHtml(normText);
  const cleanSubj = cleanTextFromHtml(normSubj);
  const combined = `${cleanSubj} ${cleanBody}`.trim();
  const normalized = combined
    .toLowerCase()
    .replace(/[إأآ]/g, 'ا')
    .replace(/ة/g, 'ه');

  const credit = extractCreditLimit(combined);

  for (const kw of APPROVAL_KEYWORDS) {
    const kwNorm = kw
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[إأآ]/g, 'ا')
      .replace(/ة/g, 'ه');

    const idx = normalized.indexOf(kwNorm);
    if (idx !== -1) {
      const start = Math.max(0, idx - 25);
      const end = Math.min(combined.length, idx + kw.length + 80);
      let snippet = stripSentFromSignatures(combined.substring(start, end)).trim();
      if (start > 0) snippet = '...' + snippet;
      if (end < combined.length) snippet = snippet + '...';

      return {
        hasApproval: true,
        snippet,
        creditLimit: credit.limit,
        creditLimitText: credit.formatted,
      };
    }
  }

  // If a monetary credit limit was detected with approval context
  if (credit.limit) {
    return {
      hasApproval: true,
      snippet: stripSentFromSignatures(combined.substring(0, 120)).trim(),
      creditLimit: credit.limit,
      creditLimitText: credit.formatted,
    };
  }

  return { hasApproval: false, snippet: '' };
}

/**
 * Checks if the email is a thread with prior replies or responses.
 */
export function detectReplies(parsed: {
  subject: string;
  inReplyTo?: string;
  references?: string | string[];
  text?: string;
  html?: string | false;
}): { hasReplies: boolean; snippet: string } {
  const subject = parsed.subject || '';
  const isReSubject = /^(re|رد|fw|fwd)\s*:/i.test(subject.trim());
  const hasInReplyTo = Boolean(parsed.inReplyTo);
  const hasReferences = Array.isArray(parsed.references)
    ? parsed.references.length > 0
    : Boolean(parsed.references);

  const rawContent = (parsed.text || '') + '\n' + (parsed.html || '');
  const hasQuotedMarkers =
    /-----Original Message-----/i.test(rawContent) ||
    /From:.*Sent:.*To:/is.test(rawContent) ||
    /On\s+.+wrote:/i.test(rawContent) ||
    /بتاريخ\s+.+كتب/i.test(rawContent);

  if (isReSubject || hasInReplyTo || hasReferences || hasQuotedMarkers) {
    let replySnippet = '';
    const cleanContent = cleanTextFromHtml(parsed.text || parsed.html || '');
    const sentences = cleanContent.split(/[.\n\r]+/).map((s) => s.trim()).filter((s) => s.length > 4);

    for (const s of sentences) {
      if (
        !s.toLowerCase().includes('inpatient approval') &&
        !s.toLowerCase().includes('patient information') &&
        !s.toLowerCase().includes('selected services') &&
        !s.toLowerCase().includes('from:') &&
        !s.toLowerCase().includes('to:') &&
        !s.toLowerCase().includes('sent:') &&
        !s.toLowerCase().includes('subject:')
      ) {
        replySnippet = stripSentFromSignatures(s).substring(0, 120);
        if (replySnippet.length > 4) break;
      }
    }

    return {
      hasReplies: true,
      snippet: replySnippet ? `"${replySnippet}"` : '',
    };
  }

  return { hasReplies: false, snippet: '' };
}

/**
 * Builds the official draft response text.
 * Always mentions corporate@elitehospital.org.
 */
export function buildDraftReplyText(
  priceListYear: string,
  contractor: string,
  officer: string,
  matchedProcedures: Array<{ serviceName: string; matchedName: string; status: 'matched' | 'unmatched' }>
): string {
  const matchedLines = matchedProcedures
    .filter((p) => p.status === 'matched')
    .map((p, idx) => `${idx + 1}- ${p.matchedName}`)
    .join('\n');

  const unmatchedLines = matchedProcedures
    .filter((p) => p.status === 'unmatched')
    .map((p) => ` - ${p.serviceName}`)
    .join('\n');

  const displayYear =
    priceListYear === 'Cash' || /كاش|cash|خصم نادي|خصم نادى/i.test(contractor)
      ? '2026'
      : (priceListYear || '2026');

  let text = `Price list: Elite Hospital ${displayYear}
Contractor: ${contractor}
المسئول من قسم السيلز: ${officer}
Corporate Email: corporate@elitehospital.org
 
الإجراءات المتواجدة بلائحة أسعار التعاقد:
${matchedLines || 'لا توجد إجراءات مطابقة مباشرة باللائحة'}`;

  if (unmatchedLines) {
    text += `\n\n[⚠️  لم يتم العثور على الإجراءات التالية في لائحة أسعار التعاقد:\n${unmatchedLines}]`;
  }

  text += `\n\n@corporate@elitehospital.org`;

  return text;
}


/**
 * Checks whether the automation is currently paused.
 */
async function isAutomationPaused(): Promise<boolean> {
  const localSettings = loadLocalSettings();
  if (localSettings.isPaused) return true;

  try {
    const docRef = doc(db, 'settings', 'approvals_automation');
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      return Boolean(snap.data()?.isPaused);
    }
  } catch (err) {
    // Fall back to local settings
  }
  return false;
}

/**
 * Check if an email messageId has already been recorded in local storage or Firestore.
 */
async function isAlreadyProcessed(messageId: string): Promise<boolean> {
  const local = loadLocalApprovals();
  if (local.some((a) => a.messageId === messageId)) {
    return true;
  }

  try {
    const colRef = collection(db, 'inpatient_approvals');
    const q = query(colRef, where('messageId', '==', messageId));
    const snap = await getDocs(q);
    return !snap.empty;
  } catch (err) {
    return false;
  }
}

/**
 * Appends draft reply to IMAP Drafts folder.
 */
async function appendDraftToImap(
  client: ImapFlow,
  parsedEmail: ParsedApprovalEmail,
  draftText: string
): Promise<void> {
  const subject = parsedEmail.subject.toLowerCase().startsWith('re:')
    ? parsedEmail.subject
    : `RE: ${parsedEmail.subject}`;

  const rfc822Message = [
    `From: ${IMAP_USER}`,
    `To: ${parsedEmail.from || parsedEmail.to}`,
    parsedEmail.cc ? `Cc: ${parsedEmail.cc}` : '',
    `Subject: ${subject}`,
    `In-Reply-To: ${parsedEmail.messageId}`,
    `References: ${parsedEmail.messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    draftText,
  ]
    .filter(Boolean)
    .join('\r\n');

  try {
    await client.append(IMAP_DRAFTS_FOLDER, Buffer.from(rfc822Message, 'utf-8'), ['\\Draft', '\\Seen']);
    console.log(`[IMAP] Draft appended successfully to "${IMAP_DRAFTS_FOLDER}" for ${parsedEmail.mrn}`);
  } catch (err) {
    console.error(`[IMAP] Failed to append draft to ${IMAP_DRAFTS_FOLDER}:`, err);
  }
}

/**
 * Sends an NTLM-authenticated SOAP request to Exchange Web Services (EWS).
 */
export async function ewsRequest(soapBody: string): Promise<string> {
  return new Promise((resolve, reject) => {
    httpntlm.post(
      {
        url: EWS_URL,
        username: EXCHANGE_USERNAME,
        password: IMAP_PASSWORD,
        domain: EXCHANGE_DOMAIN,
        body: soapBody,
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
        },
        rejectUnauthorized: false,
      },
      (err: any, res: any) => {
        if (err) return reject(err);
        if (res.statusCode !== 200) {
          return reject(new Error(`EWS Status ${res.statusCode}: ${res.body}`));
        }
        resolve(res.body);
      }
    );
  });
}

/**
 * Resolves an Exchange folder ID by name (e.g. "InApprovals", "Drafts").
 */
export async function ewsResolveFolderId(folderName: string): Promise<string | null> {
  if (folderName.toLowerCase() === 'inbox') return 'inbox';
  if (folderName.toLowerCase() === 'drafts') return 'drafts';

  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:FindFolder Traversal="Deep">
      <m:FolderShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="folder:DisplayName"/>
        </t:AdditionalProperties>
      </m:FolderShape>
      <m:IndexedPageFolderView MaxEntriesReturned="100" Offset="0" BasePoint="Beginning"/>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="msgfolderroot"/>
      </m:ParentFolderIds>
    </m:FindFolder>
  </soap:Body>
</soap:Envelope>`;

  try {
    const xml = await ewsRequest(soap);
    const regex = new RegExp(
      `<t:Folder>[\\s\\S]*?<t:FolderId Id="([^"]+)" ChangeKey="([^"]+)"[\\s\\S]*?<t:DisplayName>${folderName}<\\/t:DisplayName>[\\s\\S]*?<\\/t:Folder>`,
      'i'
    );
    const match = xml.match(regex);
    if (match) {
      return match[1];
    }
  } catch (err) {
    console.warn(`[EWS] Error resolving folder "${folderName}":`, err);
  }
  return null;
}

export interface EwsSyncChangeItem {
  id: string;
  changeKey: string;
}

export interface EwsSyncResult {
  syncState: string;
  includesLastItemInRange: boolean;
  created: EwsSyncChangeItem[];
  updated: EwsSyncChangeItem[];
  deleted: string[];
}

/**
 * Synchronizes changes in an Exchange folder incrementally using EWS SyncFolderItems.
 */
export async function ewsSyncFolderItems(folderId: string, syncState?: string): Promise<EwsSyncResult> {
  const isDistinguished = ['inbox', 'drafts', 'deleteditems', 'sentitems', 'msgfolderroot'].includes(folderId.toLowerCase());
  const folderXml = isDistinguished
    ? `<t:DistinguishedFolderId Id="${folderId}"/>`
    : `<t:FolderId Id="${folderId}"/>`;

  const syncStateXml = syncState ? `<m:SyncState>${syncState}</m:SyncState>` : '';

  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:SyncFolderItems>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
      </m:ItemShape>
      <m:SyncFolderId>
        ${folderXml}
      </m:SyncFolderId>
      ${syncStateXml}
      <m:MaxChangesReturned>250</m:MaxChangesReturned>
      <m:SyncScope>NormalItems</m:SyncScope>
    </m:SyncFolderItems>
  </soap:Body>
</soap:Envelope>`;

  const xml = await ewsRequest(soap);

  if (xml.includes('ErrorInvalidSyncStateData')) {
    console.warn('[EWS] Invalid sync state token received. Resetting sync state...');
    throw new Error('ErrorInvalidSyncStateData');
  }

  const syncStateMatch = xml.match(/<m:SyncState>([^<]+)<\/m:SyncState>/);
  const nextSyncState = syncStateMatch ? syncStateMatch[1] : '';
  const includesLast = xml.includes('<m:IncludesLastItemInRange>true</m:IncludesLastItemInRange>');

  const created: EwsSyncChangeItem[] = [];
  const updated: EwsSyncChangeItem[] = [];
  const deleted: string[] = [];

  const createMatches = xml.matchAll(/<t:Create>[\s\S]*?<t:ItemId Id="([^"]+)" ChangeKey="([^"]+)"/g);
  for (const match of createMatches) {
    created.push({ id: match[1], changeKey: match[2] });
  }

  const updateMatches = xml.matchAll(/<t:Update>[\s\S]*?<t:ItemId Id="([^"]+)" ChangeKey="([^"]+)"/g);
  for (const match of updateMatches) {
    updated.push({ id: match[1], changeKey: match[2] });
  }

  const deleteMatches = xml.matchAll(/<t:Delete>[\s\S]*?<t:ItemId Id="([^"]+)"/g);
  for (const match of deleteMatches) {
    deleted.push(match[1]);
  }

  return {
    syncState: nextSyncState,
    includesLastItemInRange: includesLast,
    created,
    updated,
    deleted,
  };
}

/**
 * Finds recent items in an Exchange folder.
 * Supports date restriction (e.g. past 3 days) and automatic pagination.
 */
export async function ewsFindItemsInFolder(
  folderId: string,
  maxEntries = 500,
  sinceDateIso?: string
): Promise<Array<{ id: string; subject: string; dateTimeReceived?: string }>> {
  const isDistinguished = ['inbox', 'drafts', 'deleteditems', 'sentitems', 'msgfolderroot'].includes(folderId.toLowerCase());
  const folderXml = isDistinguished
    ? `<t:DistinguishedFolderId Id="${folderId}"/>`
    : `<t:FolderId Id="${folderId}"/>`;

  const restrictionXml = sinceDateIso
    ? `
      <m:Restriction>
        <t:IsGreaterThanOrEqualTo>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURIOrConstant>
            <t:Constant Value="${sinceDateIso}"/>
          </t:FieldURIOrConstant>
        </t:IsGreaterThanOrEqualTo>
      </m:Restriction>`
    : '';

  const allResults: Array<{ id: string; subject: string; dateTimeReceived?: string }> = [];
  let offset = 0;
  const pageSize = Math.min(maxEntries, 500);

  while (true) {
    const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="${pageSize}" Offset="${offset}" BasePoint="Beginning"/>
      ${restrictionXml}
      <m:SortOrder>
        <t:FieldOrder Order="Descending">
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
        </t:FieldOrder>
      </m:SortOrder>
      <m:ParentFolderIds>
        ${folderXml}
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>`;

    try {
      const xml = await ewsRequest(soap);
      const itemMatches = xml.matchAll(/<t:Message>([\s\S]*?)<\/t:Message>/g);
      let pageCount = 0;
      for (const match of itemMatches) {
        const msgBlock = match[1];
        const idMatch = msgBlock.match(/<t:ItemId Id="([^"]+)"/);
        const subjMatch = msgBlock.match(/<t:Subject>([^<]*)<\/t:Subject>/);
        const dateMatch = msgBlock.match(/<t:DateTimeReceived>([^<]*)<\/t:DateTimeReceived>/);
        if (idMatch) {
          allResults.push({
            id: idMatch[1],
            subject: subjMatch ? subjMatch[1] : '',
            dateTimeReceived: dateMatch ? dateMatch[1] : undefined,
          });
          pageCount++;
        }
      }

      const includesLast = xml.includes('IncludesLastItemInRange="true"');
      if (includesLast || pageCount === 0 || allResults.length >= maxEntries) {
        break;
      }
      offset += pageCount;
    } catch (err) {
      console.warn(`[EWS] Error searching items in folder "${folderId}":`, err);
      break;
    }
  }

  return allResults;
}

/**
 * Retrieves full details of an Exchange message.
 */
export async function ewsGetItemDetails(itemId: string) {
  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>AllProperties</t:BaseShape>
        <t:BodyType>HTML</t:BodyType>
      </m:ItemShape>
      <m:ItemIds>
        <t:ItemId Id="${itemId}"/>
      </m:ItemIds>
    </m:GetItem>
  </soap:Body>
</soap:Envelope>`;

  try {
    const xml = await ewsRequest(soap);
    const subject = xml.match(/<t:Subject>([^<]*)<\/t:Subject>/)?.[1] || '';
    const messageId = xml.match(/<t:InternetMessageId>([^<]*)<\/t:InternetMessageId>/)?.[1] || `<${itemId}@exchange>`;
    const from = xml.match(/<t:From>[\s\S]*?<t:EmailAddress>([^<]+)<\/t:EmailAddress>/)?.[1] || '';
    const bodyHtml = xml.match(/<t:Body[^>]*>([\s\S]*?)<\/t:Body>/)?.[1] || '';
    const inReplyTo = xml.match(/<t:InReplyTo>([^<]+)<\/t:InReplyTo>/)?.[1];
    const references = xml.match(/<t:References>([^<]+)<\/t:References>/)?.[1];
    const receivedAtStr = xml.match(/<t:DateTimeReceived>([^<]+)<\/t:DateTimeReceived>/)?.[1];
    const receivedAt = receivedAtStr ? new Date(receivedAtStr) : new Date();

    return {
      subject,
      messageId,
      from,
      to: '',
      cc: '',
      bodyHtml,
      bodyText: bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      inReplyTo,
      references,
      receivedAt,
    };
  } catch (err) {
    console.warn(`[EWS] Error getting item details for "${itemId}":`, err);
    return null;
  }
}

/**
 * Retrieves full details of multiple Exchange messages in a single batch SOAP call.
 */
export async function ewsGetItemsBatch(itemIds: string[]) {
  if (itemIds.length === 0) return [];
  const idsXml = itemIds.map((id) => `<t:ItemId Id="${id}"/>`).join('\n');
  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>AllProperties</t:BaseShape>
        <t:BodyType>HTML</t:BodyType>
      </m:ItemShape>
      <m:ItemIds>
        ${idsXml}
      </m:ItemIds>
    </m:GetItem>
  </soap:Body>
</soap:Envelope>`;

  try {
    const xml = await ewsRequest(soap);
    const messageBlocks = [...xml.matchAll(/<t:Message>([\s\S]*?)<\/t:Message>/g)];
    return messageBlocks.map((mb) => {
      const block = mb[1];
      const idMatch = block.match(/<t:ItemId Id="([^"]+)"/);
      const itemId = idMatch ? idMatch[1] : '';
      const subject = block.match(/<t:Subject>([^<]*)<\/t:Subject>/)?.[1] || '';
      const messageId = block.match(/<t:InternetMessageId>([^<]*)<\/t:InternetMessageId>/)?.[1] || `<${itemId}@exchange>`;
      const from = block.match(/<t:From>[\s\S]*?<t:EmailAddress>([^<]+)<\/t:EmailAddress>/)?.[1] || '';
      const bodyHtml = block.match(/<t:Body[^>]*>([\s\S]*?)<\/t:Body>/)?.[1] || '';
      const inReplyTo = block.match(/<t:InReplyTo>([^<]+)<\/t:InReplyTo>/)?.[1];
      const references = block.match(/<t:References>([^<]+)<\/t:References>/)?.[1];
      const conversationId = block.match(/<t:ConversationId Id="([^"]+)"/)?.[1] || '';
      const conversationTopic = block.match(/<t:ConversationTopic>([^<]*)<\/t:ConversationTopic>/)?.[1] || '';
      const receivedAtStr = block.match(/<t:DateTimeReceived>([^<]+)<\/t:DateTimeReceived>/)?.[1];
      const receivedAt = receivedAtStr ? new Date(receivedAtStr) : new Date();

      return {
        id: itemId,
        subject,
        messageId,
        from,
        to: '',
        cc: '',
        bodyHtml,
        bodyText: bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        inReplyTo,
        references,
        conversationId,
        conversationTopic,
        receivedAt,
      };
    });
  } catch (err) {
    console.warn(`[EWS] Error getting batch item details:`, err);
    return [];
  }
}

/**
 * Creates an in-thread draft reply in the Exchange Drafts folder.
 */
export async function ewsCreateDraft(draftData: {
  subject: string;
  to: string;
  cc?: string;
  body: string;
}): Promise<boolean> {
  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:CreateItem MessageDisposition="SaveOnly">
      <m:SavedItemFolderId>
        <t:DistinguishedFolderId Id="drafts"/>
      </m:SavedItemFolderId>
      <m:Items>
        <t:Message>
          <t:Subject>${draftData.subject.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</t:Subject>
          <t:Body BodyType="Text">${draftData.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</t:Body>
          <t:ToRecipients>
            <t:Mailbox>
              <t:EmailAddress>${draftData.to || 'corporate@elitehospital.org'}</t:EmailAddress>
            </t:Mailbox>
          </t:ToRecipients>
        </t:Message>
      </m:Items>
    </m:CreateItem>
  </soap:Body>
</soap:Envelope>`;

  try {
    const xml = await ewsRequest(soap);
    if (xml.includes('ResponseClass="Success"')) {
      console.log(`[EWS] Draft created successfully in Exchange Drafts folder.`);
      return true;
    }
  } catch (err) {
    console.error(`[EWS] Failed to create draft in Exchange:`, err);
  }
  return false;
}

/**
 * Creates an in-thread "Reply All" draft in Exchange using EWS ReplyAllToItem.
 * Preserves the entire email thread, subject, and recipients.
 */
export async function ewsCreateReplyAllDraft(params: {
  itemId?: string;
  changeKey?: string;
  body: string;
  fallbackSubject?: string;
  fallbackTo?: string;
}): Promise<boolean> {
  const { itemId, changeKey, body, fallbackSubject, fallbackTo } = params;

  if (itemId) {
    let currentChangeKey = changeKey;
    // If changeKey is missing, query Exchange for the item's fresh changeKey
    if (!currentChangeKey) {
      try {
        const getXml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
      </m:ItemShape>
      <m:ItemIds>
        <t:ItemId Id="${itemId}"/>
      </m:ItemIds>
    </m:GetItem>
  </soap:Body>
</soap:Envelope>`;
        const resp = await ewsRequest(getXml);
        const ckMatch = resp.match(/ChangeKey="([^"]+)"/);
        if (ckMatch) currentChangeKey = ckMatch[1];
      } catch (err) {
        console.warn('[EWS] Could not retrieve fresh ChangeKey:', err);
      }
    }

    if (currentChangeKey) {
      const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:CreateItem MessageDisposition="SaveOnly">
      <m:Items>
        <t:ReplyAllToItem>
          <t:ReferenceItemId Id="${itemId}" ChangeKey="${currentChangeKey}" />
          <t:NewBodyContent BodyType="Text">${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</t:NewBodyContent>
        </t:ReplyAllToItem>
      </m:Items>
    </m:CreateItem>
  </soap:Body>
</soap:Envelope>`;

      try {
        const xml = await ewsRequest(soap);
        if (xml.includes('ResponseClass="Success"')) {
          console.log(`[EWS] In-thread Reply-All draft created successfully for item: ${itemId}`);
          return true;
        } else {
          console.warn(`[EWS] ReplyAllToItem returned non-success response, falling back:`, xml.substring(0, 300));
        }
      } catch (soapErr) {
        console.warn(`[EWS] ReplyAllToItem soap error:`, soapErr);
      }
    }
  }

  // Fallback: create standalone draft
  return ewsCreateDraft({
    subject: fallbackSubject || 'RE: Inpatient Approval',
    to: fallbackTo || 'corporate@elitehospital.org',
    body,
  });
}

/**
 * Worker check loop using Exchange Web Services (EWS) over HTTPS 443 with NTLM.
 * Features incremental delta synchronization via SyncFolderItems and unified Gemini AI analysis.
 */
export async function runApprovalsCheckEws(force = false): Promise<void> {
  console.log(`[Approvals Watcher / EWS] Starting incremental sync with Exchange Server (${EWS_URL})...`);

  // 0. Broadcast syncing state to Firestore settings
  try {
    await setDoc(
      doc(db, 'settings', 'approvals_automation'),
      {
        isSyncing: true,
        lastRunAt: serverTimestamp(),
        syncError: null,
      },
      { merge: true }
    );
  } catch {}

  const startTime = Date.now();

  try {
    // 1. Enforce 30-day database rollover
    await purgeApprovalsOlderThan(MAX_HISTORY_DAYS);

    // 2. Process any manual draft requests submitted from UI (local storage first & Firestore)
    const localItems = loadLocalApprovals();
    for (const item of localItems) {
      if (item.manualDraftRequested && item.status !== 'draft_created') {
        try {
          console.log(`[Approvals Watcher / EWS] Executing manual draft request for MRN: ${item.mrn}...`);
          await ewsCreateReplyAllDraft({
            itemId: item.exchangeItemId || (item as any).lastExchangeItemId,
            changeKey: item.exchangeChangeKey,
            body: item.draftBody,
            fallbackSubject: `Inpatient Approval - ${item.patientName} (MRN: ${item.mrn})`,
            fallbackTo: item.contractorRaw || 'corporate@elitehospital.org',
          });
          item.manualDraftRequested = false;
          item.status = 'draft_created';
          item.draftedAt = new Date().toISOString();
          upsertLocalApproval(item);
          console.log(`[Approvals Watcher / EWS] Manual draft created in Exchange for MRN: ${item.mrn}`);
        } catch (dErr) {
          console.error('Failed to create manual draft:', dErr);
        }
      }
    }

    try {
      const approvalsCol = collection(db, 'inpatient_approvals');
      const manualQuery = query(approvalsCol, where('manualDraftRequested', '==', true));
      const manualSnaps = await getDocs(manualQuery);

      for (const snap of manualSnaps.docs) {
        const item = snap.data() as InpatientApprovalRecord;
        await ewsCreateReplyAllDraft({
          itemId: item.exchangeItemId || (item as any).lastExchangeItemId,
          changeKey: item.exchangeChangeKey,
          body: item.draftBody,
          fallbackSubject: `Inpatient Approval - ${item.patientName} (MRN: ${item.mrn})`,
          fallbackTo: item.contractorRaw || 'corporate@elitehospital.org',
        });

        await updateDoc(snap.ref, {
          manualDraftRequested: false,
          status: 'draft_created',
          draftedAt: serverTimestamp(),
        });
      }
    } catch {}

    // 3. Resolve target folder (use user's exact InApprovals folder ID)
    let folderId = IMAP_FOLDER;
    if (!folderId || folderId.toLowerCase() === 'inapprovals' || folderId.startsWith('AAMk') || folderId.startsWith('AQMk')) {
      folderId = EXACT_INAPPROVALS_FOLDER_ID;
    } else {
      folderId = (await ewsResolveFolderId(folderId)) || 'inbox';
    }

    // 4. Fetch all items from the previous 3 calendar days (Rolling 3-day window)
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const threeDaysAgoIso = threeDaysAgo.toISOString();
    console.log(`[Approvals Watcher / EWS] Fetching items received in previous 3 days (>= ${threeDaysAgoIso})...`);

    const recentItems = await ewsFindItemsInFolder(folderId, 500, threeDaysAgoIso);
    console.log(`[Approvals Watcher / EWS] Found ${recentItems.length} items in previous 3 days.`);

    // Pre-seed maps with existing local approvals so ongoing threads link properly
    const recordsByDocId = new Map<string, InpatientApprovalRecord>();
    const existingByMsgId = new Map<string, string>(); // cleaned msgId -> mrn
    const existingByThreadKey = new Map<string, InpatientApprovalRecord>(); // threadKey -> record

    for (const existing of loadLocalApprovals()) {
      if (existing.id && existing.mrn) {
        // Clean up obsolete single-MRN record if it exists
        if (existing.id === `mrn_${existing.mrn}`) {
          deleteLocalApproval(existing.id);
          deleteDoc(doc(db, 'inpatient_approvals', existing.id)).catch(() => {});
          continue;
        }

        recordsByDocId.set(existing.id, existing);
        if ((existing as any).threadKey) {
          existingByThreadKey.set((existing as any).threadKey, existing);
        }
        if (existing.messageId) {
          existingByMsgId.set(cleanMsgId(existing.messageId), existing.mrn);
        }
        if (existing.exchangeItemId) {
          existingByMsgId.set(cleanMsgId(existing.exchangeItemId), existing.mrn);
        }
        if (existing.lastExchangeItemId) {
          existingByMsgId.set(cleanMsgId(existing.lastExchangeItemId), existing.mrn);
        }
      }
    }

    // Batch-fetch details for items in parallel chunks of 35
    const fullItems: any[] = [];
    const chunkSize = 35;
    const chunkPromises: Promise<any[]>[] = [];
    for (let i = 0; i < recentItems.length; i += chunkSize) {
      const chunkIds = recentItems.slice(i, i + chunkSize).map((r) => r.id);
      chunkPromises.push(
        ewsGetItemsBatch(chunkIds).catch((err) => {
          console.warn(`[Approvals Watcher / EWS] Batch fetch error for chunk ${i}:`, err);
          return [];
        })
      );
    }
    const chunkBatches = await Promise.all(chunkPromises);
    for (const b of chunkBatches) {
      fullItems.push(...b);
    }

    // Filter spam / automated alerts
    const validItems = fullItems.filter((item) => {
      if (!item) return false;
      const fromLower = (item.from || '').toLowerCase().trim();
      if (
        fromLower === 'notifications@elitehospital.org' ||
        fromLower === 'notifications@' ||
        (fromLower.startsWith('notifications@') && !fromLower.includes('his.'))
      ) {
        return false;
      }
      return true;
    });

    // Build message lookup map
    const itemByMsgId = new Map<string, any>();
    for (const item of validItems) {
      const cId = cleanMsgId(item.messageId);
      if (cId) itemByMsgId.set(cId, item);
      if (item.id) itemByMsgId.set(cleanMsgId(item.id), item);
    }

    // Pass 1: Direct MRN detection on each message
    const itemMrnMap = new Map<any, string>();
    for (const item of validItems) {
      const subject = item.subject || '';
      const fullHtml = item.bodyHtml || '';
      const fullText = item.bodyText || '';
      const cleanBody = cleanTextFromHtml(fullText + '\n' + fullHtml);

      const mrnMatch =
        subject.match(/\(MRN:\s*(\d+)\)/i) ||
        cleanBody.match(/Patient Barcode:\s*(\d+)/i) ||
        cleanBody.match(/(?:MRN|الرقم الطبي)\s*[:\/\s]*(\d{5,12})/i) ||
        cleanBody.match(/\b(0000\d{5,7}|\d{6,8})\b/);
      const detected = mrnMatch ? mrnMatch[1] : '';
      if (detected && detected !== '0000000000') {
        itemMrnMap.set(item, detected);
      }
    }

    // Pass 2 & 3: Inherit MRN from InReplyTo and References ancestors
    for (let pass = 0; pass < 3; pass++) {
      for (const item of validItems) {
        if (itemMrnMap.has(item)) continue;

        // Check InReplyTo
        const inReplyTo = cleanMsgId(item.inReplyTo);
        if (inReplyTo) {
          if (existingByMsgId.has(inReplyTo)) {
            itemMrnMap.set(item, existingByMsgId.get(inReplyTo)!);
            continue;
          }
          const parent = itemByMsgId.get(inReplyTo);
          if (parent && itemMrnMap.has(parent)) {
            itemMrnMap.set(item, itemMrnMap.get(parent)!);
            continue;
          }
        }

        // Check References
        const refs = (item.references || '')
          .split(/[\s,]+/)
          .map(cleanMsgId)
          .filter(Boolean);
        for (const r of refs) {
          if (existingByMsgId.has(r)) {
            itemMrnMap.set(item, existingByMsgId.get(r)!);
            break;
          }
          const anc = itemByMsgId.get(r);
          if (anc && itemMrnMap.has(anc)) {
            itemMrnMap.set(item, itemMrnMap.get(anc)!);
            break;
          }
        }
      }
    }

    // Helper to resolve thread root message ID
    // RFC 2822 / 5322 dictates that:
    // 1. If References header is present, references[0] is the root message ID of the thread.
    // 2. Otherwise if In-Reply-To is present, traverse parent chain up to root.
    // 3. Otherwise the message is itself the original root approval request.
    // NOTE: We do NOT use Exchange conversationId because Exchange collapses all emails
    // with identical subjects for the same patient into one conversationId!
    function getThreadKey(item: any): string {
      const refs = (item.references || '')
        .split(/[\s,]+/)
        .map(cleanMsgId)
        .filter(Boolean);
      if (refs.length > 0) {
        return refs[0];
      }

      let curr = item;
      const visited = new Set<string>();
      while (curr) {
        const parentRefs = (curr.references || '')
          .split(/[\s,]+/)
          .map(cleanMsgId)
          .filter(Boolean);
        if (parentRefs.length > 0) {
          return parentRefs[0];
        }

        const parentMsgId = cleanMsgId(curr.inReplyTo);
        if (!parentMsgId || visited.has(parentMsgId)) break;
        visited.add(parentMsgId);
        const parent = itemByMsgId.get(parentMsgId);
        if (parent) {
          curr = parent;
        } else {
          return parentMsgId;
        }
      }

      return cleanMsgId(curr.messageId) || curr.id || `thread_${Date.now()}`;
    }

    // Group items by conversation / email thread
    const messagesByThread = new Map<string, any[]>();
    for (const item of validItems) {
      const thKey = getThreadKey(item);
      if (!messagesByThread.has(thKey)) {
        messagesByThread.set(thKey, []);
      }
      messagesByThread.get(thKey)!.push(item);
    }

    // Load active 2025 pricelist rows for AI matching candidate pool
    let pricelistCandidates: Array<{ id: number; nameEnglish: string; nameArabic?: string; sectionName?: string }> = [];
    try {
      const pPath = path.resolve(process.cwd(), 'public', '2025_cash.json');
      if (fs.existsSync(pPath)) {
        const pList = JSON.parse(fs.readFileSync(pPath, 'utf-8'));
        pricelistCandidates = pList.slice(0, 150).map((row: any, idx: number) => ({
          id: idx,
          nameEnglish: row.nameEnglish || '',
          nameArabic: row.nameArabic || '',
          sectionName: row.sectionName || '',
        }));
      }
    } catch {}

    const dirtyRecords: InpatientApprovalRecord[] = [];

    // Process each thread with Unified Contextual AI Agent
    for (const [thKey, items] of messagesByThread.entries()) {
      // 1. Resolve MRN for this thread
      let mrn = '';
      for (const it of items) {
        const m = itemMrnMap.get(it);
        if (m && m !== '0000000000') {
          mrn = m;
          break;
        }
      }
      if (!mrn) {
        for (const it of items) {
          const txt = cleanTextFromHtml((it.subject || '') + ' ' + (it.bodyText || '') + ' ' + (it.bodyHtml || ''));
          const mm =
            txt.match(/\(MRN:\s*(\d+)\)/i) ||
            txt.match(/Patient Barcode:\s*(\d+)/i) ||
            txt.match(/(?:MRN|الرقم الطبي)\s*[:\/\s]*(\d{5,12})/i) ||
            txt.match(/\b(0000\d{5,7}|\d{6,8})\b/);
          if (mm && mm[1] !== '0000000000') {
            mrn = mm[1];
            break;
          }
        }
      }
      if (!mrn) {
        const existingThread = existingByThreadKey.get(thKey);
        if (existingThread && existingThread.mrn) {
          mrn = existingThread.mrn;
        } else {
          for (const it of items) {
            const inReplyTo = cleanMsgId(it.inReplyTo);
            if (inReplyTo && existingByMsgId.has(inReplyTo)) {
              mrn = existingByMsgId.get(inReplyTo)!;
              break;
            }
          }
        }
      }

      if (!mrn || mrn === '0000000000') {
        continue;
      }

      const threadShortHash = crypto.createHash('md5').update(thKey).digest('hex').substring(0, 8);
      const docId = `mrn_${mrn}_${threadShortHash}`;
      let record = recordsByDocId.get(docId) || existingByThreadKey.get(thKey);

      // Clean up obsolete single-MRN record if it exists
      const obsoleteDocId = `mrn_${mrn}`;
      if (recordsByDocId.has(obsoleteDocId)) {
        recordsByDocId.delete(obsoleteDocId);
        deleteLocalApproval(obsoleteDocId);
        deleteDoc(doc(db, 'inpatient_approvals', obsoleteDocId)).catch(() => {});
      }

      // Sort items chronologically
      items.sort((a, b) => (a.receivedAt?.getTime() || 0) - (b.receivedAt?.getTime() || 0));

      // Compute thread hash for fast change detection
      const rawThreadContent = mrn + thKey + items.map((it) => `${it.id}_${it.messageId}_${it.receivedAt?.getTime()}`).join('|');
      const threadHash = crypto.createHash('md5').update(rawThreadContent).digest('hex');

      // Calculate timestamp of the MOST RECENT email in thread
      const mostRecentDate = items.reduce((latest, it) => {
        const d = it.receivedAt instanceof Date ? it.receivedAt : new Date(it.receivedAt || 0);
        return d.getTime() > latest.getTime() ? d : latest;
      }, new Date(0));
      const finalReceivedAt = mostRecentDate.getTime() > 0 ? Timestamp.fromDate(mostRecentDate) : (record?.receivedAt || serverTimestamp());

      // If threadHash is identical to existing record, update receivedAt if changed and skip heavy processing immediately
      if (record && record.threadHash === threadHash && record.aiProcessingStatus === 'processed') {
        const existingDate =
          record.receivedAt && (record.receivedAt as any).toDate
            ? (record.receivedAt as any).toDate().getTime()
            : new Date((record.receivedAt as any) || 0).getTime();
        if (Math.abs(existingDate - mostRecentDate.getTime()) > 1000) {
          record.receivedAt = finalReceivedAt;
          dirtyRecords.push(record);
        }
        continue;
      }

      // Separate original request from replies: prioritize items with SELECTED SERVICES or table
      let primaryRequestItem = items.find((it) => {
        const html = it.bodyHtml || '';
        const txt = it.bodyText || '';
        const isReply = /^(re|رد|fw|fwd)\s*:/i.test((it.subject || '').trim());
        return !isReply && (html.includes('SELECTED SERVICES') || txt.includes('SELECTED SERVICES') || html.includes('Service Name'));
      });

      if (!primaryRequestItem) {
        primaryRequestItem = items.find((it) => {
          const subj = (it.subject || '').toLowerCase();
          const html = it.bodyHtml || '';
          const isReply = /^(re|رد|fw|fwd)\s*:/i.test(subj.trim());
          return !isReply && (html.includes('Patient Information') || html.includes('Patient Barcode') || subj.includes('inpatient approval'));
        });
      }

      const originalRequestItem = primaryRequestItem || items[0];

      // Parse all items in the thread to aggregate clinical & contractual data
      const parsedApprovals = items.map((it) => {
        const dHtml = decodeHtmlEntities(it.bodyHtml || '');
        const cSubj = it.subject || '';
        return parseHisApprovalHtml(dHtml, cSubj, it.messageId || `<${mrn}@exchange>`);
      });

      const parsedApproval = parseHisApprovalHtml(
        decodeHtmlEntities(originalRequestItem?.bodyHtml || ''),
        originalRequestItem?.subject || `Inpatient Approval (MRN: ${mrn})`,
        originalRequestItem?.messageId || `<${mrn}@exchange>`
      );

      // Aggregate requested services across thread
      const servicesMap = new Map<string, { name: string; rawPrice: number }>();
      for (const pa of parsedApprovals) {
        for (const s of pa.requestedServices) {
          const key = s.name.trim().toLowerCase();
          if (key && !servicesMap.has(key)) {
            servicesMap.set(key, s);
          }
        }
      }

      // Check if any approval reply specifies a concrete procedure
      let replyApprovedProcedure = '';
      for (const it of items) {
        const clean = cleanTextFromHtml((it.bodyText || '') + ' ' + (it.bodyHtml || ''));
        const proc = extractProcedureFromApprovalReply(clean);
        if (proc) {
          replyApprovedProcedure = proc;
          break;
        }
      }

      if (servicesMap.size === 0 && replyApprovedProcedure) {
        servicesMap.set(replyApprovedProcedure.toLowerCase(), {
          name: replyApprovedProcedure,
          rawPrice: 0,
        });
      }

      // If still no services found, check if this thread is an admission request
      if (servicesMap.size === 0) {
        const allThreadText = items.map((it) => (it.subject || '') + ' ' + (it.bodyText || '')).join(' ');
        if (/icu|رعاية|عناية/i.test(allThreadText)) {
          servicesMap.set('icu_admission', {
            name: 'إقامة رعاية مركزة (ICU Admission)',
            rawPrice: 0,
          });
        } else if (/inpatient|قسم داخلي|طلب إقامة|دخول|admission/i.test(allThreadText)) {
          servicesMap.set('inpatient_admission', {
            name: 'إقامة بالقسم الداخلي (Inpatient Admission)',
            rawPrice: 0,
          });
        }
      }

      const aggregatedServices = Array.from(servicesMap.values());

      // Aggregate diagnosis: prefer explicit clinical/ICD diagnosis over generic fallback
      let resolvedDiagnosis = '';
      for (const pa of parsedApprovals) {
        if (
          pa.diagnosis &&
          !pa.diagnosis.toLowerCase().includes('evaluation') &&
          !pa.diagnosis.toLowerCase().includes('staff') &&
          pa.diagnosis.trim().length > 2
        ) {
          resolvedDiagnosis = pa.diagnosis.trim();
          break;
        }
      }
      if (!resolvedDiagnosis) {
        for (const it of items) {
          const clean = cleanTextFromHtml((it.bodyText || '') + ' ' + (it.bodyHtml || ''));
          const dm = clean.match(/Diagnosis\s*[:\s]+([^\n\r<]+)/i);
          if (dm && dm[1].trim() && !dm[1].toLowerCase().includes('evaluation')) {
            resolvedDiagnosis = dm[1].trim();
            break;
          }
        }
      }
      if (!resolvedDiagnosis) {
        resolvedDiagnosis = replyApprovedProcedure || parsedApproval.diagnosis || record?.diagnosis || 'Inpatient Clinical Evaluation';
      }

      // Aggregate bed
      let resolvedBed = '';
      for (const pa of parsedApprovals) {
        if (pa.bed && pa.bed.trim() && !pa.bed.toLowerCase().includes('inpatient bed')) {
          resolvedBed = pa.bed.trim();
          break;
        }
      }
      if (!resolvedBed) {
        resolvedBed = parsedApproval.bed || record?.bed || 'Inpatient Bed';
      }

      // Aggregate physician
      let resolvedPhysician = '';
      for (const pa of parsedApprovals) {
        if (pa.physician && pa.physician.trim() && !pa.physician.toLowerCase().includes('hospital staff')) {
          resolvedPhysician = pa.physician.trim();
          break;
        }
      }
      if (!resolvedPhysician) {
        resolvedPhysician = parsedApproval.physician || record?.physician || 'Hospital Staff';
      }

      // Aggregate contractor
      let resolvedContractorRaw = '';
      for (const pa of parsedApprovals) {
        if (pa.contractorRaw && pa.contractorRaw.trim() && pa.contractorRaw !== 'غير محدد') {
          resolvedContractorRaw = pa.contractorRaw.trim();
          break;
        }
      }
      if (!resolvedContractorRaw) {
        resolvedContractorRaw = parsedApproval.contractorRaw || record?.contractorRaw || '';
      }

      // Resolve patient name (check parsedApproval, record, or any item in thread)
      let resolvedPatientName = parsedApproval.patientName;
      if (!resolvedPatientName || resolvedPatientName === 'Unknown Patient' || resolvedPatientName.includes('Unknown') || !resolvedPatientName.trim()) {
        resolvedPatientName = record?.patientName || '';
      }
      if (!resolvedPatientName || resolvedPatientName === 'Unknown Patient' || resolvedPatientName.includes('Unknown') || !resolvedPatientName.trim()) {
        // Search thread items for Patient Name
        for (const it of items) {
          const txt = cleanTextFromHtml(it.bodyText || it.bodyHtml || '');
          const m =
            txt.match(/Patient Name:\s*([^<\n\r]+?)(?=\s*(?:Contractor|Visit|Admission|Physician|Diagnosis|Bed|Request|Selected|جهة|الجهة|الرقم|$))/i) ||
            txt.match(/(?:حاله|حالة)\s*[:\/]\s*([^<\n\r]+?)(?=\s*(?:Contractor|Visit|Admission|Physician|Diagnosis|Bed|Request|Selected|جهة|الجهة|الرقم|$))/i);
          if (m && m[1].trim() && !m[1].includes('Unknown')) {
            resolvedPatientName = m[1].trim();
            break;
          }
        }
      }

      // Strictly reject empty or unknown patient
      if (!resolvedPatientName || resolvedPatientName === 'Unknown Patient' || resolvedPatientName.includes('Unknown') || !resolvedPatientName.trim()) {
        console.log(`[Approvals Watcher / EWS] Skipping malformed/empty approval email without patient info (MRN: ${mrn})`);
        continue;
      }

      const { contractorNormalized, priceListYear, contractorOfficer } = await resolveContractor(resolvedContractorRaw || '');

      // Build chronological thread messages
      const threadMessages = items.map((it) => {
        const subj = it.subject || '';
        const isReply = /^(re|رد|fw|fwd)\s*:/i.test(subj.trim());
        return {
          sender: it.from || 'Unknown',
          date: it.receivedAt ? it.receivedAt.toISOString() : new Date().toISOString(),
          subject: subj,
          body: cleanTextFromHtml(it.bodyText || it.bodyHtml || ''),
          isReply,
        };
      });

      console.log(`[Approvals Watcher / EWS] Running Unified Contextual AI Agent for MRN: ${mrn} (${resolvedPatientName})...`);

      // Run Unified Contextual AI Agent
      const threadInput: UnifiedThreadInput = {
        patientName: resolvedPatientName,
        mrn,
        bed: resolvedBed,
        admissionType: parsedApproval.admissionType || record?.admissionType || 'Inpatient',
        contractor: contractorNormalized,
        contractorOfficer,
        priceListYear,
        diagnosis: resolvedDiagnosis,
        initialServices: aggregatedServices.length > 0 ? aggregatedServices : (record?.requestedServices || []),
        threadMessages,
        candidatePricelistRows: pricelistCandidates,
      };

      let aiResult: UnifiedThreadOutput;
      let aiProcessingStatus: 'processed' | 'fallback_heuristic' = 'processed';

      try {
        aiResult = await analyzeThreadWithUnifiedAI(threadInput);
      } catch (agentErr) {
        console.warn(`[Approvals Watcher / EWS] Unified AI agent failed for MRN ${mrn}, using heuristics:`, agentErr);
        aiResult = analyzeThreadWithHeuristics(threadInput);
        aiProcessingStatus = 'fallback_heuristic';
      }

      // Extract credit limit and approval snippet across all thread messages
      let threadCreditLimit: { limit?: number; formatted?: string } = {};
      let threadApprovalSnippet = '';
      for (const m of threadMessages) {
        const cl = extractCreditLimit(m.body);
        if (cl.limit) threadCreditLimit = cl;
        const app = detectExistingApproval(m.body, m.subject);
        if (app.hasApproval && app.snippet) {
          threadApprovalSnippet = app.snippet;
          if (app.creditLimit) {
            threadCreditLimit = { limit: app.creditLimit, formatted: app.creditLimitText };
          }
        }
      }

      const isRecordApproved = aiResult.status === 'approved' || Boolean(threadApprovalSnippet);
      const finalLimit = threadCreditLimit.limit ?? aiResult.approvedAmountLimit ?? null;
      const finalLimitText = threadCreditLimit.formatted || (finalLimit ? `${finalLimit.toLocaleString('en-US')} EGP` : null);

      const updatedRecord: InpatientApprovalRecord = {
        id: docId,
        conversationId: thKey,
        messageId: originalRequestItem?.messageId || record?.messageId || `<${mrn}@exchange>`,
        exchangeItemId: originalRequestItem?.id || items[0]?.id || null,
        exchangeChangeKey: originalRequestItem?.changeKey || items[0]?.changeKey || null,
        receivedAt: finalReceivedAt,
        patientName: threadInput.patientName,
        mrn,
        diagnosis: threadInput.diagnosis,
        admissionType: threadInput.admissionType,
        bed: threadInput.bed,
        physician: resolvedPhysician,
        contractorRaw: resolvedContractorRaw || contractorNormalized,
        contractorNormalized,
        priceListYear,
        contractorOfficer,
        requestedServices: threadInput.initialServices,
        matchedProcedures: aiResult.matchedProcedures,
        status: isRecordApproved ? 'approved' : aiResult.status,
        statusReasonArabic: isRecordApproved
          ? `تمت الموافقة واعتماد الحالة${finalLimit ? ` بحد أقصى ${finalLimit.toLocaleString('en-US')} ج.م` : ' باللائحة'}`
          : aiResult.statusReasonArabic,
        patientSharePercentage: aiResult.patientSharePercentage,
        approvedAmountLimit: finalLimit,
        coverageConditions: isRecordApproved ? '' : aiResult.coverageConditions,
        aiThreadSummary: isRecordApproved && !aiResult.executiveSummaryArabic.includes('تمت الموافقة')
          ? `طلب موافقة للمريض ${threadInput.patientName} (${contractorNormalized}). تمت الموافقة على الدخول والإجراء${replyApprovedProcedure ? ` (${replyApprovedProcedure})` : ''}${finalLimit ? ` بحد أقصى ${finalLimit.toLocaleString('en-US')} ج.م` : ' باللائحة'}. الحالة معتمدة ولا توجد متطلبات ناقصة.`
          : aiResult.executiveSummaryArabic,
        draftBody: aiResult.suggestedDraftReply,
        cmWhatsappMessage: aiResult.cmWhatsappMessage,
        draftedAt: record?.draftedAt || (aiResult.status === 'draft_created' ? new Date().toISOString() : null),
        hasReplies: threadMessages.some((m) => m.isReply),
        replySnippet: threadMessages.find((m) => m.isReply && m.body && !m.body.includes('Inpatient Approval'))?.body?.substring(0, 100) || '',
        hasExistingApproval: isRecordApproved,
        existingApprovalSnippet: threadApprovalSnippet || replyApprovedProcedure || aiResult.statusReasonArabic || '',
        creditLimit: finalLimit,
        creditLimitText: finalLimitText,
        isRefused: !isRecordApproved && aiResult.status === 'refused',
        threadHash,
        aiProcessingStatus,
        lastExchangeItemId: items[items.length - 1]?.id || originalRequestItem?.id || null,
        lastExchangeChangeKey: items[items.length - 1]?.changeKey || originalRequestItem?.changeKey || null,
        threadKey: thKey,
      };

      // Always guarantee conclusive Case Manager WhatsApp message
      updatedRecord.cmWhatsappMessage = generateCmWhatsappMessage(updatedRecord);

      recordsByDocId.set(docId, updatedRecord);
      existingByThreadKey.set(thKey, updatedRecord);
      dirtyRecords.push(updatedRecord);
    }

    // Persist only dirty records to local storage and Firestore
    if (dirtyRecords.length > 0) {
      console.log(`[Approvals Watcher / EWS] Persisting ${dirtyRecords.length} updated approval records...`);
      for (const rec of dirtyRecords) {
        upsertLocalApproval({
          ...rec,
          receivedAt:
            rec.receivedAt && (rec.receivedAt as any).toDate
              ? (rec.receivedAt as any).toDate().toISOString()
              : typeof rec.receivedAt === 'string'
              ? rec.receivedAt
              : new Date().toISOString(),
          draftedAt:
            rec.draftedAt && (rec.draftedAt as any).toDate
              ? (rec.draftedAt as any).toDate().toISOString()
              : rec.draftedAt,
        });

      }

      // High-performance batched Firestore writes (max 450 per batch)
      const batchSize = 450;
      for (let i = 0; i < dirtyRecords.length; i += batchSize) {
        const slice = dirtyRecords.slice(i, i + batchSize);
        const batch = writeBatch(db);
        for (const rec of slice) {
          const docRef = doc(db, 'inpatient_approvals', rec.id);
          const fsData: any = {};
          for (const [k, v] of Object.entries(rec)) {
            fsData[k] = v === undefined ? null : v;
          }
          batch.set(docRef, fsData, { merge: true });
        }
        try {
          await Promise.race([
            batch.commit(),
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Firestore batch commit timeout')), 10000)),
          ]);
          console.log(`[Approvals Watcher / EWS] Committed Firestore batch of ${slice.length} records.`);
        } catch (batchErr) {
          console.warn(`[Approvals Watcher / EWS] Firestore batch write error:`, batchErr);
        }
      }
    }

    // 30-Day Cumulative History Rollover: Purge records older than 30 days
    await purgeApprovalsOlderThan(MAX_HISTORY_DAYS);

    const durationMs = Date.now() - startTime;
    try {
      await Promise.race([
        setDoc(
          doc(db, 'settings', 'approvals_automation'),
          {
            isSyncing: false,
            lastSyncCompletedAt: serverTimestamp(),
            lastSyncCount: dirtyRecords.length,
            lastSyncDurationMs: durationMs,
            syncError: null,
          },
          { merge: true }
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Settings write timeout')), 5000)),
      ]);
    } catch {}

    console.log(`[Approvals Watcher / EWS] Incremental sync complete (${dirtyRecords.length} updated) in ${durationMs}ms.`);
  } catch (err: any) {
    console.error('[Approvals Watcher / EWS] Sync error:', err);
    try {
      await setDoc(
        doc(db, 'settings', 'approvals_automation'),
        {
          isSyncing: false,
          syncError: err?.message || String(err),
        },
        { merge: true }
      );
    } catch {}
  }
}

/**
 * Main worker check loop.
 */
export async function runApprovalsCheck(client?: ImapFlow, force = false): Promise<void> {
  // 1. Check if paused (force bypasses pause for manual sync)
  if (!force) {
    const paused = await isAutomationPaused();
    if (paused) {
      console.log('[Approvals Watcher] Automation is PAUSED via Dashboard. Skipping check.');
      return;
    }
  }

  if (!IMAP_HOST || !IMAP_USER || !IMAP_PASSWORD) {
    console.log('[Approvals Watcher] IMAP credentials not configured in .env. Running in dry-run mode.');
    return;
  }

  // If server is on-premise Exchange (e.g. wmail.elitehospital.org), use Exchange Web Services (EWS) over HTTPS 443
  if (IS_EXCHANGE_EWS) {
    await runApprovalsCheckEws(force);
    return;
  }

  const imap = client || new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: IMAP_SECURE,
    auth: {
      user: IMAP_USER,
      pass: IMAP_PASSWORD,
    },
    logger: false,
  });

  try {
    if (!client) await imap.connect();

    const lock = await imap.getMailboxLock(IMAP_FOLDER);
    try {
      console.log(`[Approvals Watcher] Checking folder "${IMAP_FOLDER}"...`);

      // Process any manual draft requests submitted from UI
      try {
        const approvalsCol = collection(db, 'inpatient_approvals');
        const manualQuery = query(approvalsCol, where('manualDraftRequested', '==', true));
        const manualSnaps = await getDocs(manualQuery);

        for (const snap of manualSnaps.docs) {
          const item = snap.data() as InpatientApprovalRecord;
          console.log(`[Approvals Watcher] Executing manual draft request from UI for MRN: ${item.mrn}...`);
          await appendDraftToImap(imap, {
            messageId: item.messageId,
            subject: `Inpatient Approval - ${item.patientName} (MRN: ${item.mrn})`,
            from: '',
            to: '',
            cc: '',
            patientName: item.patientName,
            mrn: item.mrn,
            admissionDate: '',
            admissionType: item.admissionType || '',
            bed: item.bed || '',
            physician: item.physician || '',
            contractorRaw: item.contractorRaw,
            diagnosis: item.diagnosis,
            requestedServices: item.requestedServices,
            requestDetails: '',
          }, item.draftBody);

          await updateDoc(snap.ref, {
            manualDraftRequested: false,
            status: 'draft_created',
            draftedAt: serverTimestamp(),
          });
          console.log(`[Approvals Watcher] Manual draft successfully created in Outlook for MRN: ${item.mrn}`);
        }
      } catch (manualErr) {
        console.warn('Error processing manual drafts:', manualErr);
      }

      // Enforce 30-day database rollover
      await purgeApprovalsOlderThan(MAX_HISTORY_DAYS);

      // Search for unread emails within the 30-day window
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - MAX_HISTORY_DAYS);
      thirtyDaysAgo.setHours(0, 0, 0, 0);

      const messages = imap.fetch({ seen: false, since: thirtyDaysAgo }, { source: true, envelope: true });

      for await (const msg of messages) {
        const parsed = await simpleParser(msg.source);
        const subject = parsed.subject || '';
        const messageId = parsed.messageId || `<${crypto.randomUUID()}@local>`;

        // Filter: only process Inpatient Approval emails
        if (!subject.toLowerCase().includes('inpatient approval')) {
          continue;
        }

        // Check deduplication
        if (await isAlreadyProcessed(messageId)) {
          console.log(`[Approvals Watcher] Skipping already-processed message: ${subject}`);
          continue;
        }

        console.log(`[Approvals Watcher] Processing new approval: ${subject}`);

        // Parse HTML
        const approvalData = parseHisApprovalHtml(parsed.html || '', subject, messageId);
        approvalData.from = parsed.from?.text || '';
        approvalData.to = Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join('; ') : parsed.to?.text || '';
        approvalData.cc = Array.isArray(parsed.cc) ? parsed.cc.map((c) => c.text).join('; ') : parsed.cc?.text || '';

        // Check for existing replies and approval keywords
        const emailContent = (parsed.text || '') + '\n' + (parsed.html || '');
        const approvalCheck = detectExistingApproval(emailContent, subject);
        const replyCheck = detectReplies({
          subject,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references,
          text: parsed.text,
          html: parsed.html,
        });

        const shouldHoldDraft = approvalCheck.hasApproval || replyCheck.hasReplies;

        // Resolve Contractor & Officer
        const { contractorNormalized, priceListYear, contractorOfficer } = await resolveContractor(
          approvalData.contractorRaw
        );

        // Match Procedures
        const matched = await matchRequestedProcedures(approvalData.requestedServices, priceListYear);

        // Build Draft (always mentions corporate@elitehospital.org)
        const draftBody = buildDraftReplyText(priceListYear, contractorNormalized, contractorOfficer, matched);

        // Append to Outlook via IMAP ONLY if no prior replies or approval keywords were detected
        if (!shouldHoldDraft) {
          await appendDraftToImap(imap, approvalData, draftBody);
          console.log(`[Approvals Watcher] Auto-drafted reply to Outlook for MRN: ${approvalData.mrn}`);
        } else {
          console.log(
            `[Approvals Watcher] ⚠️ Reply/Approval note detected (${approvalCheck.snippet || replyCheck.snippet}). Skipping auto-draft. Awaiting manual trigger in UI.`
          );
        }

        // Save to Firestore
        const docId = crypto.createHash('md5').update(messageId).digest('hex');
        const docRef = doc(db, 'inpatient_approvals', docId);

        const record: InpatientApprovalRecord = {
          id: docId,
          messageId,
          receivedAt: parsed.date ? Timestamp.fromDate(parsed.date) : serverTimestamp(),
          patientName: approvalData.patientName,
          mrn: approvalData.mrn,
          diagnosis: approvalData.diagnosis,
          admissionType: approvalData.admissionType,
          bed: approvalData.bed,
          physician: approvalData.physician,
          contractorRaw: approvalData.contractorRaw,
          contractorNormalized,
          priceListYear,
          contractorOfficer,
          requestedServices: approvalData.requestedServices,
          matchedProcedures: matched,
          status: shouldHoldDraft ? 'pending_manual_draft' : 'draft_created',
          draftBody,
          draftedAt: shouldHoldDraft ? null : serverTimestamp(),
          hasReplies: replyCheck.hasReplies,
          replySnippet: replyCheck.snippet,
          hasExistingApproval: approvalCheck.hasApproval,
          existingApprovalSnippet: approvalCheck.snippet,
          manualDraftRequested: false,
          cmWhatsappMessage: generateCmWhatsappMessage({
            patientName: approvalData.patientName,
            bed: approvalData.bed,
            contractorNormalized,
            contractorRaw: approvalData.contractorRaw,
            requestedServices: approvalData.requestedServices,
            matchedProcedures: matched,
            diagnosis: approvalData.diagnosis,
          } as any),
        };

        // Save locally
        upsertLocalApproval({
          ...record,
          receivedAt: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
          draftedAt: shouldHoldDraft ? null : new Date().toISOString(),
        });

        try {
          await setDoc(docRef, record);
          console.log(`[Approvals Watcher] Saved approval record ${docId} to Firestore.`);
        } catch {
          // Local copy saved
        }
      }

    } finally {
      lock.release();
    }

    if (!client) await imap.logout();
  } catch (err) {
    console.error('[Approvals Watcher] Error during mailbox check:', err);
  }
}

/**
 * Express REST API server for the local React dashboard
 */
export const apiApp = express();
apiApp.use(express.json());

apiApp.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// GET /api/approvals
apiApp.get('/api/approvals', (_req, res) => {
  const records = loadLocalApprovals();
  res.json(records);
});

// POST /api/approvals/:id/draft
apiApp.post('/api/approvals/:id/draft', async (req, res) => {
  const { id } = req.params;
  const approvals = loadLocalApprovals();
  const record = approvals.find((a) => a.id === id);
  if (!record) {
    res.status(404).json({ error: 'Record not found' });
    return;
  }

  try {
    if (IS_EXCHANGE_EWS) {
      await ewsCreateReplyAllDraft({
        itemId: record.lastExchangeItemId || record.exchangeItemId || undefined,
        changeKey: record.exchangeChangeKey || record.lastExchangeChangeKey || undefined,
        body: record.draftBody,
        fallbackSubject: `RE: Inpatient Approval - ${record.patientName} (MRN: ${record.mrn})`,
        fallbackTo: record.contractorRaw || 'corporate@elitehospital.org',
      });
      console.log(`[Approvals Watcher / EWS] In-thread Reply-All draft created in Exchange for MRN: ${record.mrn}`);
    }

    record.status = 'draft_created';
    record.manualDraftRequested = false;
    record.draftedAt = new Date().toISOString();
    upsertLocalApproval(record);

    try {
      await updateDoc(doc(db, 'inpatient_approvals', id), {
        status: 'draft_created',
        manualDraftRequested: false,
        draftedAt: serverTimestamp(),
      });
    } catch {}

    res.json({ success: true, item: record });
  } catch (err: any) {
    console.error('Failed to create draft in Outlook/Exchange:', err);
    res.status(500).json({ error: err.message || 'Draft failed' });
  }
});

// POST /api/approvals/:id/toggle
apiApp.post('/api/approvals/:id/toggle', async (req, res) => {
  const { id } = req.params;
  const approvals = loadLocalApprovals();
  const record = approvals.find((a) => a.id === id);
  if (!record) {
    res.status(404).json({ error: 'Record not found' });
    return;
  }

  const nextStatus = record.status === 'answered' ? 'draft_created' : 'answered';
  record.status = nextStatus;
  record.answeredAt = nextStatus === 'answered' ? new Date().toISOString() : undefined;
  upsertLocalApproval(record);

  try {
    await updateDoc(doc(db, 'inpatient_approvals', id), {
      status: nextStatus,
      answeredAt: nextStatus === 'answered' ? serverTimestamp() : null,
    });
  } catch {}

  res.json({ success: true, item: record });
});

// GET /api/contractors
apiApp.get('/api/contractors', (_req, res) => {
  res.json(loadLocalContractors());
});

// POST /api/contractors
apiApp.post('/api/contractors', async (req, res) => {
  const { name, priceListYear, contractorOfficer, aliases, discount } = req.body;
  if (!name) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  const contractors = loadLocalContractors();
  const existingIdx = contractors.findIndex((c) => c.name.trim() === name.trim());
  const entry: CompanyConfigRecord = {
    id: existingIdx >= 0 ? contractors[existingIdx].id : crypto.randomUUID(),
    name: name.trim(),
    priceListYear: priceListYear || '2025',
    contractorOfficer: contractorOfficer || '',
    aliases: aliases || [],
    discountPercentage: (req.body.discountPercentage ?? discount ?? 0),
    updatedAt: new Date().toISOString() as any,
  };

  if (existingIdx >= 0) {
    contractors[existingIdx] = entry;
  } else {
    contractors.push(entry);
  }
  saveLocalContractors(contractors);

  try {
    await setDoc(doc(db, 'companies_config', entry.id), {
      ...entry,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch {}

  res.json({ success: true, item: entry });
});

// GET /api/settings
apiApp.get('/api/settings', (_req, res) => {
  res.json(loadLocalSettings());
});

// POST /api/settings/pause
apiApp.post('/api/settings/pause', async (req, res) => {
  const settings = loadLocalSettings();
  settings.isPaused = Boolean(req.body.isPaused);
  saveLocalSettings(settings);

  try {
    await setDoc(doc(db, 'settings', 'approvals_automation'), {
      isPaused: settings.isPaused,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch {}

  res.json({ success: true, settings });
});

// POST /api/check-now
apiApp.post('/api/check-now', async (_req, res) => {
  try {
    await runApprovalsCheck();
    res.json({ success: true, message: 'Mailbox check completed' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/approvals/sync (manual sync endpoint)
apiApp.post('/api/approvals/sync', async (_req, res) => {
  try {
    console.log('[Approvals Watcher API] Manual sync triggered via /api/approvals/sync');
    await runApprovalsCheck(undefined, true);
    res.json({ success: true, message: 'Mailbox check completed' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contractors/merge
apiApp.post('/api/contractors/merge', async (req, res) => {
  try {
    const { targetId, targetName, priceListYear, contractorOfficer, discountPercentage, aliases, sourceIds } = req.body;
    if (!targetId || !targetName) {
      res.status(400).json({ error: 'targetId and targetName are required' });
      return;
    }

    const contractors = loadLocalContractors();
    const sourceIdSet = new Set((sourceIds || []) as string[]);

    // Exclude merged source records
    const remaining = contractors.filter((c) => !sourceIdSet.has(c.id));
    const targetIdx = remaining.findIndex((c) => c.id === targetId);

    const updatedTarget: CompanyConfigRecord = {
      id: targetId,
      name: (targetName || '').trim(),
      priceListYear: priceListYear || '2025',
      contractorOfficer: (contractorOfficer || '').trim(),
      discountPercentage: discountPercentage ?? 0,
      aliases: aliases || [],
      updatedAt: new Date().toISOString() as any,
    };

    if (targetIdx >= 0) {
      remaining[targetIdx] = updatedTarget;
    } else {
      remaining.push(updatedTarget);
    }
    saveLocalContractors(remaining);

    // Cascade update to local inpatient approvals
    const approvals = loadLocalApprovals();
    let updatedApprovals = false;
    const oldNames = new Set(
      contractors.filter((c) => sourceIdSet.has(c.id)).map((c) => c.name.trim().toLowerCase())
    );
    const existingTarget = contractors.find((c) => c.id === targetId);
    if (existingTarget) {
      oldNames.add(existingTarget.name.trim().toLowerCase());
    }

    approvals.forEach((app) => {
      const raw = (app.contractorNormalized || app.contractorRaw || '').trim().toLowerCase();
      if (oldNames.has(raw)) {
        app.contractorNormalized = updatedTarget.name;
        app.contractorOfficer = updatedTarget.contractorOfficer;
        app.priceListYear = updatedTarget.priceListYear;
        updatedApprovals = true;
      }
    });

    if (updatedApprovals) {
      saveLocalApprovals(approvals);
    }

    res.json({ success: true, item: updatedTarget });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Continuous polling watcher
 */
export async function startWatcher(): Promise<void> {
  const PORT = Number(process.env.WATCHER_PORT) || 3001;
  apiApp.listen(PORT, () => {
    console.log(`[Approvals Watcher API] REST Server listening on http://localhost:${PORT}`);
  });

  console.log('=====================================================');
  console.log(' Elite Hospital - Outlook Inpatient Approvals Watcher');
  console.log(` Folder: "${IMAP_FOLDER}" | Polling: every ${POLL_INTERVAL_MS / 1000}s`);
  console.log('=====================================================');

  // Listen to remote manual sync triggers from Firestore
  let lastSeenTriggerSync: number | null = null;
  try {
    onSnapshot(doc(db, 'settings', 'approvals_automation'), (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      const trigger = data?.triggerSync;
      if (trigger) {
        const triggerMillis = trigger.toMillis ? trigger.toMillis() : new Date(trigger).getTime();
        if (lastSeenTriggerSync !== null && triggerMillis > lastSeenTriggerSync) {
          console.log('[Approvals Watcher] Remote manual sync triggered from UI via Firestore');
          lastSeenTriggerSync = triggerMillis;
          runApprovalsCheck(undefined, true).catch((err) => console.error('[Watcher] Remote sync error:', err));
        } else if (lastSeenTriggerSync === null) {
          lastSeenTriggerSync = triggerMillis;
        }
      }
    });
  } catch (err) {
    console.warn('[Approvals Watcher] Could not subscribe to Firestore settings:', err);
  }

  await runApprovalsCheck();

  setInterval(async () => {
    try {
      await runApprovalsCheck();
    } catch (err) {
      console.error('[Approvals Watcher] Poller loop error:', err);
    }
  }, POLL_INTERVAL_MS);
}

// Execute directly if run as main script
if (process.argv[1]?.endsWith('approvals-watcher.ts')) {
  startWatcher().catch((err) => {
    console.error('Fatal watcher error:', err);
    process.exit(1);
  });
}
