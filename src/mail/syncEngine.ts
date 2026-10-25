/**
 * Core Mail Synchronization Engine
 * Transport-agnostic coordinator connecting EWS source, parsing, procedure matching,
 * Postgres persistence (authoritative), and retention cleanup.
 */

import fs from 'fs';
import path from 'path';
import { EwsSource } from './adapters/EwsSource';
import { parseHisApprovalEmail } from './parser/hisApprovalParser';
import { loadCursorFromPostgres, saveCursorToPostgres, triggerPhiRetentionPurge } from './storage/cursorManager';
import { uploadAttachmentToStorage } from './attachments/attachmentHandler';
import { persistApprovalToPostgres } from '../services/approvalPostgresService';
import { resolveOfficerByContractor } from '../services/contractorOfficerResolver';
import { cleanContractorName, normalizeArabic, normalizeText } from '../lib/arabic-normalizer';
import { generateCmWhatsappMessage } from '../lib/whatsapp-generator';
import { buildDraftReplyText } from '../lib/draftReplyBuilder';
import { InpatientApprovalRecord } from '../types';
import { MailSyncStats, RawMailMessage } from './types';
import { supabaseAdmin, supabase } from '../lib/supabase';

const client = supabaseAdmin || supabase;

/**
 * Checks if a message has already been persisted to prevent duplicate processing.
 */
async function isMessageAlreadyIngested(messageId: string): Promise<boolean> {
  if (!client) return false;
  try {
    const { data, error } = await client
      .from('inpatient_approvals')
      .select('id')
      .eq('exchange_message_id', messageId)
      .maybeSingle();

    if (error) {
      console.warn(`[Sync Engine] Error checking message existence:`, error.message);
      return false;
    }
    return Boolean(data);
  } catch {
    return false;
  }
}

/**
 * Quick procedure candidate matcher against local yearly cash pricelists.
 */
