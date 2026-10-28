/**
 * Core Mail Synchronization Engine
 * Transport-agnostic coordinator connecting EWS source, parsing, procedure matching,
 * Postgres persistence (authoritative), and retention cleanup.
 */

import fs from 'fs';
import path from 'path';
import { EwsSource } from './adapters/EwsSource';
import { parseHisApprovalEmail, extractCleanReplyBody, cleanTextFromHtml } from './parser/hisApprovalParser';
import { loadCursorFromPostgres, saveCursorToPostgres, triggerPhiRetentionPurge } from './storage/cursorManager';
import { uploadAttachmentToStorage } from './attachments/attachmentHandler';
import { persistApprovalToPostgres, toDeterministicUuid } from '../services/approvalPostgresService';
import { mirrorApprovalToFirestore } from '../services/approvalFirestoreSync';
import { resolveOfficerByContractor } from '../services/contractorOfficerResolver';
import { cleanContractorName, normalizeArabic, normalizeText, cleanHisProcedureQuery } from '../lib/arabic-normalizer';
import { searchLocalPricelist } from '../services/procedureService';
import { generateCmWhatsappMessage } from '../lib/whatsapp-generator';
import { buildDraftReplyText } from '../lib/draftReplyBuilder';
import { InpatientApprovalRecord, ProcedureResult } from '../types';
import { MailSyncStats, RawMailMessage } from './types';
import { supabaseAdmin, supabase } from '../lib/supabase';
import {
  classifyApprovalThread,
  createDefaultAuditedLlmClient,
  isClassifierEnabled,
  SupabaseLearningStore,
} from '../classifier';

const client = supabaseAdmin || supabase;

async function maybeRunClassifierOnSync(params: {
  approvalId: string;
  sourceMessageId: string;
  insurer: string;
  patientName: string;
  mrn?: string;
  bed?: string;
  physician?: string;
  requestedServices: Array<{ name: string; rawPrice?: number }>;
  msg: RawMailMessage;
  existing?: any;
}): Promise<Record<string, any>> {
  if (!isClassifierEnabled()) return {};
  try {
    const llm = createDefaultAuditedLlmClient();
    const learningStore = client ? new SupabaseLearningStore() : null;
    const result = await classifyApprovalThread(
      {
        approvalId: params.approvalId,
        sourceMessageId: params.sourceMessageId,
        insurer: params.insurer,
        patientName: params.patientName,
        mrn: params.mrn,
        bed: params.bed,
        physician: params.physician,
        requested: (params.requestedServices || []).map((s) => ({
          text: s.name,
          category: 'PROCEDURE' as const,
          quantity: 1,
        })),
        messages: [
          {
            messageId: params.sourceMessageId,
            sender: params.msg.sender || 'insurer@external.org',
            date: params.msg.receivedAt,
            subject: params.msg.subject,
            body: params.msg.textBody || cleanTextFromHtml(params.msg.htmlBody || ''),
            attachments: (params.msg.attachments || []).map((a) => ({
              name: a.name,
              mimeType: a.contentType,
              dataBase64: a.contentBase64,
            })),
          },
        ],
        alreadyClassifiedSourceMessageId: params.existing?.source_message_id || null,
        humanLockedStatus: params.existing?.status_locked_by_human ? params.existing?.classifier_status : null,
      },
      { llm, learningStore }
    );
    return {
      classifier_status: result.status,
      items_json: result.items,
      requested_items: params.requestedServices || [],
      rejection_reason_ar: result.rejection_reason_ar,
      rejection_reason_en: result.rejection_reason_en,
      rejection_type: result.rejection_type,
      evidence_quote: result.evidence_quote,
      confidence: result.confidence,
      needs_human_review: result.needs_human_review,
      review_reasons: result.review_reasons,
      classified_at: result.classified_at,
      source_message_id: result.source_message_id,
      model_version: result.model_version,
      coverage_results_json: result.coverage,
      priced_items_json: result.priced,
      history_hints_json: result.history_hints,
      contractor_pricelist_id: result.contractor_pricelist_id,
      contract_total: result.contract_total,
      price_approval_total: result.price_approval_total,
      price_approval_required: result.price_approval_required,
      price_approval_draft_en: result.price_approval_draft_en,
      price_approval_status: result.price_approval_status,
      approval_reference: result.approval_reference,
    };
  } catch (err: any) {
    console.warn(`[Sync Engine] Classifier warning for ${params.sourceMessageId}:`, err?.message || err);
    return {};
  }
}

