/**
 * Backfill All Approvals Script
 * Classifies all existing inpatient approvals where classifier_status is NULL.
 * Updates Supabase PostgreSQL and replicates to Firebase Firestore.
 *
 * Usage:
 *   npx tsx scripts/backfill-all-approvals.ts
 *   npx tsx scripts/backfill-all-approvals.ts --limit 20
 */

import 'dotenv/config';
import { supabaseAdmin, supabase } from '../src/lib/supabase';
import {
  classifyApprovalThread,
  createDefaultAuditedLlmClient,
  SupabaseLearningStore,
} from '../src/classifier/index';
import { mirrorApprovalToFirestore } from '../src/services/approvalFirestoreSync';
import { cleanTextFromHtml, extractCleanReplyBody } from '../src/mail/parser/hisApprovalParser';

const client = supabaseAdmin || supabase;

async function runBackfill() {
  console.log('=====================================================');
  console.log('🚀 Backfill & Classify All Historical Approvals');
  console.log('=====================================================\n');

  if (!client) {
    console.error('❌ Supabase client is not configured.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 500;

  // 1. Fetch unclassified rows
  const { data: rows, error } = await client
    .from('inpatient_approvals')
    .select('*')
    .is('classifier_status', null)
    .order('received_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('❌ Error querying inpatient_approvals:', error.message);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.log('✅ No unclassified approvals found! All approvals are already classified.');
    return;
  }

  console.log(`📋 Found ${rows.length} approvals with classifier_status = null.`);
  console.log(`⏳ Starting classification pipeline...\n`);

  const llm = createDefaultAuditedLlmClient();
  const learningStore = new SupabaseLearningStore();

  let successCount = 0;
  let failCount = 0;
  const statusStats: Record<string, number> = {};
  let priceApprovalCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const progress = `[${i + 1}/${rows.length}]`;
    const patientName = row.patient_name || 'غير مسجل';
    const insurer = row.contractor_normalized || row.contractor_raw || 'شركة تأمين غير محددة';

    try {
      // 1. Extract requested items
      let requested = (row.requested_services || []).map((s: any) => ({
        text: s.name || s.serviceName || 'إجراء طبي',
        category: 'PROCEDURE' as const,
        quantity: 1,
      }));

      if (requested.length === 0) {
        if (row.diagnosis && row.diagnosis !== 'Clinical Inpatient Evaluation') {
          requested = [{ text: row.diagnosis, category: 'PROCEDURE' as const, quantity: 1 }];
        } else {
          requested = [{ text: 'إقامة ومتابعة طبية بالقسم الداخلي', category: 'PROCEDURE' as const, quantity: 1 }];
        }
      }

      // 2. Derive reply message body
      let replyBody = row.status_reason_arabic || row.financial_terms?.coverageConditions || '';
      if (replyBody.includes('<') && replyBody.includes('>')) {
        replyBody = extractCleanReplyBody(replyBody) || cleanTextFromHtml(replyBody);
      }
      replyBody = replyBody.trim();

      if (!replyBody) {
        if (row.is_refused || row.status === 'refused') {
          replyBody = 'نعتذر عن عدم الموافقة على الطلب لعدم التغطية بالتعاقد.';
        } else if (row.has_existing_approval || row.status === 'answered') {
          replyBody = 'لا مانع من الدخول وتلقي العلاج التحفظي طبقاً للتعاقد المعتمد.';
        } else if (row.status === 'matched') {
          replyBody = 'تم استلام الطلب ومطابقته بلائحة الأسعار وهو قيد الاستيفاء والمراجعة.';
        } else {
          replyBody = 'تم استلام طلب الموافقة وجاري العرض على الطبيب المراجع.';
        }
      }

      const sourceMsgId = row.exchange_message_id || `msg_${row.id}`;
      const reqMsgId = `req_${row.id.slice(0, 8)}`;

      // 3. Reconstruct thread input
      const threadInput = {
        approvalId: row.id,
        sourceMessageId: sourceMsgId,
        conversationId: row.conversation_id,
        patientName,
        mrn: row.mrn || '000000',
        bed: row.bed || undefined,
        physician: row.physician || undefined,
        insurer,
        requested,
        messages: [
          {
            messageId: reqMsgId,
            sender: 'approvals@elitehospital.org',
            date: row.received_at || new Date().toISOString(),
            subject: `طلب موافقة دخول - ${patientName} - MRN: ${row.mrn || ''}`,
            body: `طلب موافقة طبية للمريض ${patientName} (MRN: ${row.mrn || ''}) - التشخيص: ${row.diagnosis || 'علاج تحفظي وفحوصات بالقسم الداخلي'}\nالإجراءات المطلوبة:\n${requested.map((r: any, idx: number) => `${idx + 1}. ${r.text}`).join('\n')}`,
          },
          {
            messageId: sourceMsgId,
            sender: `${insurer}@insurance.org`,
            date: row.state_timestamps?.latest_reply_at || row.received_at || new Date().toISOString(),
            subject: `Re: طلب موافقة دخول - ${patientName} - MRN: ${row.mrn || ''}`,
            body: replyBody,
          },
        ],
        amountCapOverride: row.financial_terms?.approvedAmountLimit > 0 ? row.financial_terms.approvedAmountLimit : null,
        humanLockedStatus: row.status_locked_by_human ? row.classifier_status : null,
      };

      // 4. Run 7-pass classifier
      const result = await classifyApprovalThread(threadInput, { llm, learningStore });

      statusStats[result.status] = (statusStats[result.status] || 0) + 1;
      if (result.price_approval_required) {
        priceApprovalCount++;
      }

      // 5. Build Postgres update payload
      const updatePayload: Record<string, any> = {
        classifier_status: result.status,
        items_json: result.items,
        requested_items: requested,
        rejection_reason_ar: result.rejection_reason_ar,
        rejection_reason_en: result.rejection_reason_en,
        rejection_type: result.rejection_type,
        evidence_quote: result.evidence_quote,
        confidence: result.confidence,
        needs_human_review: result.needs_human_review,
        review_reasons: result.review_reasons,
        classified_at: result.classified_at || new Date().toISOString(),
        source_message_id: result.source_message_id,
        model_version: result.model_version,
        coverage_results_json: result.coverage,
        priced_items_json: result.priced,
        history_hints_json: result.history_hints,
        contractor_pricelist_id: (typeof result.contractor_pricelist_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.contractor_pricelist_id)) ? result.contractor_pricelist_id : null,
        contract_total: result.contract_total,
        price_approval_total: result.price_approval_total,
        price_approval_required: result.price_approval_required,
        price_approval_draft_en: result.price_approval_draft_en,
        price_approval_status: result.price_approval_status,
        approval_reference: result.approval_reference,
        updated_at: new Date().toISOString(),
      };

      // 6. Update Supabase
      const { error: updateErr } = await client
        .from('inpatient_approvals')
        .update(updatePayload)
        .eq('id', row.id);

      if (updateErr) {
        console.error(`${progress} ❌ Supabase update failed for ${row.id}:`, updateErr.message);
        failCount++;
        continue;
      }

      // 7. Mirror to Firestore for real-time UI
      await mirrorApprovalToFirestore({
        ...row,
        classifierStatus: result.status,
        itemsJson: result.items,
        pricedItemsJson: result.priced,
        historyHintsJson: result.history_hints,
        contractTotal: result.contract_total,
        priceApprovalTotal: result.price_approval_total,
        priceApprovalRequired: result.price_approval_required,
        priceApprovalDraftEn: result.price_approval_draft_en,
        priceApprovalStatus: result.price_approval_status,
        needsHumanReview: result.needs_human_review,
        reviewReasons: result.review_reasons,
        approvalReference: result.approval_reference,
      } as any);

      successCount++;
      const priceApprovalBadge = result.price_approval_required ? ` | 🏷️ موافقة سعرية: EGP ${result.price_approval_total.toLocaleString()}` : '';
      console.log(`${progress} ✓ ${patientName} (${insurer}) => ${result.status}${priceApprovalBadge}`);
    } catch (itemErr: any) {
      console.error(`${progress} ❌ Exception classifying ${row.id}:`, itemErr?.message || itemErr);
      failCount++;
    }
  }

  console.log('\n=====================================================');
  console.log('📊 Backfill Classification Summary');
  console.log('=====================================================');
  console.log(`  Total Processed:         ${rows.length}`);
  console.log(`  Successfully Updated:    ${successCount} ✅`);
  console.log(`  Failed:                  ${failCount} ${failCount > 0 ? '❌' : ''}`);
  console.log(`  Requiring Price Approval:${priceApprovalCount} 🏷️`);
  console.log(`  Status Breakdown:        ${JSON.stringify(statusStats, null, 2)}`);
  console.log('=====================================================\n');
}

runBackfill().catch((err) => {
  console.error('Fatal error in backfill:', err);
  process.exit(1);
});