function matchServicesAgainstPricelist(
  services: Array<{ name: string; rawPrice: number }>,
  year: string = '2025'
): Array<{
  serviceName: string;
  matchedName: string;
  code?: string;
  status: 'matched' | 'unmatched';
  suggestedPrice?: number;
}> {
  const targetYear = ['2023', '2024', '2025', '2026'].includes(year) ? year : '2025';
  let catalog: any[] = [];

  try {
    const filePath = path.resolve(process.cwd(), 'public', `${targetYear}_cash.json`);
    if (fs.existsSync(filePath)) {
      catalog = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (err) {
    console.warn(`[Sync Engine] Failed to load catalog for ${targetYear}:`, err);
  }

  return services.map((srv) => {
    const normSrv = normalizeArabic(normalizeText(srv.name));
    let bestMatch: any = null;
    let maxScore = 0;

    for (const item of catalog) {
      const normAr = normalizeArabic(normalizeText(item.nameArabic || ''));
      const normEn = normalizeText(item.nameEnglish || '').toLowerCase();

      if (normAr && (normSrv.includes(normAr) || normAr.includes(normSrv))) {
        const score = normAr.length / Math.max(normAr.length, normSrv.length);
        if (score > maxScore) {
          maxScore = score;
          bestMatch = item;
        }
      } else if (normEn && normSrv.toLowerCase().includes(normEn)) {
        const score = normEn.length / Math.max(normEn.length, normSrv.length);
        if (score > maxScore) {
          maxScore = score;
          bestMatch = item;
        }
      }
    }

    if (bestMatch && maxScore >= 0.5) {
      return {
        serviceName: srv.name,
        matchedName: bestMatch.nameArabic || bestMatch.nameEnglish,
        code: bestMatch.code,
        status: 'matched' as const,
        suggestedPrice: Number(bestMatch.price) || undefined,
      };
    }

    return {
      serviceName: srv.name,
      matchedName: 'غير مدرج بقائمة الأسعار',
      status: 'unmatched' as const,
    };
  });
}

/**
 * Runs a single sync iteration connecting to EWS and ingesting new approvals.
 */
export async function runMailSync(options?: {
  folderName?: string;
  batchLimit?: number;
  skipPurge?: boolean;
}): Promise<MailSyncStats> {
  const startTime = Date.now();
  const folderName = options?.folderName || process.env.EWS_FOLDER || 'InApprovals';
  const batchLimit = options?.batchLimit || 50;

  const stats: MailSyncStats = {
    success: false,
    messagesFetched: 0,
    messagesProcessed: 0,
    messagesSkipped: 0,
    attachmentsSaved: 0,
    durationMs: 0,
  };

  try {
    const ewsSource = new EwsSource({ folderName });

    // 1. Test Connectivity
    const conn = await ewsSource.testConnection();
    if (!conn.ok) {
      stats.error = conn.message;
      console.error(`[Sync Engine] ❌ EWS Connection failed: ${conn.message}`);
      stats.durationMs = Date.now() - startTime;
      return stats;
    }

    // 2. Load latest sync cursor from PostgreSQL
    const currentCursor = await loadCursorFromPostgres(folderName);
    console.log(`[Sync Engine] 📥 Fetching incremental approvals for "${folderName}" (Token: ${currentCursor.token ? 'Active' : 'Initial'})...`);

    // 3. Fetch new messages from EWS
    const { messages, nextCursor } = await ewsSource.fetchSince(currentCursor, batchLimit);
    stats.messagesFetched = messages.length;
    stats.nextCursorToken = nextCursor.token;

    console.log(`[Sync Engine] 📨 Retrieved ${messages.length} messages from Exchange.`);

    // 4. Process each message
    for (const msg of messages) {
      const alreadyIngested = await isMessageAlreadyIngested(msg.messageId);
      if (alreadyIngested) {
        stats.messagesSkipped++;
        continue;
      }

      // Parse HIS clinical & financial structures
      const parsed = parseHisApprovalEmail(msg);

      // Resolve contractor & officer
      const officerMatch = resolveOfficerByContractor(parsed.contractorRaw);
      const contractorNormalized = officerMatch.contractorNormalized || cleanContractorName(parsed.contractorRaw);
      const contractorOfficer = officerMatch.officerName || 'غير محدد (يتطلب تحديد منسق السيلز)';
      const priceListYear = officerMatch.matched ? '2025' : '2025';

      // Match procedures
      const matchedProcedures = matchServicesAgainstPricelist(parsed.requestedServices, priceListYear);

      // Determine initial status based on parsing results
      let initialStatus: InpatientApprovalRecord['status'] = 'received';
      if (parsed.isRefused) {
        initialStatus = 'refused';
      } else if (parsed.hasExistingApproval) {
        initialStatus = 'answered';
      } else if (matchedProcedures.some((p) => p.status === 'matched')) {
        initialStatus = 'matched';
      } else {
        initialStatus = 'needs_review';
      }

      // Upload and sanitize attachments if present
      const processedAttachments = [];
      if (parsed.attachments && parsed.attachments.length > 0) {
        for (const att of parsed.attachments) {
          // If attachment buffer was fetched, upload to Supabase Storage
          if (att.contentBase64) {
            const buffer = Buffer.from(att.contentBase64, 'base64');
            const uploaded = await uploadAttachmentToStorage(msg.id, att, buffer);
            processedAttachments.push(uploaded);
            stats.attachmentsSaved++;
          } else {
            processedAttachments.push(att);
          }
        }
      }

      // Build standard email draft reply
      const draftBody = buildDraftReplyText(
        priceListYear,
        contractorNormalized,
        contractorOfficer,
        matchedProcedures
      );

      // Build standard Case Manager WhatsApp message
      const cmWhatsappMessage = generateCmWhatsappMessage({
        patientName: parsed.patientName,
        bed: parsed.bed || '',
        contractorNormalized,
        contractorRaw: parsed.contractorRaw,
        requestedServices: parsed.requestedServices,
        matchedProcedures,
        diagnosis: parsed.diagnosis,
        status: initialStatus,
        hasExistingApproval: parsed.hasExistingApproval,
        isRefused: parsed.isRefused,
        approvedAmountLimit: parsed.financialTerms?.approvedAmountLimit,
        patientSharePercentage: parsed.financialTerms?.patientSharePercentage,
        coverageConditions: parsed.financialTerms?.coverageConditions,
      } as any);

      // Build InpatientApprovalRecord
      const record: InpatientApprovalRecord = {
        id: msg.id,
        conversationId: msg.conversationId || msg.messageId,
        messageId: msg.messageId,
        receivedAt: msg.receivedAt,
        patientName: parsed.patientName,
        mrn: parsed.mrn,
        bed: parsed.bed,
        admissionType: parsed.admissionType,
        physician: parsed.physician,
        contractorRaw: parsed.contractorRaw,
        contractorNormalized,
        contractorOfficer,
        priceListYear,
        diagnosis: parsed.diagnosis,
        requestedServices: parsed.requestedServices,
        matchedProcedures,
        status: initialStatus,
        statusReasonArabic: parsed.statusReasonArabic,
        draftBody,
        suggestedDraftReply: draftBody,
        cmWhatsappMessage,
        draftedAt: new Date().toISOString(),
        hasReplies: parsed.hasReplies,
        hasExistingApproval: parsed.hasExistingApproval,
        isRefused: parsed.isRefused,
        approvedAmountLimit: parsed.financialTerms?.approvedAmountLimit,
        patientSharePercentage: parsed.financialTerms?.patientSharePercentage,
        coverageConditions: parsed.financialTerms?.coverageConditions,
      };

      // Persist to Supabase PostgreSQL (Outbox trigger automatically enqueues event for Firestore)
      const persistRes = await persistApprovalToPostgres(record);
      if (persistRes.success) {
        stats.messagesProcessed++;
      } else {
        console.warn(`[Sync Engine] Failed to persist approval ${msg.messageId}:`, persistRes.error);
      }
    }

    // 5. Update cursor watermark in Postgres
    await saveCursorToPostgres(nextCursor, stats.messagesProcessed);

    // 6. Enforce PHI Data Retention (purge raw bodies older than 30 days)
    if (!options?.skipPurge) {
      await triggerPhiRetentionPurge(30);
    }

    stats.success = true;
  } catch (err: any) {
    stats.error = err.message || String(err);
    console.error('[Sync Engine] ❌ Sync run encountered fatal error:', err);
  } finally {
    stats.durationMs = Date.now() - startTime;
  }

  return stats;
}