/**
 * Checks if an approval record for a conversation already exists in PostgreSQL.
 */
async function getExistingApprovalByConversation(conversationId: string): Promise<any | null> {
  if (!client || !conversationId) return null;
  try {
    const { data, error } = await client
      .from('inpatient_approvals')
      .select('*')
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (error) {
      console.warn(`[Sync Engine] Error checking conversation existence:`, error.message);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

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
 * Robust procedure candidate matcher against local yearly cash pricelists.
 * Employs clean HIS suffix removal, exact catalog lookups, substring matching,
 * token overlap, and clinical safety gates.
 */
export function matchServicesAgainstPricelist(
  services: Array<{ name: string; rawPrice?: number }>,
  year: string = '2025'
): Array<{
  serviceName: string;
  matchedName: string;
  code?: string;
  status: 'matched' | 'unmatched';
  suggestedPrice?: number;
}> {
  const targetYear = ['2023', '2024', '2025', '2026'].includes(year) ? year : '2025';
  let catalog: ProcedureResult[] = [];

  try {
    const filePath = path.resolve(process.cwd(), 'public', `${targetYear}_cash.json`);
    if (fs.existsSync(filePath)) {
      catalog = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (err) {
    console.warn(`[Sync Engine] Failed to load catalog for ${targetYear}:`, err);
  }

  return services.map((srv) => {
    // 1. Try searchLocalPricelist (exact match, cleaned HIS query, substring, clinical safety)
    const localMatches = searchLocalPricelist(catalog, [{ name: srv.name }]);
    if (localMatches.length > 0) {
      const best = localMatches[0];
      return {
        serviceName: srv.name,
        matchedName: best.nameEnglish || best.nameArabic,
        code: best.code,
        status: 'matched' as const,
        suggestedPrice: Number(best.price) || undefined,
      };
    }

    // 2. Fallback candidate scoring with token overlap and bidirectional substring matching
    const cleanSrv = cleanHisProcedureQuery(srv.name);
    const normSrv = normalizeArabic(normalizeText(cleanSrv || srv.name));
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
      } else if (normEn && (normSrv.includes(normEn) || normEn.includes(normSrv))) {
        const score = Math.min(normEn.length, normSrv.length) / Math.max(normEn.length, normSrv.length);
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
      const convId = msg.conversationId || msg.messageId;
      const existing = await getExistingApprovalByConversation(convId);

      // Parse HIS clinical & financial structures
      const parsed = parseHisApprovalEmail(msg);

      if (existing) {
        // This is a reply or follow-up in an existing approval mail thread!
        // We DO NOT insert a new row. We UPDATE the existing entry.

        // CRITICAL REQUIREMENT:
        // "keep the mail timing is the timing of the approval mail itself , not the reply."
        // Base mail timing is ALWAYS the earliest received timestamp in the thread.
        const earliestReceivedAt =
          new Date(msg.receivedAt) < new Date(existing.received_at)
            ? msg.receivedAt
            : existing.received_at;

        // Check for updated reply / approval / refusal status
        let updatedStatus = existing.status;
        let hasApproval = existing.has_existing_approval || parsed.hasExistingApproval;
        let isRefused = existing.is_refused || parsed.isRefused;

        if (parsed.isRefused) {
          updatedStatus = 'refused';
          isRefused = true;
          hasApproval = false;
        } else if (parsed.hasExistingApproval) {
          updatedStatus = 'answered';
          hasApproval = true;
          isRefused = false;
        }

        const updatedApprovedLimit =
          parsed.financialTerms?.approvedAmountLimit && parsed.financialTerms.approvedAmountLimit > 0
            ? parsed.financialTerms.approvedAmountLimit
            : existing.financial_terms?.approvedAmountLimit && existing.financial_terms.approvedAmountLimit > 0
            ? existing.financial_terms.approvedAmountLimit
            : -1;

        const updatedCreditLimitText =
          updatedApprovedLimit > 0
            ? `${updatedApprovedLimit.toLocaleString()} EGP`
            : existing.financial_terms?.creditLimitText || null;

        let updatedReplyText =
          parsed.cleanReplyBody ||
          parsed.statusReasonArabic ||
          (existing.status_reason_arabic && !existing.status_reason_arabic.includes('<div') && !existing.status_reason_arabic.includes('<html>')
            ? existing.status_reason_arabic
            : '') ||
          existing.financial_terms?.coverageConditions ||
          '';

        if (updatedReplyText.includes('<') && updatedReplyText.includes('>')) {
          updatedReplyText = extractCleanReplyBody(updatedReplyText) || cleanTextFromHtml(updatedReplyText);
        }

        const updatedFinancialTerms = {
          patientSharePercentage:
            parsed.financialTerms?.patientSharePercentage ??
            existing.financial_terms?.patientSharePercentage ??
            -1,
          approvedAmountLimit: updatedApprovedLimit,
          creditLimitText: updatedCreditLimitText,
          coverageConditions: updatedReplyText,
        };

        const patientName =
          existing.patient_name && existing.patient_name !== 'غير مسجل'
            ? existing.patient_name
            : parsed.patientName;
        const mrn = existing.mrn && existing.mrn !== '000000' ? existing.mrn : parsed.mrn;
        const bed = existing.bed || parsed.bed;
        const admissionType = existing.admission_type || parsed.admissionType;
        const physician = existing.physician || parsed.physician;
        const contractorRaw = existing.contractor_raw || parsed.contractorRaw;
        const contractorNormalized = existing.contractor_normalized || parsed.contractorNormalized;
        const contractorOfficer = existing.contractor_officer || resolveOfficerByContractor(contractorRaw).officerName;
        const priceListYear = existing.price_list_year || '2025';
        const diagnosis = existing.diagnosis && existing.diagnosis !== 'Clinical Inpatient Evaluation' ? existing.diagnosis : parsed.diagnosis;
        const requestedServices = existing.requested_services?.length > 0 ? existing.requested_services : parsed.requestedServices;
        const matchedProcedures = existing.matched_procedures?.length > 0 ? existing.matched_procedures : matchServicesAgainstPricelist(requestedServices, priceListYear);

        const cmWhatsappMessage = generateCmWhatsappMessage({
          patientName,
          bed: bed || '',
          contractorNormalized,
          contractorRaw,
          requestedServices,
          matchedProcedures,
          diagnosis,
          status: updatedStatus,
          hasExistingApproval: hasApproval,
          isRefused,
          approvedAmountLimit: updatedApprovedLimit > 0 ? updatedApprovedLimit : undefined,
          patientSharePercentage: updatedFinancialTerms.patientSharePercentage > 0 ? updatedFinancialTerms.patientSharePercentage : undefined,
          coverageConditions: updatedReplyText,
        } as any);

        const draftBody = buildDraftReplyText(
          priceListYear,
          contractorNormalized,
          contractorOfficer,
          matchedProcedures
        );

        const latestReplyAt =
          new Date(msg.receivedAt) > new Date(existing.state_timestamps?.latest_reply_at || existing.received_at)
            ? msg.receivedAt
            : existing.state_timestamps?.latest_reply_at;

        const classifierColumns = await maybeRunClassifierOnSync({
          approvalId: existing.id,
          sourceMessageId: msg.messageId,
          insurer: contractorNormalized || contractorRaw,
          patientName,
          mrn,
          bed,
          physician,
          requestedServices,
          msg,
          existing,
        });

        const { error: updateError } = await client
          .from('inpatient_approvals')
          .update({
            received_at: earliestReceivedAt,
            patient_name: patientName,
            mrn,
            bed,
            admission_type: admissionType,
            physician,
            contractor_raw: contractorRaw,
            contractor_normalized: contractorNormalized,
            contractor_officer: contractorOfficer,
            diagnosis,
            requested_services: requestedServices,
            matched_procedures: matchedProcedures,
            status: updatedStatus,
            has_replies: true,
            has_existing_approval: hasApproval,
            is_refused: isRefused,
            financial_terms: updatedFinancialTerms,
            status_reason_arabic: updatedReplyText,
            cm_whatsapp_message: cmWhatsappMessage,
            suggested_draft_reply: draftBody,
            state_timestamps: {
              ...existing.state_timestamps,
              received_at: earliestReceivedAt,
              latest_reply_at: latestReplyAt,
              updated_at: new Date().toISOString(),
            },
            updated_at: new Date().toISOString(),
            ...classifierColumns,
          })
          .eq('id', existing.id);

        if (updateError) {
          console.error(`[Sync Engine] Failed to update approval ${existing.id}:`, updateError.message);
        } else {
          stats.messagesProcessed++;
          // Mirror immediately to Firestore for real-time UI synchronization
          await mirrorApprovalToFirestore({
            id: existing.id,
            conversationId: existing.conversation_id,
            messageId: msg.messageId,
            receivedAt: earliestReceivedAt,
            patientName,
            mrn,
            bed,
            admissionType,
            physician,
            contractorRaw,
            contractorNormalized,
            contractorOfficer,
            priceListYear,
            diagnosis,
            requestedServices,
            matchedProcedures,
            status: updatedStatus,
            hasReplies: true,
            hasExistingApproval: hasApproval,
            isRefused,
            financialTerms: updatedFinancialTerms,
            statusReasonArabic: updatedReplyText,
            cmWhatsappMessage,
            draftBody,
            suggestedDraftReply: draftBody,
            draftedAt: existing.state_timestamps?.drafted_at || new Date().toISOString(),
          } as any);
        }
        continue;
      }

      // If NO existing record exists, this is a new approval mail!
      const alreadyIngested = await isMessageAlreadyIngested(msg.messageId);
      if (alreadyIngested) {
        stats.messagesSkipped++;
        continue;
      }

      // Resolve contractor & officer
      const officerMatch = resolveOfficerByContractor(parsed.contractorRaw);
      const contractorNormalized = officerMatch.contractorNormalized || cleanContractorName(parsed.contractorRaw);
      const contractorOfficer = officerMatch.officerName || 'غير محدد (يتطلب تحديد منسق السيلز)';
      const priceListYear = '2025';

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
        coverageConditions: parsed.financialTerms?.coverageConditions || parsed.cleanReplyBody,
      } as any);

      const deterministicId = toDeterministicUuid(convId);

      // Build InpatientApprovalRecord
      const record: InpatientApprovalRecord = {
        id: deterministicId,
        conversationId: convId,
        messageId: msg.messageId,
        receivedAt: msg.receivedAt, // Timing of the approval mail itself!
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
        statusReasonArabic: parsed.isReplyMessage ? (parsed.statusReasonArabic || parsed.cleanReplyBody) : undefined,
        draftBody,
        suggestedDraftReply: draftBody,
        cmWhatsappMessage,
        draftedAt: new Date().toISOString(),
        hasReplies: parsed.hasReplies,
        hasExistingApproval: parsed.hasExistingApproval,
        isRefused: parsed.isRefused,
        approvedAmountLimit: parsed.financialTerms?.approvedAmountLimit,
        patientSharePercentage: parsed.financialTerms?.patientSharePercentage,
        coverageConditions: parsed.financialTerms?.coverageConditions || parsed.cleanReplyBody,
      };

      // Persist to Supabase PostgreSQL (authoritative)
      const persistRes = await persistApprovalToPostgres(record);
      if (persistRes.success) {
        stats.messagesProcessed++;
        // Mirror directly to Firestore for real-time UI synchronization
        await mirrorApprovalToFirestore(record);
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
