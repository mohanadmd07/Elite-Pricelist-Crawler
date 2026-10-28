import {
  classifyApprovalThread,
  GeminiLlmClient,
  type LlmClient,
  type LlmRequest,
  type Ledger,
} from '../src/classifier/index';
import { persistApprovalToPostgres } from '../src/services/approvalPostgresService';
import { mirrorApprovalToFirestore } from '../src/services/approvalFirestoreSync';
import { normalizeApprovalRecord } from '../src/services/approvalsFirebaseService';

function createFallbackRealisticLlm(sampleMsgId: string): LlmClient {
  return {
    async generateJson<T = any>(req: LlmRequest): Promise<T> {
      if (req.pass === 'ledger') {
        const ledger: Ledger = {
          thread_status: 'PARTIAL',
          confidence: 0.95,
          needs_human_review: false,
          items: [
            {
              text_original: 'منظار معدة تشخيصي',
              canonical_en: 'Upper GIT endoscopy',
              category: 'PROCEDURE',
              decision: 'APPROVED',
              quantity_requested: 1,
              quantity_approved: 1,
              conditions: [],
              rejection_reason_ar: null,
              rejection_reason_en: null,
              rejection_type: null,
              evidence_quote: 'تمت الموافقة على منظار المعدة طبقاً للائحة التعاقد المعتمدة',
              evidence_message_id: sampleMsgId,
              validity_until: '30 days',
            },
            {
              text_original: 'أشعة رنين مغناطيسي علي القنوات المرارية',
              canonical_en: 'MRCP',
              category: 'INVESTIGATION',
              decision: 'CONDITIONAL',
              quantity_requested: 1,
              quantity_approved: 1,
              conditions: ['إرفاق تقرير السونار الحديث ووظائف الكبد'],
              rejection_reason_ar: null,
              rejection_reason_en: null,
              rejection_type: null,
              evidence_quote: 'تمت الموافقة على رنين القنوات المرارية شريطة إرفاق تقرير السونار',
              evidence_message_id: sampleMsgId,
              validity_until: '30 days',
            },
            {
              text_original: 'صورة الانتشار للجسم كله بالرنين المغناطيسي R358',
              canonical_en: 'Whole Body Diffusion',
              category: 'INVESTIGATION',
              decision: 'CONDITIONAL',
              quantity_requested: 1,
              quantity_approved: 1,
              conditions: ['مطلوب موافقة سعرية لعدم إدراجه بجدول أسعار التعاقد'],
              rejection_reason_ar: null,
              rejection_reason_en: null,
              rejection_type: null,
              evidence_quote: 'الإجراء غير مدرج بالتعاقد ويتطلب موافقة سعرية خاصة من إدارة التعاقدات',
              evidence_message_id: sampleMsgId,
              validity_until: null,
            },
          ],
          review_reasons: [],
        };
        return ledger as unknown as T;
      }
      if (req.pass === 'verifier') {
        return { verdict: 'OK', corrections: [] } as unknown as T;
      }
      if (req.pass === 'adjudicator') {
        if (req.prompt.includes('Upper GIT') || req.prompt.includes('منظار')) {
          return {
            chosen_index: 0,
            match_class: 'EXACT',
            rationale: 'Exact clinical match with Upper GIT Endoscopy',
          } as unknown as T;
        }
        if (req.prompt.includes('MRCP') || req.prompt.includes('القنوات المرارية')) {
          return {
            chosen_index: 0,
            match_class: 'EXACT',
            rationale: 'Exact clinical match with MRCP',
          } as unknown as T;
        }
        // Line 3: Whole Body Diffusion
        // If checking 2026 list: covered in 2026!
        if (req.prompt.includes('2026') || req.prompt.includes('cash-2026')) {
          return {
            chosen_index: 0,
            match_class: 'EXACT',
            rationale: 'Matched in 2026 hospital master list at gross list price',
          } as unknown as T;
        }
        // In 2025 contract list: NOT covered
        return {
          chosen_index: null,
          match_class: 'DIFFERENT',
          rationale: 'Unlisted procedure in 2025 contractor pricelist',
        } as unknown as T;
      }
      return { text: 'OCR verified' } as unknown as T;
    },
  };
}

