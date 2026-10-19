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
  query,
  where,
  writeBatch,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';

import { db } from '../src/firebase';
import { normalizeArabic } from '../src/lib/arabic-normalizer';
import { loadCompanies } from '../src/services/companyService';
import { searchAllProcedures } from '../src/services/procedureService';
import { matchProceduresWithAI, isGeminiConfigured } from '../src/services/aiMatchService';
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

// Local Persistence Paths
const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const APPROVALS_FILE = path.join(DATA_DIR, 'inpatient_approvals.json');
export const CONTRACTORS_FILE = path.join(DATA_DIR, 'contractors.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

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
  const idx = current.findIndex((r) => r.id === record.id || r.messageId === record.messageId);
  if (idx >= 0) {
    current[idx] = { ...current[idx], ...record };
  } else {
    current.unshift(record);
  }
  saveLocalApprovals(current);
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
    const snap = await getDocs(q);

    if (snap.empty) return 0;

    const batch = writeBatch(db);
    snap.docs.forEach((docSnap) => {
      batch.delete(docSnap.ref);
    });
    await batch.commit();
    console.log(`[Approvals Watcher] 30-Day Rollover: Purged ${snap.size} records older than ${days} days.`);
    return snap.size;
  } catch (err) {
    // If Firestore permissions deny unauthenticated batch, local file is already purged
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
 * Extracts structured approval fields from the incoming HIS HTML email body.
 */
export function parseHisApprovalHtml(html: string, subject: string, messageId: string): ParsedApprovalEmail {
  const $ = cheerio.load(html || '');

  // Extract MRN & Patient from Subject if available
  const subjectMatch = subject.match(/(?:RE:\s*)?Inpatient Approval\s*-\s*(.+?)\s*\(MRN:\s*(\d+)\)/i);
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

  // Helper to extract value next to label cell
  $('td, th, span, div, p').each((_, el) => {
    const text = $(el).text().trim();

    if (!patientName && text.includes('Patient Name')) {
      const next = $(el).next().text().trim() || $(el).parent().find('td').eq(1).text().trim();
      if (next) patientName = next;
    }
    if (text.includes('Admission Date')) {
      const next = $(el).next().text().trim() || $(el).parent().find('td').eq(1).text().trim();
      if (next) admissionDate = next;
    }
    if (text.includes('Admission Type')) {
      const parentText = $(el).parent().text();
      admissionType = parentText.includes('Inpatient') ? 'Inpatient' : 'Outpatient';
      const bedMatch = parentText.match(/Bed:\s*([^–\n]+)/i);
      if (bedMatch) bed = bedMatch[1].trim();
    }
    if (text.includes('Physician')) {
      const next = $(el).next().text().trim() || $(el).parent().find('td').eq(1).text().trim();
      if (next) physician = next;
    }
    if (text.includes('Contractor')) {
      const next = $(el).next().text().trim() || $(el).parent().find('td').eq(1).text().trim();
      if (next) contractorRaw = next;
    }
    if (text.includes('Diagnosis')) {
      const next = $(el).next().text().trim() || $(el).parent().find('td').eq(1).text().trim();
      if (next) diagnosis = next;
    }
    if (text.includes('Request Details')) {
      const container = $(el).closest('div, table').find('div, p, span').last().text().trim();
      if (container && container !== text) requestDetails = container;
    }
  });

  // Fallback: search for Contractor in full text if table selector missed
  if (!contractorRaw) {
    const contractorMatch = $('body').text().match(/Contractor[:\s]+([^\n\r]+)/i);
    if (contractorMatch) contractorRaw = contractorMatch[1].trim();
  }

  // Fallback: search for Diagnosis in full text
  if (!diagnosis) {
    const diagMatch = $('body').text().match(/Diagnosis[:\s]+([^\n\r]+)/i);
    if (diagMatch) diagnosis = diagMatch[1].trim();
  }

  // Extract SELECTED SERVICES table rows
  const requestedServices: Array<{ name: string; rawPrice: number }> = [];

  $('tr').each((_, tr) => {
    const rowText = $(tr).text();
    // Exclude header or patient info rows
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


  // If no services parsed via tr, fallback to text regex
  if (requestedServices.length === 0) {
    const lines = $('body').text().split('\n');
    for (const line of lines) {
      const match = line.match(/^([A-Za-z0-9\s()\-–_]+?)\s+(\d+(?:\.\d+)?)\s*(?:EGP)?$/i);
      if (match && !match[1].toLowerCase().includes('total') && !match[1].toLowerCase().includes('service')) {
        requestedServices.push({
          name: match[1].trim(),
          rawPrice: parseFloat(match[2]),
        });
      }
    }
  }

  return {
    messageId,
    subject,
    from: '',
    to: '',
    cc: '',
    patientName: patientName || 'Unknown Patient',
    mrn: mrn || '0000000000',
    admissionDate,
    admissionType,
    bed,
    physician,
    contractorRaw: contractorRaw || 'Unknown Contractor',
    diagnosis,
    requestedServices,
    requestDetails,
  };
}

/**
 * Resolves contractor to active pricelist year and sales officer.
 */
async function resolveContractor(rawName: string): Promise<{
  contractorNormalized: string;
  priceListYear: string;
  contractorOfficer: string;
}> {
  const normRaw = normalizeArabic(rawName);

  // 1. Try reading from locally persisted contractors config first
  const localConfigs = loadLocalContractors();
  const matchedLocal = localConfigs.find(
    (c) =>
      normalizeArabic(c.name) === normRaw ||
      (c.aliases && c.aliases.some((a) => normalizeArabic(a) === normRaw || normRaw.includes(normalizeArabic(a))))
  );
  if (matchedLocal) {
    return {
      contractorNormalized: matchedLocal.name,
      priceListYear: matchedLocal.priceListYear || '2025',
      contractorOfficer: matchedLocal.contractorOfficer || 'محمد ابو الوفا',
    };
  }

  // 2. Try reading from Firestore companies_config collection
  try {
    const colRef = collection(db, 'companies_config');
    const snapshot = await getDocs(colRef);
    for (const docSnap of snapshot.docs) {
      const c = docSnap.data() as CompanyConfigRecord;
      if (
        normalizeArabic(c.name) === normRaw ||
        (c.aliases && c.aliases.some((a) => normalizeArabic(a) === normRaw || normRaw.includes(normalizeArabic(a))))
      ) {
        return {
          contractorNormalized: c.name,
          priceListYear: c.priceListYear || '2025',
          contractorOfficer: c.contractorOfficer || 'محمد ابو الوفا',
        };
      }
    }
  } catch (err) {
    // Silent fallback
  }

  // 2. Fallback to existing companyService.ts
  const localCompanies = await loadCompanies();
  const matched = localCompanies.find((c) => {
    const cNorm = normalizeArabic(c.name);
    return cNorm === normRaw || normRaw.includes(cNorm) || cNorm.includes(normRaw);
  });

  if (matched) {
    return {
      contractorNormalized: matched.name,
      priceListYear: matched.priceListYear || '2025',
      contractorOfficer: matched.responsiblePerson || 'محمد ابو الوفا',
    };
  }

  // Default fallback if brand new
  return {
    contractorNormalized: rawName,
    priceListYear: '2025',
    contractorOfficer: 'غير محدد (يتطلب تحديد منسق السيلز)',
  };
}

/**
 * Matches requested procedures against the contract pricelist.
 */
async function matchRequestedProcedures(
  services: Array<{ name: string; rawPrice: number }>,
  priceListYear: string
): Promise<Array<{ serviceName: string; matchedName: string; code?: string; status: 'matched' | 'unmatched' }>> {
  const results: Array<{ serviceName: string; matchedName: string; code?: string; status: 'matched' | 'unmatched' }> = [];

  for (const srv of services) {
    const localMatches = await searchAllProcedures([{ id: '1', name: srv.name }], priceListYear);


    if (localMatches && localMatches.length > 0) {
      // Pick best exact/first match
      const best = localMatches[0];
      const displayName = best.nameArabic ? `${best.nameArabic} (${best.nameEnglish})` : best.nameEnglish;
      results.push({
        serviceName: srv.name,
        matchedName: displayName,
        status: 'matched',
      });
    } else if (isGeminiConfigured()) {
      // Semantic AI fallback
      try {
        const aiMatches = await matchProceduresWithAI(
          [{ id: '1', name: srv.name }],
          localMatches
        );
        if (aiMatches.length > 0) {
          const aiBest = aiMatches[0];
          const displayName = aiBest.nameArabic ? `${aiBest.nameArabic} (${aiBest.nameEnglish})` : aiBest.nameEnglish;
          results.push({
            serviceName: srv.name,
            matchedName: displayName,
            status: 'matched',
          });
        } else {
          results.push({
            serviceName: srv.name,
            matchedName: srv.name,
            status: 'unmatched',
          });
        }
      } catch {
        results.push({
          serviceName: srv.name,
          matchedName: srv.name,
          status: 'unmatched',
        });
      }
    } else {
      results.push({
        serviceName: srv.name,
        matchedName: srv.name,
        status: 'unmatched',
      });
    }
  }

  return results;
}

const APPROVAL_KEYWORDS = [
  'لا مانع',
  'approved',
  'approve',
  'موافقة سعرية',
  'موافقه سعريه',
  'سعرية',
  'سعريه',
];

/**
 * Checks if the email text or thread contains approval phrases.
 */
export function detectExistingApproval(
  text: string,
  subject: string
): { hasApproval: boolean; snippet: string } {
  const combined = `${subject}\n${text}`;
  const normalized = combined
    .toLowerCase()
    .replace(/[إأآ]/g, 'ا')
    .replace(/ة/g, 'ه');

  for (const kw of APPROVAL_KEYWORDS) {
    const kwNorm = kw
      .toLowerCase()
      .replace(/[إأآ]/g, 'ا')
      .replace(/ة/g, 'ه');

    const idx = normalized.indexOf(kwNorm);
    if (idx !== -1) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(combined.length, idx + kw.length + 60);
      let snippet = combined.substring(start, end).replace(/[\r\n\t]+/g, ' ').trim();
      if (start > 0) snippet = '...' + snippet;
      if (end < combined.length) snippet = snippet + '...';

      return {
        hasApproval: true,
        snippet,
      };
    }
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
  const isReSubject = /^(re|رد|fw|fwd)\s*:/i.test(subject);
  const hasInReplyTo = Boolean(parsed.inReplyTo);
  const hasReferences = Array.isArray(parsed.references)
    ? parsed.references.length > 0
    : Boolean(parsed.references);

  const fullContent = (parsed.text || '') + '\n' + (parsed.html || '');
  const hasQuotedMarkers =
    /-----Original Message-----/i.test(fullContent) ||
    /From:.*Sent:.*To:/is.test(fullContent) ||
    /On\s+.+wrote:/i.test(fullContent) ||
    /بتاريخ\s+.+كتب/i.test(fullContent);

  if (isReSubject || hasInReplyTo || hasReferences || hasQuotedMarkers) {
    let replySnippet = '';
    const lines = (parsed.text || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('>'));

    for (const l of lines) {
      if (
        !l.toLowerCase().includes('inpatient approval') &&
        !l.toLowerCase().includes('patient information') &&
        !l.toLowerCase().includes('from:') &&
        !l.toLowerCase().includes('to:') &&
        !l.toLowerCase().includes('sent:') &&
        l.length > 3
      ) {
        replySnippet = l.substring(0, 120);
        break;
      }
    }

    return {
      hasReplies: true,
      snippet: replySnippet ? `"${replySnippet}"` : 'Thread has prior conversation/replies',
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

  let text = `Price list: Elite Hospital ${priceListYear}
Contractor: ${contractor}
المسئول من قسم السيلز: ${officer}
Corporate Email: corporate@elitehospital.org
 
الإجراءات المتواجدة بلائحة أسعار التعاقد:
${matchedLines || 'لا توجد إجراءات مطابقة مباشرة باللائحة'}`;

  if (unmatchedLines) {
    text += `\n\n[⚠️ تنبيه: لم يتم العثور على الإجراءات التالية في لائحة التعاقد وتتطلب تسعير خاص من مسئول التعاقد:\n${unmatchedLines}]`;
  }

  text += `\n\n(برجاء المتابعة والتأكيد مع إدارة التعاقدات: corporate@elitehospital.org)`;

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

/**
 * Finds recent items in an Exchange folder.
 */
export async function ewsFindItemsInFolder(folderId: string, maxEntries = 50): Promise<Array<{ id: string; subject: string }>> {
  const isDistinguished = ['inbox', 'drafts', 'deleteditems', 'sentitems', 'msgfolderroot'].includes(folderId.toLowerCase());
  const folderXml = isDistinguished
    ? `<t:DistinguishedFolderId Id="${folderId}"/>`
    : `<t:FolderId Id="${folderId}"/>`;

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
      <m:IndexedPageItemView MaxEntriesReturned="${maxEntries}" Offset="0" BasePoint="Beginning"/>
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
    const itemMatches = xml.matchAll(/<t:Message>[\s\S]*?<t:ItemId Id="([^"]+)" ChangeKey="([^"]+)"[\s\S]*?(?:<t:Subject>([^<]*)<\/t:Subject>)?[\s\S]*?<\/t:Message>/g);
    const result: Array<{ id: string; subject: string }> = [];
    for (const match of itemMatches) {
      result.push({
        id: match[1],
        subject: match[3] || '',
      });
    }
    return result;
  } catch (err) {
    console.warn(`[EWS] Error searching items in folder "${folderId}":`, err);
    return [];
  }
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
 * Worker check loop using Exchange Web Services (EWS) over HTTPS 443 with NTLM.
 */
async function runApprovalsCheckEws(): Promise<void> {
  console.log(`[Approvals Watcher / EWS] Polling Exchange Server (${EWS_URL})...`);

  // 1. Enforce 30-day database rollover
  await purgeApprovalsOlderThan(MAX_HISTORY_DAYS);

  // 2. Process any manual draft requests submitted from UI (local storage first)
  const localItems = loadLocalApprovals();
  for (const item of localItems) {
    if (item.manualDraftRequested && item.status !== 'draft_created') {
      try {
        console.log(`[Approvals Watcher / EWS] Executing manual draft request for MRN: ${item.mrn}...`);
        await ewsCreateDraft({
          subject: `Inpatient Approval - ${item.patientName} (MRN: ${item.mrn})`,
          to: item.contractorRaw || 'corporate@elitehospital.org',
          body: item.draftBody,
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
      await ewsCreateDraft({
        subject: `Inpatient Approval - ${item.patientName} (MRN: ${item.mrn})`,
        to: item.contractorRaw || 'corporate@elitehospital.org',
        body: item.draftBody,
      });

      await updateDoc(snap.ref, {
        manualDraftRequested: false,
        status: 'draft_created',
        draftedAt: serverTimestamp(),
      });
    }
  } catch {}

  // 3. Resolve target folder (InApprovals or fallback to Inbox)
  let folderId = await ewsResolveFolderId(IMAP_FOLDER);
  if (!folderId) {
    console.log(`[Approvals Watcher / EWS] Folder "${IMAP_FOLDER}" not found in root, falling back to Inbox.`);
    folderId = 'inbox';
  }

  const items = await ewsFindItemsInFolder(folderId, 50);
  console.log(`[Approvals Watcher / EWS] Scanned ${items.length} items in "${IMAP_FOLDER}".`);

  for (const item of items) {
    const fullItem = await ewsGetItemDetails(item.id);
    if (!fullItem) continue;

    const subject = fullItem.subject || '';
    const messageId = fullItem.messageId || `<${item.id}@exchange>`;

    // Filter: only process Inpatient Approval emails
    if (!subject.toLowerCase().includes('inpatient approval')) {
      continue;
    }

    // Check deduplication
    if (await isAlreadyProcessed(messageId)) {
      continue;
    }

    console.log(`[Approvals Watcher / EWS] Processing new approval: ${subject}`);

    // Parse HTML
    const approvalData = parseHisApprovalHtml(fullItem.bodyHtml || fullItem.bodyText, subject, messageId);
    approvalData.from = fullItem.from;
    approvalData.to = fullItem.to;
    approvalData.cc = fullItem.cc;

    // Check for existing replies and approval keywords
    const emailContent = (fullItem.bodyText || '') + '\n' + (fullItem.bodyHtml || '');
    const approvalCheck = detectExistingApproval(emailContent, subject);
    const replyCheck = detectReplies({
      subject,
      inReplyTo: fullItem.inReplyTo,
      references: fullItem.references,
      text: fullItem.bodyText,
      html: fullItem.bodyHtml,
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

    // Create Draft in Exchange ONLY if no prior replies or approval keywords were detected
    if (!shouldHoldDraft) {
      await ewsCreateDraft({
        subject: `RE: ${subject}`,
        to: approvalData.from || 'corporate@elitehospital.org',
        body: draftBody,
      });
      console.log(`[Approvals Watcher / EWS] Auto-drafted reply in Exchange Drafts for MRN: ${approvalData.mrn}`);
    } else {
      console.log(
        `[Approvals Watcher / EWS] ⚠️ Reply/Approval note detected (${approvalCheck.snippet || replyCheck.snippet}). Skipping auto-draft. Awaiting manual trigger in UI.`
      );
    }

    // Save to Firestore
    const docId = crypto.createHash('md5').update(messageId).digest('hex');
    const docRef = doc(db, 'inpatient_approvals', docId);

    const record: InpatientApprovalRecord = {
      id: docId,
      messageId,
      receivedAt: fullItem.receivedAt ? Timestamp.fromDate(fullItem.receivedAt) : serverTimestamp(),
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
    };

    // Save locally
    upsertLocalApproval({
      ...record,
      receivedAt: fullItem.receivedAt ? fullItem.receivedAt.toISOString() : new Date().toISOString(),
      draftedAt: shouldHoldDraft ? null : new Date().toISOString(),
    });

    try {
      await setDoc(docRef, record);
      console.log(`[Approvals Watcher / EWS] Saved approval record ${docId} to Firestore.`);
    } catch {
      // Local copy saved
    }
  }
}

/**
 * Main worker check loop.
 */
export async function runApprovalsCheck(client?: ImapFlow): Promise<void> {
  // 1. Check if paused
  const paused = await isAutomationPaused();
  if (paused) {
    console.log('[Approvals Watcher] Automation is PAUSED via Dashboard. Skipping check.');
    return;
  }

  if (!IMAP_HOST || !IMAP_USER || !IMAP_PASSWORD) {
    console.log('[Approvals Watcher] IMAP credentials not configured in .env. Running in dry-run mode.');
    return;
  }

  // If server is on-premise Exchange (e.g. wmail.elitehospital.org), use Exchange Web Services (EWS) over HTTPS 443
  if (IS_EXCHANGE_EWS) {
    await runApprovalsCheckEws();
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
      await ewsCreateDraft({
        subject: `RE: Inpatient Approval - ${record.patientName} (MRN: ${record.mrn})`,
        to: record.contractorRaw || 'corporate@elitehospital.org',
        body: record.draftBody,
      });
      console.log(`[Approvals Watcher / EWS] Manual draft created in Exchange for MRN: ${record.mrn}`);
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