async function main() {
  console.log('=== Starting Live Classifier & UI Reflection Test ===');
  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY);
  console.log('Checking environment:');
  console.log('- GEMINI_API_KEY present:', hasGeminiKey);
  console.log('- VITE_SUPABASE_URL present:', Boolean(process.env.VITE_SUPABASE_URL));
  console.log('- SUPABASE_SERVICE_ROLE_KEY present:', Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY));

  const sampleMsgId = `msg_insurer_reply_${Date.now()}`;
  const reqMsgId = `msg_hosp_req_${Date.now()}`;

  const llm: LlmClient = hasGeminiKey ? new GeminiLlmClient() : createFallbackRealisticLlm(sampleMsgId);
  console.log(`- Using LLM Mode: ${hasGeminiKey ? 'Live Gemini API' : 'Medical Test Simulator'}`);

  const sampleThread = {
    approvalId: `app_${Date.now()}`,
    sourceMessageId: sampleMsgId,
    conversationId: `live_test_thread_${Date.now()}`,
    patientName: 'أحمد محمود حسن',
    mrn: '987654',
    insurer: 'اكسا',
    requested: [
      { text: 'منظار معدة تشخيصي', category: 'PROCEDURE' as const, quantity: 1 },
      { text: 'أشعة رنين مغناطيسي علي القنوات المرارية', category: 'INVESTIGATION' as const, quantity: 1 },
      { text: 'صورة الانتشار للجسم كله بالرنين المغناطيسي R358', category: 'INVESTIGATION' as const, quantity: 1 },
    ],
    messages: [
      {
        messageId: reqMsgId,
        sender: 'approvals@elitehospital.org',
        date: new Date(Date.now() - 3600000).toISOString(),
        subject: 'طلب موافقة دخول وفحوصات - أحمد محمود حسن - MRN: 987654',
        body: `السادة شركة أكسا المحترمين،
تحية طيبة وبعد،
نرجو التكرم بالموافقة على الإجراءات التالية للمريض أحمد محمود حسن (ملف رقم 987654):
1. منظار معدة تشخيصي
2. أشعة رنين مغناطيسي علي القنوات المرارية
3. رسوم خدمة إضافي (ممرض زيادة -وزن أكثر من 150كج)
شاكرين حسن تعاونكم.`,
      },
      {
        messageId: sampleMsgId,
        sender: 'medical.approvals@axa-egypt.com',
        date: new Date().toISOString(),
        subject: 'Re: طلب موافقة دخول وفحوصات - أحمد محمود حسن - MRN: 987654',
        body: `السادة مستشفى إيليت،
تحية طيبة وبعد،
إيماءً إلى طلبكم الموضح بعاليه:
- تمت الموافقة على منظار المعدة طبقاً للائحة التعاقد المعتمدة.
- تمت الموافقة على رنين القنوات المرارية شريطة إرفاق تقرير السونار الحديث ووظائف الكبد.
- بالنسبة لرسوم الخدمة الإضافية: الإجراء غير مدرج بالتعاقد ويتطلب موافقة سعرية خاصة من إدارة التعاقدات.

رقم الموافقة: AXA-APP-2026-9921
مع خالص التحية،
إدارة الموافقات الطبية - أكسا`,
      },
    ],
  };

  console.log('\n1. Calling classifyApprovalThread (7-Pass Pipeline)...');
  const start = Date.now();
  const result = await classifyApprovalThread(sampleThread, { llm });
  const elapsed = Date.now() - start;

  console.log(`\nClassification completed in ${elapsed}ms:`);
  console.log('- Overall Status:', result.status);
  console.log('- Approval Reference:', result.approval_reference);
  console.log('- Needs Human Review:', result.needs_human_review);
  console.log('- Review Reasons:', result.review_reasons);
  console.log('- Contract Total:', result.contract_total, 'EGP');
  console.log('- Price Approval Required:', result.price_approval_required);
  console.log('- Price Approval Total:', result.price_approval_total, 'EGP');
  console.log('- Items Ledger Count:', result.items.length);

  result.items.forEach((item, idx) => {
    console.log(`  Item ${idx + 1}: ${item.text_original}`);
    console.log(`    Decision: ${item.decision}`);
    console.log(`    Conditions:`, item.conditions || []);
    console.log(`    Rejection: ${item.rejection_reason_ar || item.rejection_reason_en || 'None'}`);
  });

  console.log('\nTwo-Tier Pricing Ledger:');
  result.priced.forEach((pi, idx) => {
    console.log(`  Line ${idx + 1}: ${pi.item}`);
    console.log(`    Tier / Price Source: ${pi.price_source}`);
    console.log(`    Matched Code: ${pi.matched_code || 'N/A'}`);
    console.log(`    Unit Price: ${pi.unit_price} EGP, Total: ${pi.line_total} EGP`);
  });

  if (result.price_approval_draft_en) {
    console.log('\n--- Corporate Sales English Draft Preview ---');
    console.log(result.price_approval_draft_en);
    console.log('---------------------------------------------');
  }

  // 2. Persist to Supabase & Firestore
  console.log('\n2. Testing database persistence...');
  const testRecordId = `test_approval_${Date.now()}`;
  const testMsgId = `msg_insurer_reply_${Date.now()}`;
  const approvalRecord = {
    id: testRecordId,
    messageId: testMsgId,
    conversationId: sampleThread.conversationId,
    receivedAt: new Date().toISOString(),
    patientName: sampleThread.patientName,
    mrn: sampleThread.mrn,
    diagnosis: 'اشتباه ورم بالقنوات المرارية وآلام حادة',
    admissionType: 'Inpatient',
    bed: 'Room 304',
    physician: 'د. مجدي يعقوب',
    contractorRaw: 'اكسا',
    contractorNormalized: 'أكسا (AXA)',
    priceListYear: '2025',
    contractorOfficer: 'محمد جابر',
    requestedServices: sampleThread.requested.map((i) => ({ name: i.text, rawPrice: 0 })),
    matchedProcedures: result.priced.map((pi) => ({
      serviceName: pi.item,
      matchedName: pi.matched_name_ar || pi.matched_name_en || pi.item,
      code: pi.matched_code || undefined,
      status: (pi.price_source === 'NOT_FOUND' ? 'unmatched' : 'matched') as 'matched' | 'unmatched',
    })),
    status: (result.status === 'APPROVED' ? 'approved' : result.status === 'PARTIAL' ? 'conditionally_approved' : 'needs_review') as any,
    draftBody: 'تم استلام الموافقة وجاري استيفاء التقرير المطلوب وموافقة السعر.',
    draftedAt: new Date().toISOString(),

    // Classifier additive fields
    classifierStatus: result.status,
    itemsJson: result.items,
    requestedItems: sampleThread.requested,
    rejectionReasonAr: result.rejection_reason_ar,
    rejectionReasonEn: result.rejection_reason_en,
    rejectionType: result.rejection_type,
    evidenceQuote: result.evidence_quote,
    confidence: result.confidence,
    needsHumanReview: result.needs_human_review,
    reviewReasons: result.review_reasons,
    classifiedAt: new Date().toISOString(),
    modelVersion: 'gemini-2.5-flash',
    pricedItemsJson: result.priced,
    historyHintsJson: result.history_hints,
    contractTotal: result.contract_total,
    priceApprovalTotal: result.price_approval_total,
    priceApprovalRequired: result.price_approval_required,
    priceApprovalDraftEn: result.price_approval_draft_en,
    priceApprovalStatus: (result.price_approval_required ? 'DRAFT' : null) as any,
    approvalReference: result.approval_reference,
  };

  const pgRes = await persistApprovalToPostgres(approvalRecord as any);
  console.log('- Persisted to Supabase PostgreSQL:', pgRes.success, 'ID:', pgRes.id || pgRes.error);

  const fsRes = await mirrorApprovalToFirestore(approvalRecord as any);
  console.log('- Mirrored to Firestore:', fsRes.success, fsRes.error || '');

  // 3. Test normalization & UI reflection
  console.log('\n3. Testing UI record normalization...');
  const normalized = normalizeApprovalRecord(approvalRecord.id, approvalRecord);
  console.log('- Normalized classifierStatus:', normalized.classifierStatus);
  console.log('- Normalized itemsJson count:', normalized.itemsJson?.length);
  console.log('- Normalized pricedItemsJson count:', normalized.pricedItemsJson?.length);
  console.log('- Normalized contractTotal:', normalized.contractTotal, 'EGP');
  console.log('- Normalized priceApprovalTotal:', normalized.priceApprovalTotal, 'EGP');
  console.log('- Normalized priceApprovalRequired:', normalized.priceApprovalRequired);
  console.log('- Normalized priceApprovalDraftEn length:', normalized.priceApprovalDraftEn?.length || 0);

  console.log('\n=== Live Test Succeeded! ===');
}

main().catch((err) => {
  console.error('Live Test Failed:', err);
  process.exit(1);
});
