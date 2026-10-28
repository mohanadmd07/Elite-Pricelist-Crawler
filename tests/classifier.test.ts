import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  addMaskedFewShot,
  applyHumanCorrection,
  applyPriceApprovalOutcome,
  assertInternalRecipient,
  AuditedLlmClient,
  buildPriceApprovalDraft,
  classifyApprovalThread,
  createGoldenPricelistFixtures,
  extractApprovalReference,
  forgetOutcome,
  formatClassificationNotification,
  InMemoryLearningStore,
  LEDGER_JSON_SCHEMA,
  LEDGER_SYSTEM_PROMPT,
  matchItemCoverage,
  matchReplyToRequest,
  normalizeArabicLight,
  normalizeItem,
  priceItems,
  promoteRuleWithGate,
  proposeRulesFromOutcomes,
  recomputeAllStats,
  recordClassificationOutcomes,
  reconstructThread,
  retireRule,
  runGoldenSetEvaluation,
  runTimeSplitLearningEvaluation,
  sendPriceApprovalDraft,
  setApprovedAliasRules,
  type Adjudicator,
  type Ledger,
  type LlmAuditEntry,
  type LlmClient,
  type LlmRequest,
  type PriceRow,
} from '../src/classifier';
import { runBackfillHistory } from '../.agent/skills/approval-reply-classifier/scripts/backfill-history';

function buildMockLlm(opts: {
  ledger: Ledger;
  verifier?: { verdict: 'OK' | 'CORRECTIONS'; corrections: Array<{ item: string; issue: string; fix: string }> };
  adjudication?: { chosen_index: number | null; match_class: any; rationale: string };
  ocrTexts?: Record<string, string>;
  onPrompt?: (req: LlmRequest) => void;
}): LlmClient {
  return {
    async generateJson<T = any>(req: LlmRequest): Promise<T> {
      opts.onPrompt?.(req);
      if (req.pass === 'ledger') return opts.ledger as unknown as T;
      if (req.pass === 'verifier') {
        return (opts.verifier ?? { verdict: 'OK', corrections: [] }) as unknown as T;
      }
      if (req.pass === 'ocr') {
        return { text: opts.ocrTexts?.[req.prompt] ?? 'Approved per attached PDF letter #99881' } as unknown as T;
      }
      return (
        opts.adjudication ?? {
          chosen_index: 0,
          match_class: 'EXACT',
          rationale: 'Exact procedure match',
        }
      ) as unknown as T;
    },
  };
}

describe('Section J.1 — Classification, Arabic Mail Context & Guardrails', () => {
  const fixtures = createGoldenPricelistFixtures();

  beforeEach(() => {
    setApprovedAliasRules([]);
  });

  it('Sync check: SKILL.md contains LEDGER_SYSTEM_PROMPT and LEDGER_JSON_SCHEMA verbatim', () => {
    const skillMd = fs.readFileSync(
      path.resolve(process.cwd(), '.agent/skills/approval-reply-classifier/SKILL.md'),
      'utf8'
    );
    expect(skillMd).toContain(LEDGER_SYSTEM_PROMPT);
    for (const prop of Object.keys(LEDGER_JSON_SCHEMA.properties)) {
      expect(skillMd).toContain(`"${prop}"`);
    }
  });

  it('Plain Arabic approval -> APPROVED when covered on contractor pricelist', async () => {
    const body = 'الطبيب المراجع: لا مانع من اجراء استئصال المرارة بالمنظار للمريض المذكور رقم الموافقة ١٢٣٤٥';
    const llm = buildMockLlm({
      ledger: {
        thread_status: 'APPROVED',
        approval_reference: '12345',
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'استئصال المرارة بالمنظار',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'APPROVED',
            quantity_requested: 1,
            quantity_approved: 1,
            conditions: [],
            info_requested: [],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: 'لا مانع من اجراء استئصال المرارة بالمنظار',
            evidence_message_id: 'm1',
          },
        ],
        confidence: 0.96,
        needs_human_review: false,
      },
    });

    const res = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-plain-ar-approve',
        insurer: 'Next Care',
        patientName: 'Ahmed Mohamed',
        requested: [{ text: 'استئصال المرارة بالمنظار', category: 'PROCEDURE', quantity: 1 }],
        messages: [{ messageId: 'm1', sender: 'medical@nextcare.com', date: '2026-03-01T10:00:00Z', body }],
        dryRun: true,
      },
      { llm, ...fixtures }
    );

    expect(res.status).toBe('APPROVED');
    expect(res.approval_reference).toBe('12345');
    expect(res.needs_human_review).toBe(false);
    expect(res.priced[0].price_source).toBe('CONTRACT');
    // 2025 price = 18000, Next Care 20% discount -> 14400
    expect(res.priced[0].unit_price).toBe(14400);
    expect(res.price_approval_draft_en).toBeNull();
  });

  it('Plain Arabic rejection with reason -> REJECTED with verbatim Arabic + English translation + rejection_type', async () => {
    const body = 'نعتذر عن عدم الموافقة على استئصال المرارة بالمنظار حيث أن الحالة غير مغطاة بالوثيقة (استثناء تعاقدي).';
    const llm = buildMockLlm({
      ledger: {
        thread_status: 'REJECTED',
        approval_reference: null,
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'استئصال المرارة بالمنظار',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'REJECTED',
            quantity_requested: 1,
            quantity_approved: 0,
            conditions: [],
            info_requested: [],
            rejection_type: 'COVERAGE_EXCLUSION',
            rejection_reason_ar: 'الحالة غير مغطاة بالوثيقة (استثناء تعاقدي)',
            rejection_reason_en: 'Condition is excluded under the policy (contractual exclusion)',
            amount_cap: null,
            evidence_quote: 'نعتذر عن عدم الموافقة على استئصال المرارة بالمنظار حيث أن الحالة غير مغطاة بالوثيقة',
            evidence_message_id: 'm1',
          },
        ],
        confidence: 0.95,
        needs_human_review: false,
      },
    });

    const res = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-plain-ar-reject',
        insurer: 'Next Care',
        patientName: 'Ahmed Mohamed',
        requested: [{ text: 'استئصال المرارة بالمنظار', category: 'PROCEDURE', quantity: 1 }],
        messages: [{ messageId: 'm1', sender: 'medical@nextcare.com', date: '2026-03-01T10:00:00Z', body }],
        dryRun: true,
      },
      { llm, ...fixtures }
    );

    expect(res.status).toBe('REJECTED');
    expect(res.rejection_type).toBe('COVERAGE_EXCLUSION');
    expect(res.rejection_reason_ar).toContain('غير مغطاة');
    expect(res.rejection_reason_en).toContain('excluded');
    expect(res.price_approval_draft_en).toBeNull();
  });

  it('Arabic request for medical report -> PARTIAL (INFO_REQUESTED) with requested document listed', async () => {
    const body = 'برجاء ارسال تقرير طبي مفصل ونتيجة السونار للعرض على الادارة الطبية';
    const llm = buildMockLlm({
      ledger: {
        thread_status: 'PARTIAL',
        approval_reference: null,
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'استئصال المرارة بالمنظار',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'INFO_REQUESTED',
            quantity_requested: 1,
            quantity_approved: null,
            conditions: [],
            info_requested: ['تقرير طبي مفصل', 'نتيجة السونار'],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: 'برجاء ارسال تقرير طبي مفصل ونتيجة السونار',
            evidence_message_id: 'm1',
          },
        ],
        confidence: 0.93,
        needs_human_review: false,
      },
    });

    const res = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-needs-info',
        insurer: 'Next Care',
        patientName: 'Ahmed Mohamed',
        requested: [{ text: 'استئصال المرارة بالمنظار', category: 'PROCEDURE' }],
        messages: [{ messageId: 'm1', sender: 'medical@nextcare.com', date: '2026-03-01T10:00:00Z', body }],
        dryRun: true,
      },
      { llm, ...fixtures }
    );

    expect(res.status).toBe('PARTIAL');
    expect(res.requested_questions.map((q) => q.question).join(' ')).toContain('تقرير طبي مفصل');
  });

  it('Reply containing only quoted history and no new insurer decision -> PENDING/UNCLEAR, never APPROVED', async () => {
    const body = [
      '-----Original Message-----',
      'From: approvals@elitehospital.org',
      'Please approve Laparoscopic cholecystectomy for the patient.',
      '> تمت الموافقة سابقا',
    ].join('\n');

    // Even if a buggy model tried to say APPROVED from quoted history, validateLedger blocks it!
    const llm = buildMockLlm({
      ledger: {
        thread_status: 'APPROVED',
        approval_reference: null,
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'Laparoscopic cholecystectomy',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'APPROVED',
            quantity_requested: 1,
            quantity_approved: 1,
            conditions: [],
            info_requested: [],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: 'تمت الموافقة سابقا',
            evidence_message_id: 'm1',
          },
        ],
        confidence: 0.9,
        needs_human_review: false,
      },
    });

    const res = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-quoted-only',
        insurer: 'Next Care',
        patientName: 'Ahmed Mohamed',
        requested: [{ text: 'Laparoscopic cholecystectomy', category: 'PROCEDURE' }],
        messages: [{ messageId: 'm1', sender: 'medical@nextcare.com', date: '2026-03-01T10:00:00Z', body }],
        dryRun: true,
      },
      { llm, ...fixtures }
    );

    expect(res.status).not.toBe('APPROVED');
    expect(['PENDING', 'UNCLEAR']).toContain(res.status);
    expect(res.needs_human_review).toBe(true);
  });

  it('Rejection followed by approval after appeal -> APPROVED (latest message wins for the same item)', async () => {
    const m1 = {
      messageId: 'm1',
      sender: 'medical@nextcare.com',
      date: '2026-03-01T10:00:00Z',
      body: 'غير موافق على استئصال المرارة بالمنظار لعدم ارفاق السونار',
    };
    const m2 = {
      messageId: 'm2',
      sender: 'medical@nextcare.com',
      date: '2026-03-01T12:00:00Z',
      body: 'بعد الاطلاع على التقرير المرفق تمت الموافقة على استئصال المرارة بالمنظار رقم الموافقة 554433',
    };

    const llm = buildMockLlm({
      ledger: {
        thread_status: 'APPROVED',
        approval_reference: '554433',
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'استئصال المرارة بالمنظار',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'REJECTED',
            quantity_requested: 1,
            quantity_approved: 0,
            conditions: [],
            info_requested: [],
            rejection_type: 'OTHER',
            rejection_reason_ar: 'لعدم ارفاق السونار',
            rejection_reason_en: 'Missing ultrasound',
            amount_cap: null,
            evidence_quote: 'غير موافق على استئصال المرارة بالمنظار لعدم ارفاق السونار',
            evidence_message_id: 'm1',
          },
          {
            category: 'PROCEDURE',
            text_original: 'استئصال المرارة بالمنظار',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'APPROVED',
            quantity_requested: 1,
            quantity_approved: 1,
            conditions: [],
            info_requested: [],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: 'تمت الموافقة على استئصال المرارة بالمنظار رقم الموافقة 554433',
            evidence_message_id: 'm2',
          },
        ],
        confidence: 0.95,
        needs_human_review: false,
      },
    });

    const res = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-appeal',
        insurer: 'Next Care',
        patientName: 'Ahmed Mohamed',
        requested: [{ text: 'استئصال المرارة بالمنظار', category: 'PROCEDURE' }],
        messages: [m1, m2],
        dryRun: true,
      },
      { llm, ...fixtures }
    );

    expect(res.status).toBe('APPROVED');
    expect(res.items).toHaveLength(1);
    expect(res.items[0].decision).toBe('APPROVED');
  });

  it('Conditional approval ("لا مانع بشرط...") -> PARTIAL with condition listed', async () => {
    const body = 'لا مانع من اجراء استئصال المرارة بالمنظار بشرط ارسال تقرير الباثولوجي بعد العملية';
    const llm = buildMockLlm({
      ledger: {
        thread_status: 'PARTIAL',
        approval_reference: null,
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'استئصال المرارة بالمنظار',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'CONDITIONAL',
            quantity_requested: 1,
            quantity_approved: 1,
            conditions: ['ارسال تقرير الباثولوجي بعد العملية'],
            info_requested: [],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: 'لا مانع من اجراء استئصال المرارة بالمنظار بشرط ارسال تقرير الباثولوجي',
            evidence_message_id: 'm1',
          },
        ],
        confidence: 0.95,
        needs_human_review: false,
      },
    });

    const res = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-conditional',
        insurer: 'Next Care',
        patientName: 'Ahmed Mohamed',
        requested: [{ text: 'استئصال المرارة بالمنظار', category: 'PROCEDURE' }],
        messages: [{ messageId: 'm1', sender: 'medical@nextcare.com', date: '2026-03-01T10:00:00Z', body }],
        dryRun: true,
      },
      { llm, ...fixtures }
    );

    expect(res.status).toBe('PARTIAL');
    expect(res.requested_questions.map((q) => q.question).join(' ')).toContain('تقرير الباثولوجي');
  });

  it('Mixed Arabic/English thread with Arabic-Indic digits in reference number + Franco/abbreviations resolved', () => {
    const raw = 'موافقة رقم ٩٨٧٦٥٤ على اجراء lap chole و اشعة CT بالصبغة';
    expect(normalizeArabicLight(raw)).toContain('987654');
    expect(extractApprovalReference(raw)).toBe('987654');

    const lc = normalizeItem('lap chole');
    expect(lc.canonical_en).toBe('Laparoscopic cholecystectomy');

    const ct = normalizeItem('اشعة CT بالصبغة');
    expect(ct.canonical_en).toBe('CT scan with contrast');
    expect(ct.attributes.contrast).toBe('with');
  });

  it('Inline reply between quoted lines is preserved and attributed to the right item', () => {
    const body = [
      '> 1. Laparoscopic cholecystectomy',
      'تمت الموافقة على استئصال المرارة بالمنظار',
      '> 2. ICU day (2 days)',
      'يرجى ارسال مبرر دخول العناية المركزة',
    ].join('\n');

    const [reconstructed] = reconstructThread([
      { messageId: 'm1', sender: 'medical@nextcare.com', date: '2026-03-01T10:00:00Z', body },
    ]);

    expect(reconstructed.newContent).toContain('[QUOTED] 1. Laparoscopic cholecystectomy');
    expect(reconstructed.newContent).toContain('[REPLY] تمت الموافقة علي استئصال المرارة بالمنظار');
    expect(reconstructed.newContent).toContain('[QUOTED] 2. ICU day (2 days)');
    expect(reconstructed.newContent).toContain('[REPLY] يرجي ارسال مبرر دخول العناية المركزة');
  });

  it('Scope separation: Admission approved, procedure not mentioned -> PARTIAL with procedure marked NOT_ADDRESSED', async () => {
    const body = 'تمت الموافقة على دخول المستشفى والاقامة بالقسم الداخلي لمدة يومين';
    const llm = buildMockLlm({
      ledger: {
        thread_status: 'APPROVED',
        approval_reference: '771122',
        items: [
          {
            category: 'ADMISSION',
            text_original: 'الاقامة بالقسم الداخلي',
            canonical_en: 'Inpatient admission',
            decision: 'APPROVED',
            quantity_requested: 2,
            quantity_approved: 2,
            conditions: [],
            info_requested: [],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: 'تمت الموافقة على دخول المستشفى والاقامة بالقسم الداخلي لمدة يومين',
            evidence_message_id: 'm1',
          },
        ],
        confidence: 0.94,
        needs_human_review: false,
      },
    });

    const res = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-scope-sep',
        insurer: 'Next Care',
        patientName: 'Ahmed Mohamed',
        requested: [
          { text: 'Inpatient admission', category: 'ADMISSION', quantity: 2 },
          { text: 'Laparoscopic cholecystectomy', category: 'PROCEDURE', quantity: 1 },
        ],
        messages: [{ messageId: 'm1', sender: 'medical@nextcare.com', date: '2026-03-01T10:00:00Z', body }],
        dryRun: true,
      },
      { llm, ...fixtures }
    );

    expect(res.status).toBe('PARTIAL');
    const procItem = res.items.find((i) => i.category === 'PROCEDURE');
    expect(procItem?.decision).toBe('NOT_ADDRESSED');
    expect(res.not_addressed.length).toBeGreaterThan(0);
  });

  it('Partial quantity (3 of 5 ICU days) -> PARTIAL with exact numbers', async () => {
    const body = 'تمت الموافقة على 3 ايام فقط عناية مركزة من اصل 5 ايام مطلوبة';
    const llm = buildMockLlm({
      ledger: {
        thread_status: 'PARTIAL',
        approval_reference: '880011',
        items: [
          {
            category: 'ICU_DAYS',
            text_original: 'يوم عناية مركزة',
            canonical_en: 'ICU day',
            decision: 'APPROVED',
            quantity_requested: 5,
            quantity_approved: 3,
            conditions: [],
            info_requested: [],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: 'تمت الموافقة على 3 ايام فقط عناية مركزة من اصل 5 ايام مطلوبة',
            evidence_message_id: 'm1',
          },
        ],
        confidence: 0.95,
        needs_human_review: false,
      },
    });

    const res = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-partial-qty',
        insurer: 'Next Care',
        patientName: 'Ahmed Mohamed',
        requested: [{ text: 'ICU day', category: 'ICU_DAYS', quantity: 5 }],
        messages: [{ messageId: 'm1', sender: 'medical@nextcare.com', date: '2026-03-01T10:00:00Z', body }],
        dryRun: true,
      },
      { llm, ...fixtures }
    );

    expect(res.status).toBe('PARTIAL');
    expect(res.items[0].quantity_requested).toBe(5);
    expect(res.items[0].quantity_approved).toBe(3);
    // Priced for the 3 approved days (5000 * 0.8 = 4000 unit, 12000 total)
    expect(res.priced[0].qty).toBe(3);
    expect(res.priced[0].line_total).toBe(12000);
  });

  it('Out-of-office / auto-reply is ignored and never produces an approval', async () => {
    const body = 'I am currently out of the office with limited access to email. Automatic reply.';
    const llm = buildMockLlm({
      ledger: {
        thread_status: 'PENDING',
        approval_reference: null,
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'Laparoscopic cholecystectomy',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'PENDING',
            quantity_requested: 1,
            quantity_approved: null,
            conditions: [],
            info_requested: [],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: '',
            evidence_message_id: 'm1',
          },
        ],
        confidence: 0.9,
        needs_human_review: false,
      },
    });

    const res = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-ooo',
        insurer: 'Next Care',
        patientName: 'Ahmed Mohamed',
        requested: [{ text: 'Laparoscopic cholecystectomy', category: 'PROCEDURE' }],
        messages: [
          {
            messageId: 'm1',
            sender: 'medical@nextcare.com',
            date: '2026-03-01T10:00:00Z',
            subject: 'Automatic reply: Out of office',
            body,
          },
        ],
        dryRun: true,
      },
      { llm, ...fixtures }
    );

    expect(res.status).toBe('PENDING');
  });

  it('Conflict between email body and attached letter -> UNCLEAR with both quotes and needs_human_review = true', async () => {
    const llm = buildMockLlm({
      ocrTexts: {},
      ledger: {
        thread_status: 'UNCLEAR',
        approval_reference: null,
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'استئصال المرارة بالمنظار',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'REJECTED',
            quantity_requested: 1,
            quantity_approved: 0,
            conditions: [],
            info_requested: [],
            rejection_type: 'MEDICAL_NECESSITY',
            rejection_reason_ar: 'نعتذر عن عدم الموافقة',
            rejection_reason_en: 'Rejected in email body',
            amount_cap: null,
            evidence_quote: 'نعتذر عن عدم الموافقة على العملية',
            evidence_message_id: 'm1',
          },
          {
            category: 'PROCEDURE',
            text_original: 'استئصال المرارة بالمنظار',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'APPROVED',
            quantity_requested: 1,
            quantity_approved: 1,
            conditions: [],
            info_requested: [],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: 'تمت الموافقة في الخطاب المرفق على استئصال المرارة بالمنظار',
            evidence_message_id: 'm1',
          },
        ],
        confidence: 0.65,
        needs_human_review: true,
      },
    });

    const res = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-body-vs-att-conflict',
        insurer: 'Next Care',
        patientName: 'Ahmed Mohamed',
        requested: [{ text: 'استئصال المرارة بالمنظار', category: 'PROCEDURE' }],
        messages: [
          {
            messageId: 'm1',
            sender: 'medical@nextcare.com',
            date: '2026-03-01T10:00:00Z',
            body: 'نعتذر عن عدم الموافقة على العملية\nتمت الموافقة في الخطاب المرفق على استئصال المرارة بالمنظار',
          },
        ],
        dryRun: true,
      },
      { llm, ...fixtures }
    );

    expect(res.status).toBe('UNCLEAR');
    expect(res.needs_human_review).toBe(true);
    expect(res.conflicts.length).toBeGreaterThan(0);
    expect(res.conflicts[0].quotes).toHaveLength(2);
  });

  it('Pass 3 Verifier catches a deliberately injected negation error ("غير موافق" mislabeled as APPROVED)', async () => {
    const body = 'غير موافق على اجراء استئصال المرارة بالمنظار لعدم وجود داعي طبي';
    const llm = buildMockLlm({
      ledger: {
        thread_status: 'APPROVED',
        approval_reference: null,
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'استئصال المرارة بالمنظار',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'APPROVED',
            quantity_requested: 1,
            quantity_approved: 1,
            conditions: [],
            info_requested: [],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: 'غير موافق على اجراء استئصال المرارة بالمنظار',
            evidence_message_id: 'm1',
          },
        ],
        confidence: 0.92,
        needs_human_review: false,
      },
    });

    const res = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-verifier-negation',
        insurer: 'Next Care',
        patientName: 'Ahmed Mohamed',
        requested: [{ text: 'استئصال المرارة بالمنظار', category: 'PROCEDURE' }],
        messages: [{ messageId: 'm1', sender: 'medical@nextcare.com', date: '2026-03-01T10:00:00Z', body }],
        dryRun: true,
      },
      { llm, ...fixtures }
    );

    expect(res.verification?.verdict).toBe('CORRECTIONS');
    expect(res.needs_human_review).toBe(true);
  });

  it('Reply matching priority: approval reference -> patient+admission date -> thread ID, never by subject alone', () => {
    const requests = [
      {
        id: 'req-1',
        approvalReference: '551100',
        patientName: 'محمد احمد علي',
        admissionDate: '2026-03-10',
        conversationId: 'conv-1',
      },
      {
        id: 'req-2',
        approvalReference: '998877',
        patientName: 'سارة محمود حسن',
        admissionDate: '2026-03-12',
        conversationId: 'conv-2',
      },
    ];

    // 1. Match by approval reference
    const byRef = matchReplyToRequest(
      { subject: 'RE: Approval Request', text: 'تمت الموافقة رقم الموافقة: 998877' },
      requests
    );
    expect(byRef.requestId).toBe('req-2');
    expect(byRef.by).toBe('REFERENCE');

    // 2. Match by patient name + admission date
    const byPatient = matchReplyToRequest(
      { subject: 'RE: Something Else', text: 'المريض محمد احمد علي تاريخ الدخول 2026-03-10' },
      requests
    );
    expect(byPatient.requestId).toBe('req-1');
    expect(byPatient.by).toBe('PATIENT_DATE');

    // 3. Match by thread/conversation ID
    const byThread = matchReplyToRequest(
      { subject: 'RE: Unrelated', text: 'تمت الموافقة', conversationId: 'conv-2' },
      requests
    );
    expect(byThread.requestId).toBe('req-2');
    expect(byThread.by).toBe('THREAD');

    // 4. Subject alone NEVER matches
    const subjectOnly = matchReplyToRequest(
      { subject: 'RE: Approval Request', text: 'تمت الموافقة' },
      requests
    );
    expect(subjectOnly.requestId).toBeNull();
    expect(subjectOnly.by).toBeNull();
  });
});

describe('Section J.2 — Medical Coverage Matching & Two-Tier Pricing', () => {
  const fixtures = createGoldenPricelistFixtures();

  it('Laparoscopic vs open procedure -> DIFFERENT, never matched as covered', async () => {
    const openOnlyRows: PriceRow[] = [
      {
        code: 'P.102',
        nameEn: 'Appendectomy (open)',
        nameAr: 'استئصال الزائدة الدودية جراحيا',
        price: 12000,
        section: 'Procedures',
        year: 2025,
        pricelistId: 'cash-2025',
        pricelistVersion: '2025#v1',
      },
    ];
    // Even if adjudicator mistakenly says EXACT, code clinical conflict guard forces DIFFERENT!
    const permissiveAdjudicator: Adjudicator = {
      async adjudicate() {
        return { chosen_index: 0, match_class: 'EXACT', rationale: 'appendectomy' };
      },
    };
    const cov = await matchItemCoverage(
      { text_original: 'Laparoscopic appendectomy', canonical_en: 'Laparoscopic appendectomy' },
      0,
      openOnlyRows,
      { adjudicator: permissiveAdjudicator }
    );
    expect(cov.matchClass).toBe('DIFFERENT');
    expect(cov.result).toBe('NOT_COVERED');
  });

  it('CT with contrast vs CT without contrast -> DIFFERENT', async () => {
    const nonContrastOnly: PriceRow[] = [
      {
        code: 'R.202',
        nameEn: 'CT scan without contrast',
        nameAr: 'اشعة مقطعية بدون صبغة',
        price: 2200,
        section: 'Radiology',
        year: 2025,
        pricelistId: 'cash-2025',
        pricelistVersion: '2025#v1',
      },
    ];
    const permissiveAdjudicator: Adjudicator = {
      async adjudicate() {
        return { chosen_index: 0, match_class: 'EXACT', rationale: 'CT' };
      },
    };
    const cov = await matchItemCoverage(
      { text_original: 'اشعة مقطعية بالصبغة', canonical_en: 'CT scan with contrast' },
      0,
      nonContrastOnly,
      { adjudicator: permissiveAdjudicator }
    );
    expect(cov.matchClass).toBe('DIFFERENT');
    expect(cov.result).toBe('NOT_COVERED');
  });

  it('Bundled item (anesthesia, nursing) inside a package is NOT flagged or priced separately; outside a package IS flagged', async () => {
    const rows2025 = (await fixtures.pricelistProvider.loadRows(2025)).map((r) =>
      r.code === 'P.101' ? { ...r, isPackage: true, packageId: 'pkg-lap-chole' } : r
    );
    const rows2026 = await fixtures.pricelistProvider.loadRows(2026);
    const contract = await fixtures.contractResolver.resolve('Next Care');

    // Inside a package (with Laparoscopic cholecystectomy marked isPackage):
    const insidePkg = await priceItems({
      items: [
        {
          category: 'PROCEDURE',
          text_original: 'Laparoscopic cholecystectomy',
          canonical_en: 'Laparoscopic cholecystectomy',
          decision: 'APPROVED',
          quantity_requested: 1,
          quantity_approved: 1,
          conditions: [],
          info_requested: [],
          rejection_type: null,
          rejection_reason_ar: null,
          rejection_reason_en: null,
          amount_cap: null,
          evidence_quote: 'Approved',
          evidence_message_id: 'm1',
        },
        {
          category: 'OTHER',
          text_original: 'General anesthesia and routine nursing',
          canonical_en: null,
          decision: 'APPROVED',
          quantity_requested: 1,
          quantity_approved: 1,
          conditions: [],
          info_requested: [],
          rejection_type: null,
          rejection_reason_ar: null,
          rejection_reason_en: null,
          amount_cap: null,
          evidence_quote: 'Approved',
          evidence_message_id: 'm1',
        },
      ],
      contract,
      contractRows: rows2025,
      list2026Rows: rows2026,
      deps: { adjudicator: fixtures.adjudicator },
    });

    expect(insidePkg.priced[1].price_source).toBe('INCLUDED_IN_PACKAGE');
    expect(insidePkg.priced[1].unit_price).toBeNull();
    expect(insidePkg.priced[1].line_total).toBeNull();
    expect(insidePkg.flags).toHaveLength(0);

    // Outside a package (standalone anesthesia with no package procedure):
    const outsidePkg = await priceItems({
      items: [
        {
          category: 'OTHER',
          text_original: 'General anesthesia fee standalone',
          canonical_en: null,
          decision: 'APPROVED',
          quantity_requested: 1,
          quantity_approved: 1,
          conditions: [],
          info_requested: [],
          rejection_type: null,
          rejection_reason_ar: null,
          rejection_reason_en: null,
          amount_cap: null,
          evidence_quote: 'Approved',
          evidence_message_id: 'm1',
        },
      ],
      contract,
      contractRows: rows2025,
      list2026Rows: rows2026,
      deps: { adjudicator: fixtures.adjudicator },
    });

    expect(outsidePkg.flags.some((f) => f.startsWith('ANCILLARY_OUTSIDE_PACKAGE'))).toBe(true);
  });

  it('Tier 1 vs Tier 2 vs NOT_FOUND vs NEEDS_REVIEW (0.75 fuzzy) + quantity + mixed approval + Corporate Sales draft', async () => {
    const rows2025 = await fixtures.pricelistProvider.loadRows(2025);
    const rows2026 = await fixtures.pricelistProvider.loadRows(2026);
    const contract = await fixtures.contractResolver.resolve('Next Care'); // 2025, 20% discount

    // 1. Item in contractor list + 1 item only in 2026 list (Cataract surgery P.999 = 21,000 EGP gross)
    const mixed = await priceItems({
      items: [
        {
          category: 'PROCEDURE',
          text_original: 'Laparoscopic cholecystectomy',
          canonical_en: 'Laparoscopic cholecystectomy',
          decision: 'APPROVED',
          quantity_requested: 1,
          quantity_approved: 1,
          conditions: [],
          info_requested: [],
          rejection_type: null,
          rejection_reason_ar: null,
          rejection_reason_en: null,
          amount_cap: null,
          evidence_quote: 'Approved',
          evidence_message_id: 'm1',
        },
        {
          category: 'ICU_DAYS',
          text_original: 'ICU day',
          canonical_en: 'ICU day',
          decision: 'APPROVED',
          quantity_requested: 3,
          quantity_approved: 3,
          conditions: [],
          info_requested: [],
          rejection_type: null,
          rejection_reason_ar: null,
          rejection_reason_en: null,
          amount_cap: null,
          evidence_quote: 'Approved 3 ICU days',
          evidence_message_id: 'm1',
        },
        {
          category: 'PROCEDURE',
          text_original: 'ازالة المياه البيضاء',
          canonical_en: 'Cataract surgery with IOL (phacoemulsification)',
          decision: 'APPROVED',
          quantity_requested: 1,
          quantity_approved: 1,
          conditions: [],
          info_requested: [],
          rejection_type: null,
          rejection_reason_ar: null,
          rejection_reason_en: null,
          amount_cap: null,
          evidence_quote: 'Approved cataract surgery',
          evidence_message_id: 'm1',
        },
        {
          category: 'PROCEDURE',
          text_original: 'ERCP',
          canonical_en: 'ERCP',
          decision: 'REJECTED',
          quantity_requested: 1,
          quantity_approved: 0,
          conditions: [],
          info_requested: [],
          rejection_type: 'MEDICAL_NECESSITY',
          rejection_reason_ar: 'مرفوض',
          rejection_reason_en: 'Rejected',
          amount_cap: null,
          evidence_quote: 'Rejected ERCP',
          evidence_message_id: 'm1',
        },
      ],
      contract,
      contractRows: rows2025,
      list2026Rows: rows2026,
      deps: { adjudicator: fixtures.adjudicator },
    });

    // Item 0: in both 2025 and 2026 -> contractor price used (18000 * 0.8 = 14400), never 2026
    expect(mixed.priced[0].price_source).toBe('CONTRACT');
    expect(mixed.priced[0].unit_price).toBe(14400);

    // Item 1: quantity 3 -> line_total = 3 * 4000 = 12000
    expect(mixed.priced[1].price_source).toBe('CONTRACT');
    expect(mixed.priced[1].unit_price).toBe(4000);
    expect(mixed.priced[1].qty).toBe(3);
    expect(mixed.priced[1].line_total).toBe(12000);

    // Item 2: absent from 2025 contractor list, present in 2026 list -> gross 21000, no discount, LIST_2026_PRICE_APPROVAL
    expect(mixed.priced[2].price_source).toBe('LIST_2026_PRICE_APPROVAL');
    expect(mixed.priced[2].unit_price).toBe(21000);
    expect(mixed.priced[2].discount_percent).toBe(0);

    // Item 3: rejected -> excluded from price approval draft, stores contractor price for reference only
    expect(mixed.priced[3].price_source).toBe('REJECTED_REFERENCE');
    expect(mixed.priced[3].reference_contract_price).toBe(16000);

    // Draft contains ONLY the 1 uncovered item (Cataract surgery at 21,000 EGP) and labels it موافقة سعرية
    const draft = buildPriceApprovalDraft(
      {
        patientName: 'Ahmed Mohamed',
        approvalRef: 'REF-77',
        insurer: 'Next Care',
        lines: mixed.priced,
      },
      { recipient: 'corporate@elitehospital.org', allowedDomains: ['elitehospital.org'] }
    );
    expect(draft).not.toBeNull();
    expect(draft!.to).toBe('corporate@elitehospital.org');
    expect(draft!.lineCount).toBe(1);
    expect(draft!.total).toBe(21000);
    expect(draft!.body).toContain('Cataract surgery');
    expect(draft!.body).toContain('موافقة سعرية');
    expect(draft!.body).not.toContain('Laparoscopic cholecystectomy');
    expect(draft!.body).not.toContain('ICU day');
    expect(draft!.body).not.toContain('ERCP');

    // External recipient domain is blocked
    expect(() =>
      assertInternalRecipient('external@gmail.com', {
        recipient: 'corporate@elitehospital.org',
        allowedDomains: ['elitehospital.org'],
      })
    ).toThrow(/not an allowed internal domain/);

    await expect(
      sendPriceApprovalDraft(
        { ...draft!, to: 'attacker@gmail.com' },
        { async createDraft() { return true; } },
        { recipient: 'corporate@elitehospital.org', allowedDomains: ['elitehospital.org'] }
      )
    ).rejects.toThrow(/not an allowed internal domain/);

    // 2. Fuzzy match 0.75 -> NEEDS_REVIEW, top candidates shown, NO automatic fallback to 2026
    const fuzzyAdjudicator: Adjudicator = {
      async adjudicate() {
        return { chosen_index: 0, match_class: 'BROADER', rationale: 'General endoscopic procedure' };
      },
    };
    const fuzzyRes = await priceItems({
      items: [
        {
          category: 'PROCEDURE',
          text_original: 'منظار',
          canonical_en: null,
          decision: 'APPROVED',
          quantity_requested: 1,
          quantity_approved: 1,
          conditions: [],
          info_requested: [],
          rejection_type: null,
          rejection_reason_ar: null,
          rejection_reason_en: null,
          amount_cap: null,
          evidence_quote: 'Approved',
          evidence_message_id: 'm1',
        },
      ],
      contract,
      contractRows: rows2025,
      list2026Rows: rows2026,
      deps: { adjudicator: fuzzyAdjudicator },
    });
    expect(fuzzyRes.coverage[0].result).toBe('NEEDS_REVIEW');
    expect(fuzzyRes.priced[0].price_source).toBe('NEEDS_REVIEW');
    expect(fuzzyRes.priced[0].unit_price).toBeNull();
    expect(fuzzyRes.priced[0].review_candidates?.length).toBeGreaterThan(0);

    // 3. Item absent from both lists -> NOT_FOUND, needs_human_review, no draft line
    const notFoundRes = await priceItems({
      items: [
        {
          category: 'PROCEDURE',
          text_original: 'Robotic proton beam cyberknife radiosurgery',
          canonical_en: null,
          decision: 'APPROVED',
          quantity_requested: 1,
          quantity_approved: 1,
          conditions: [],
          info_requested: [],
          rejection_type: null,
          rejection_reason_ar: null,
          rejection_reason_en: null,
          amount_cap: null,
          evidence_quote: 'Approved',
          evidence_message_id: 'm1',
        },
      ],
      contract,
      contractRows: rows2025,
      list2026Rows: rows2026,
      deps: { adjudicator: fixtures.adjudicator },
    });
    expect(notFoundRes.priced[0].price_source).toBe('NOT_FOUND');
    expect(notFoundRes.flags.some((f) => f.startsWith('NOT_FOUND:'))).toBe(true);
    expect(
      buildPriceApprovalDraft({
        patientName: 'Ahmed Mohamed',
        approvalRef: 'REF-77',
        insurer: 'Next Care',
        lines: notFoundRes.priced,
      })
    ).toBeNull();

    // 4. Insurer without contractor pricelist mapping -> flagged, no pricing, no draft
    const unmappedRes = await priceItems({
      items: [
        {
          category: 'PROCEDURE',
          text_original: 'Laparoscopic cholecystectomy',
          canonical_en: 'Laparoscopic cholecystectomy',
          decision: 'APPROVED',
          quantity_requested: 1,
          quantity_approved: 1,
          conditions: [],
          info_requested: [],
          rejection_type: null,
          rejection_reason_ar: null,
          rejection_reason_en: null,
          amount_cap: null,
          evidence_quote: 'Approved',
          evidence_message_id: 'm1',
        },
      ],
      contract: null,
      contractRows: [],
      list2026Rows: rows2026,
      deps: { adjudicator: fixtures.adjudicator },
    });
    expect(unmappedRes.flags).toContain('NO_PRICELIST_MAPPING');
    expect(unmappedRes.priced[0].unit_price).toBeNull();
  });

  it('Mixed approval overall status stays PARTIAL until price_approval_status = APPROVED, and amount cap below total -> PARTIAL with gap stated', async () => {
    const body = 'تمت الموافقة على استئصال المرارة بالمنظار وإزالة المياه البيضاء';
    const llm = buildMockLlm({
      ledger: {
        thread_status: 'APPROVED',
        approval_reference: 'REF-MIXED',
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'استئصال المرارة بالمنظار',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'APPROVED',
            quantity_requested: 1,
            quantity_approved: 1,
            conditions: [],
            info_requested: [],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: 'تمت الموافقة على استئصال المرارة بالمنظار وإزالة المياه البيضاء',
            evidence_message_id: 'm1',
          },
          {
            category: 'PROCEDURE',
            text_original: 'إزالة المياه البيضاء',
            canonical_en: 'Cataract surgery with IOL (phacoemulsification)',
            decision: 'APPROVED',
            quantity_requested: 1,
            quantity_approved: 1,
            conditions: [],
            info_requested: [],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: 'تمت الموافقة على استئصال المرارة بالمنظار وإزالة المياه البيضاء',
            evidence_message_id: 'm1',
          },
        ],
        confidence: 0.96,
        needs_human_review: false,
      },
    });

    const initial = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-mixed-status',
        insurer: 'Next Care',
        patientName: 'Ahmed Mohamed',
        requested: [
          { text: 'Laparoscopic cholecystectomy', category: 'PROCEDURE' },
          { text: 'Cataract surgery with IOL (phacoemulsification)', category: 'PROCEDURE' },
        ],
        messages: [{ messageId: 'm1', sender: 'medical@nextcare.com', date: '2026-03-01T10:00:00Z', body }],
        dryRun: true,
      },
      { llm, ...fixtures }
    );

    // Because 1 item requires موافقة سعرية, overall status is PARTIAL until Corporate Sales confirms APPROVED
    expect(initial.status).toBe('PARTIAL');
    expect(initial.price_approval_required).toBe(true);
    expect(initial.price_approval_draft_en).toContain('Cataract surgery');

    // Notification shows both Contract and موافقة سعرية sources
    const notif = formatClassificationNotification(initial, {
      patientName: 'Ahmed Mohamed',
      insurer: 'Next Care',
    });
    expect(notif).toContain('Contract');
    expect(notif).toContain('موافقة سعرية');

    // Once Corporate Sales confirms APPROVED:
    const afterApproved = applyPriceApprovalOutcome(initial, 'APPROVED');
    expect(afterApproved.status).toBe('APPROVED');

    // If Corporate Sales marks REFUSED:
    const afterRefused = applyPriceApprovalOutcome(initial, 'REFUSED');
    expect(afterRefused.status).toBe('PARTIAL');

    // Amount cap below resolved total -> PARTIAL with exact gap stated
    const capped = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-capped',
        insurer: 'Next Care',
        patientName: 'Ahmed Mohamed',
        requested: [{ text: 'Laparoscopic cholecystectomy', category: 'PROCEDURE' }],
        messages: [{ messageId: 'm1', sender: 'medical@nextcare.com', date: '2026-03-01T10:00:00Z', body }],
        amountCapOverride: 10000, // Resolved contract price is 14,400 -> gap = 4,400 EGP
        dryRun: true,
      },
      {
        llm: buildMockLlm({
          ledger: {
            thread_status: 'APPROVED',
            approval_reference: 'REF-CAP',
            items: [
              {
                category: 'PROCEDURE',
                text_original: 'استئصال المرارة بالمنظار',
                canonical_en: 'Laparoscopic cholecystectomy',
                decision: 'APPROVED',
                quantity_requested: 1,
                quantity_approved: 1,
                conditions: [],
                info_requested: [],
                rejection_type: null,
                rejection_reason_ar: null,
                rejection_reason_en: null,
                amount_cap: 10000,
                evidence_quote: 'تمت الموافقة على استئصال المرارة بالمنظار',
                evidence_message_id: 'm1',
              },
            ],
            confidence: 0.96,
            needs_human_review: false,
          },
        }),
        ...fixtures,
      }
    );
    expect(capped.status).toBe('PARTIAL');
    expect(capped.cap_gap).toBe(4400);
  });
});

describe('Section J.3 — Self-Learning Store, Privacy, Advisory Rules & Backfill', () => {
  const fixtures = createGoldenPricelistFixtures();

  it('Finalized outcome writes one anonymized row with NO patient identifiers; re-processing is idempotent; PENDING/UNCLEAR/needs_review never learned', async () => {
    const store = new InMemoryLearningStore();
    const body = 'الطبيب المراجع: لا مانع من اجراء استئصال المرارة بالمنظار للمريض أحمد محمد حسن رقم قومي 29001011234567 تليفون 01012345678 رقم الموافقة 112233';
    const llm = buildMockLlm({
      ledger: {
        thread_status: 'APPROVED',
        approval_reference: '112233',
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'استئصال المرارة بالمنظار',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'APPROVED',
            quantity_requested: 1,
            quantity_approved: 1,
            conditions: [],
            info_requested: [],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: 'لا مانع من اجراء استئصال المرارة بالمنظار',
            evidence_message_id: 'm1',
          },
        ],
        confidence: 0.96,
        needs_human_review: false,
      },
    });

    const res = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-learn-1',
        insurer: 'Next Care',
        patientName: 'أحمد محمد حسن',
        mrn: 'MRN-998877',
        requested: [{ text: 'Laparoscopic cholecystectomy', category: 'PROCEDURE' }],
        messages: [{ messageId: 'm1', sender: 'medical@nextcare.com', date: '2026-03-01T10:00:00Z', body }],
        learningEnabled: true,
      },
      { llm, ...fixtures, learningStore: store }
    );

    const allOutcomes = await store.getAllOutcomes();
    expect(allOutcomes).toHaveLength(1);
    const serialized = JSON.stringify(allOutcomes[0]);
    expect(serialized).not.toContain('أحمد محمد حسن');
    expect(serialized).not.toContain('MRN-998877');
    expect(serialized).not.toContain('01012345678');
    expect(serialized).not.toContain('29001011234567');

    // Re-processing the same message creates NO duplicate
    await recordClassificationOutcomes(store, {
      insurer: 'Next Care',
      sourceMessageId: 'msg-learn-1',
      result: res,
    });
    expect(await store.getAllOutcomes()).toHaveLength(1);

    // PENDING, UNCLEAR, and unresolved needs_human_review are never written
    await recordClassificationOutcomes(store, {
      insurer: 'Next Care',
      sourceMessageId: 'msg-pending',
      result: { ...res, status: 'PENDING' },
    });
    await recordClassificationOutcomes(store, {
      insurer: 'Next Care',
      sourceMessageId: 'msg-unclear',
      result: { ...res, status: 'UNCLEAR' },
    });
    await recordClassificationOutcomes(store, {
      insurer: 'Next Care',
      sourceMessageId: 'msg-needs-review',
      result: { ...res, needs_human_review: true },
    });
    expect(await store.getAllOutcomes()).toHaveLength(1);
  });

  it('Sample size < 5 -> insufficient history without percentages; strong history vs current thread -> status NEVER changes, anomaly flag set; Insurer A history never used for Insurer B; recent 3 diverging -> possible policy change', async () => {
    const store = new InMemoryLearningStore();
    const bodyApprove = 'الطبيب المراجع: لا مانع من اجراء استئصال المرارة بالمنظار رقم الموافقة 90012';
    const llmApprove = buildMockLlm({
      ledger: {
        thread_status: 'APPROVED',
        approval_reference: '90012',
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'استئصال المرارة بالمنظار',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'APPROVED',
            quantity_requested: 1,
            quantity_approved: 1,
            conditions: [],
            info_requested: [],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: 'لا مانع من اجراء استئصال المرارة بالمنظار',
            evidence_message_id: 'm1',
          },
        ],
        confidence: 0.96,
        needs_human_review: false,
      },
    });

    // Seed 3 outcomes (< 5) -> insufficient history, no percentages
    for (let i = 1; i <= 3; i++) {
      await store.upsertOutcome({
        id: `seed-${i}`,
        insurer_id: 'next care',
        canonical_procedure: 'Laparoscopic cholecystectomy',
        category: 'PROCEDURE',
        decision: 'rejected',
        rejection_type: 'COVERAGE_EXCLUSION',
        conditions: [],
        info_requested: [],
        quantity_requested: 1,
        quantity_approved: 0,
        amount_cap: null,
        copay_percent: null,
        validity_days: null,
        decided_at: `2026-01-0${i}T10:00:00Z`,
        turnaround_hours: null,
        label_source: 'HUMAN_CONFIRMED',
        source_approval_hash: `hash-seed-${i}`,
        contract_missing: false,
        observed_alias: null,
        created_at: `2026-01-0${i}T10:00:00Z`,
      });
    }
    await recomputeAllStats(store);

    const resUnder5 = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-under-5',
        insurer: 'Next Care',
        patientName: 'Test Patient',
        requested: [{ text: 'Laparoscopic cholecystectomy', category: 'PROCEDURE' }],
        messages: [{ messageId: 'm1', sender: 'medical@nextcare.com', date: '2026-03-01T10:00:00Z', body: bodyApprove }],
        dryRun: true,
      },
      { llm: llmApprove, ...fixtures, learningStore: store }
    );
    expect(resUnder5.history_hints[0].insufficient).toBe(true);
    expect(resUnder5.history_hints[0].approved_pct).toBeUndefined();
    const notifUnder5 = formatClassificationNotification(resUnder5, {
      patientName: 'Test Patient',
      insurer: 'Next Care',
    });
    expect(notifUnder5).toContain('insufficient history');

    // Add 3 more rejections (total 6 >= 5, 100% rejected for COVERAGE_EXCLUSION)
    for (let i = 4; i <= 6; i++) {
      await store.upsertOutcome({
        id: `seed-${i}`,
        insurer_id: 'next care',
        canonical_procedure: 'Laparoscopic cholecystectomy',
        category: 'PROCEDURE',
        decision: 'rejected',
        rejection_type: 'COVERAGE_EXCLUSION',
        conditions: [],
        info_requested: [],
        quantity_requested: 1,
        quantity_approved: 0,
        amount_cap: null,
        copay_percent: null,
        validity_days: null,
        decided_at: `2026-01-0${i}T10:00:00Z`,
        turnaround_hours: null,
        label_source: 'HUMAN_CONFIRMED',
        source_approval_hash: `hash-seed-${i}`,
        contract_missing: false,
        observed_alias: null,
        created_at: `2026-01-0${i}T10:00:00Z`,
      });
    }
    await recomputeAllStats(store);

    // Current thread APPROVES -> status stays APPROVED, needs_human_review = true with anomaly reason
    const resContradicts = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-contradicts-reject-history',
        insurer: 'Next Care',
        patientName: 'Test Patient',
        requested: [{ text: 'Laparoscopic cholecystectomy', category: 'PROCEDURE' }],
        messages: [{ messageId: 'm1', sender: 'medical@nextcare.com', date: '2026-03-01T10:00:00Z', body: bodyApprove }],
        dryRun: true,
      },
      { llm: llmApprove, ...fixtures, learningStore: store }
    );
    expect(resContradicts.status).toBe('APPROVED');
    expect(resContradicts.needs_human_review).toBe(true);
    expect(resContradicts.anomalies.some((a) => a.includes('ANOMALY_CONTRADICTS_REJECT_HISTORY'))).toBe(true);
    expect(resContradicts.anomalies.some((a) => a.includes('ANOMALY_PRIOR_COVERAGE_EXCLUSION'))).toBe(true);

    // Insurer A's history (Next Care) is NEVER used for Insurer B (GlobeMed)
    const resInsurerB = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-insurer-b',
        insurer: 'GlobeMed',
        patientName: 'Test Patient',
        requested: [{ text: 'Laparoscopic cholecystectomy', category: 'PROCEDURE' }],
        messages: [{ messageId: 'm1', sender: 'medical@globemed.com', date: '2026-03-01T10:00:00Z', body: bodyApprove }],
        dryRun: true,
      },
      { llm: llmApprove, ...fixtures, learningStore: store }
    );
    expect(resInsurerB.history_hints[0].n).toBe(0);
    expect(resInsurerB.anomalies).toHaveLength(0);

    // Now test the reverse: history says "always approved" (6 approvals for AXA) vs current thread rejects -> status stays REJECTED, flag only
    for (let i = 1; i <= 6; i++) {
      await store.upsertOutcome({
        id: `axa-seed-${i}`,
        insurer_id: 'axa',
        canonical_procedure: 'Laparoscopic cholecystectomy',
        category: 'PROCEDURE',
        decision: 'approved',
        rejection_type: null,
        conditions: [],
        info_requested: [],
        quantity_requested: 1,
        quantity_approved: 1,
        amount_cap: null,
        copay_percent: null,
        validity_days: null,
        decided_at: `2026-01-0${i}T10:00:00Z`,
        turnaround_hours: null,
        label_source: 'HUMAN_CONFIRMED',
        source_approval_hash: `hash-axa-${i}`,
        contract_missing: false,
        observed_alias: null,
        created_at: `2026-01-0${i}T10:00:00Z`,
      });
    }
    await recomputeAllStats(store);

    const bodyReject = 'نعتذر عن عدم الموافقة على استئصال المرارة بالمنظار لعدم وجود داعي طبي';
    const llmReject = buildMockLlm({
      ledger: {
        thread_status: 'REJECTED',
        approval_reference: null,
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'استئصال المرارة بالمنظار',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'REJECTED',
            quantity_requested: 1,
            quantity_approved: 0,
            conditions: [],
            info_requested: [],
            rejection_type: 'MEDICAL_NECESSITY',
            rejection_reason_ar: 'لعدم وجود داعي طبي',
            rejection_reason_en: 'Lack of medical necessity',
            amount_cap: null,
            evidence_quote: bodyReject,
            evidence_message_id: 'm1',
          },
        ],
        confidence: 0.95,
        needs_human_review: false,
      },
    });

    const resRejectAgainstHistory = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-axa-reject',
        insurer: 'AXA',
        patientName: 'Test Patient',
        requested: [{ text: 'Laparoscopic cholecystectomy', category: 'PROCEDURE' }],
        messages: [{ messageId: 'm1', sender: 'medical@axa.com', date: '2026-03-01T10:00:00Z', body: bodyReject }],
        dryRun: true,
      },
      { llm: llmReject, ...fixtures, learningStore: store }
    );
    expect(resRejectAgainstHistory.status).toBe('REJECTED');
    expect(resRejectAgainstHistory.needs_human_review).toBe(true);
    expect(resRejectAgainstHistory.anomalies.some((a) => a.includes('ANOMALY_CONTRADICTS_APPROVE_HISTORY'))).toBe(true);

    // Add 3 recent rejections to AXA so the 3 most recent diverge from the older 6 approvals -> "possible policy change"
    for (let i = 7; i <= 9; i++) {
      await store.upsertOutcome({
        id: `axa-seed-${i}`,
        insurer_id: 'axa',
        canonical_procedure: 'Laparoscopic cholecystectomy',
        category: 'PROCEDURE',
        decision: 'rejected',
        rejection_type: 'MEDICAL_NECESSITY',
        conditions: [],
        info_requested: [],
        quantity_requested: 1,
        quantity_approved: 0,
        amount_cap: null,
        copay_percent: null,
        validity_days: null,
        decided_at: `2026-02-0${i}T10:00:00Z`,
        turnaround_hours: null,
        label_source: 'HUMAN_CONFIRMED',
        source_approval_hash: `hash-axa-${i}`,
        contract_missing: false,
        observed_alias: null,
        created_at: `2026-02-0${i}T10:00:00Z`,
      });
    }
    await recomputeAllStats(store);

    const resPolicyChange = await classifyApprovalThread(
      {
        sourceMessageId: 'msg-axa-policy-change',
        insurer: 'AXA',
        patientName: 'Test Patient',
        requested: [{ text: 'Laparoscopic cholecystectomy', category: 'PROCEDURE' }],
        messages: [{ messageId: 'm1', sender: 'medical@axa.com', date: '2026-03-01T10:00:00Z', body: bodyReject }],
        dryRun: true,
      },
      { llm: llmReject, ...fixtures, learningStore: store }
    );
    expect(resPolicyChange.history_hints[0].possible_policy_change).toBe(true);
    expect(resPolicyChange.anomalies.some((a) => a.includes('ANOMALY_POSSIBLE_POLICY_CHANGE'))).toBe(true);
  });

  it('Human correction overwrites auto label and updates stats; forget removes outcome, recomputes stats, and logs audit entry', async () => {
    const store = new InMemoryLearningStore();
    await recordClassificationOutcomes(store, {
      insurer: 'Next Care',
      sourceMessageId: 'msg-to-correct',
      result: {
        status: 'APPROVED',
        confidence: 0.95,
        needs_human_review: false,
        verification: { verdict: 'OK', corrections: [] },
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'Ureteroscopy',
            canonical_en: 'Ureteroscopy',
            decision: 'APPROVED',
            quantity_requested: 1,
            quantity_approved: 1,
            conditions: [],
            info_requested: [],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: 'Approved',
            evidence_message_id: 'm1',
          },
        ],
        priced: [],
      },
    });

    await applyHumanCorrection(store, {
      approvalId: 'app-1',
      insurer: 'Next Care',
      sourceMessageId: 'msg-to-correct',
      field: 'status',
      modelValue: 'APPROVED',
      humanValue: 'REJECTED',
      updatedResult: {
        status: 'REJECTED',
        confidence: 1,
        needs_human_review: false,
        verification: { verdict: 'OK', corrections: [] },
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'Ureteroscopy',
            canonical_en: 'Ureteroscopy',
            decision: 'REJECTED',
            quantity_requested: 1,
            quantity_approved: 0,
            conditions: [],
            info_requested: [],
            rejection_type: 'MEDICAL_NECESSITY',
            rejection_reason_ar: 'مرفوض',
            rejection_reason_en: 'Rejected',
            amount_cap: null,
            evidence_quote: 'مرفوض',
            evidence_message_id: 'm1',
          },
        ],
        priced: [],
      },
      actor: 'dr.reviewer@elitehospital.org',
      note: 'Reviewer corrected auto classification',
    });

    const all = await store.getAllOutcomes();
    expect(all[0].decision).toBe('rejected');
    expect(all[0].label_source).toBe('HUMAN_CONFIRMED');
    const stat = await store.getStats('Next Care', 'Ureteroscopy');
    expect(stat?.rejected_n).toBe(1);
    expect(stat?.approved_n).toBe(0);

    // Forget command removes outcome, recomputes stats, and writes audit entry
    const outcomeId = all[0].id;
    const forgot = await forgetOutcome(store, outcomeId, 'dr.reviewer@elitehospital.org');
    expect(forgot.deletedCount).toBe(1);
    expect(await store.getAllOutcomes()).toHaveLength(0);
    expect(await store.getStats('Next Care', 'Ureteroscopy')).toBeNull();
    expect(store.audits.some((a) => a.action === 'FORGET_OUTCOME' && a.target_id === outcomeId)).toBe(true);
  });

  it('Few-shot examples and LLM prompts are PHI-masked (no patient name, phone, national ID, or policy number)', async () => {
    const store = new InMemoryLearningStore();
    const row = await addMaskedFewShot(store, {
      insurer: 'Next Care',
      category: 'PROCEDURE',
      language: 'ar',
      rawSnippet: 'المريض محمد ابراهيم حسن تليفون 01098765432 بطاقة 28801011234567 رقم البوليصة: POL-998877 تمت الموافقة',
      expectedOutput: { decision: 'APPROVED' },
      known: { patientName: 'محمد ابراهيم حسن', mrn: 'MRN-554433' },
    });

    expect(row.masked_snippet).not.toContain('محمد ابراهيم حسن');
    expect(row.masked_snippet).not.toContain('01098765432');
    expect(row.masked_snippet).not.toContain('28801011234567');
    expect(row.masked_snippet).not.toContain('POL-998877');

    const auditEntries: LlmAuditEntry[] = [];
    const baseLlm = buildMockLlm({
      ledger: {
        thread_status: 'APPROVED',
        approval_reference: '443311',
        items: [
          {
            category: 'PROCEDURE',
            text_original: 'استئصال المرارة بالمنظار',
            canonical_en: 'Laparoscopic cholecystectomy',
            decision: 'APPROVED',
            quantity_requested: 1,
            quantity_approved: 1,
            conditions: [],
            info_requested: [],
            rejection_type: null,
            rejection_reason_ar: null,
            rejection_reason_en: null,
            amount_cap: null,
            evidence_quote: 'تمت الموافقة على استئصال المرارة بالمنظار',
            evidence_message_id: 'm1',
          },
        ],
        confidence: 0.96,
        needs_human_review: false,
      },
    });
    const auditedLlm = new AuditedLlmClient(baseLlm, {
      async record(entry) {
        auditEntries.push(entry);
      },
    });

    await classifyApprovalThread(
      {
        sourceMessageId: 'msg-phi-check',
        insurer: 'Next Care',
        patientName: 'محمد ابراهيم حسن',
        mrn: 'MRN-554433',
        requested: [{ text: 'Laparoscopic cholecystectomy', category: 'PROCEDURE' }],
        messages: [
          {
            messageId: 'm1',
            sender: 'medical@nextcare.com',
            date: '2026-03-01T10:00:00Z',
            body: 'المريض محمد ابراهيم حسن تليفون 01098765432 تمت الموافقة على استئصال المرارة بالمنظار',
          },
        ],
        dryRun: true,
      },
      { llm: auditedLlm, ...fixtures, learningStore: store }
    );

    expect(auditEntries.length).toBeGreaterThan(0);
    for (const a of auditEntries) {
      expect(a.masked_input).not.toContain('محمد ابراهيم حسن');
      expect(a.masked_input).not.toContain('01098765432');
      expect(a.masked_input).not.toContain('MRN-554433');
    }
  });

  it('Learned rules lifecycle: only APPROVED rules apply; PRICELIST_SUGGESTION never edits any pricelist; promotion regression gate blocks bad rules', async () => {
    const store = new InMemoryLearningStore();

    // Create 3 outcomes where an item required LIST_2026_PRICE_APPROVAL -> proposes PRICELIST_SUGGESTION rule
    for (let i = 1; i <= 3; i++) {
      await store.upsertOutcome({
        id: `cat-${i}`,
        insurer_id: 'next care',
        canonical_procedure: 'Cataract surgery with IOL (phacoemulsification)',
        category: 'PROCEDURE',
        decision: 'approved',
        rejection_type: null,
        conditions: [],
        info_requested: [],
        quantity_requested: 1,
        quantity_approved: 1,
        amount_cap: null,
        copay_percent: null,
        validity_days: null,
        decided_at: `2026-02-0${i}T10:00:00Z`,
        turnaround_hours: null,
        label_source: 'HUMAN_CONFIRMED',
        source_approval_hash: `hash-cat-${i}`,
        contract_missing: true,
        observed_alias: 'custom chole alias xyz',
        created_at: `2026-02-0${i}T10:00:00Z`,
      });
    }
    const proposed = await proposeRulesFromOutcomes(store);
    expect(proposed.some((r) => r.rule_type === 'PRICELIST_SUGGESTION' && r.status === 'PROPOSED')).toBe(true);

    const aliasRule = proposed.find((r) => r.rule_type === 'ALIAS')!;
    expect(aliasRule).toBeDefined();
    expect(aliasRule.status).toBe('PROPOSED');

    // While PROPOSED, it is NOT applied
    setApprovedAliasRules([]);
    expect(normalizeItem('custom chole alias xyz').canonical_en).toBeNull();

    // Attempt to promote a rule when golden-set regression occurs -> blocked!
    const blockedPromo = await promoteRuleWithGate(store, {
      ruleId: aliasRule.id,
      actor: 'admin@elitehospital.org',
      baseline: { accuracy: 1, falseApprovalCount: 0 },
      runGoldenSetWithCandidate: async () => ({ accuracy: 0.98, falseApprovalCount: 1 }),
    });
    expect(blockedPromo.promoted).toBe(false);
    expect((await store.getRules({ status: 'APPROVED' })).length).toBe(0);

    // Promote when golden-set passes (0 false approvals, no accuracy drop) -> succeeds!
    const okPromo = await promoteRuleWithGate(store, {
      ruleId: aliasRule.id,
      actor: 'admin@elitehospital.org',
      baseline: { accuracy: 1, falseApprovalCount: 0 },
      runGoldenSetWithCandidate: async () => ({ accuracy: 1, falseApprovalCount: 0 }),
    });
    expect(okPromo.promoted).toBe(true);
    expect((await store.getRules({ status: 'APPROVED' })).length).toBe(1);

    // Retire rule -> no longer active
    await retireRule(store, aliasRule.id, 'admin@elitehospital.org');
    expect((await store.getRules({ status: 'APPROVED' })).length).toBe(0);
  });

  it('Backfill dry-run sends no notifications/drafts, writes no live statuses, is idempotent, and <95% sample accuracy blocks learning', async () => {
    const store = new InMemoryLearningStore();
    const records = Array.from({ length: 10 }, (_, idx) => ({
      id: `rec-${idx + 1}`,
      messageId: `hist-msg-${idx + 1}`,
      patientName: `Patient ${idx + 1}`,
      mrn: `MRN-${idx + 1}`,
      contractorNormalized: 'Next Care',
      receivedAt: '2026-03-01T10:00:00Z',
      requestedServices: [{ name: 'استئصال المرارة بالمنظار' }],
      existingApprovalSnippet: 'تمت الموافقة على استئصال المرارة بالمنظار',
    }));

    // 1. Dry-run writes nothing to learningStore and sends no drafts
    const { shadow, report } = await runBackfillHistory({
      records,
      dryRun: true,
      learningStore: store,
    });
    expect(report.dryRun).toBe(true);
    expect(report.totalProcessed).toBe(10);
    expect(report.learningEnabled).toBe(false);
    expect(await store.getAllOutcomes()).toHaveLength(0);

    // 2. Re-running with existingShadow is idempotent (skips all 10)
    const rerun = await runBackfillHistory({
      records,
      existingShadow: shadow,
      dryRun: true,
      learningStore: store,
    });
    expect(rerun.report.totalProcessed).toBe(0);
    expect(rerun.report.skippedIdempotent).toBe(10);

    // 3. < 95% sample accuracy blocks enabling learning even with humanApproved = true
    const lowVerdicts: Record<string, boolean> = {};
    records.forEach((r, idx) => {
      lowVerdicts[r.messageId!] = idx < 8; // 80% accuracy (< 95%)
    });
    const blocked = await runBackfillHistory({
      records,
      existingShadow: new Map(shadow),
      dryRun: false,
      humanApproved: true,
      sampleVerdicts: lowVerdicts,
      learningStore: store,
    });
    expect(blocked.report.sampleAccuracy).toBe(0.8);
    expect(blocked.report.learningEnabled).toBe(false);
    expect(await store.getAllOutcomes()).toHaveLength(0);

    // 4. >= 95% sample accuracy + humanApproved = true enables learning and populates store
    const highVerdicts: Record<string, boolean> = {};
    records.forEach((r) => {
      highVerdicts[r.messageId!] = true; // 100% accuracy (>= 95%)
    });
    const enabled = await runBackfillHistory({
      records,
      existingShadow: new Map(shadow),
      dryRun: false,
      humanApproved: true,
      sampleVerdicts: highVerdicts,
      learningStore: store,
    });
    expect(enabled.report.sampleAccuracy).toBe(1);
    expect(enabled.report.learningEnabled).toBe(true);
    expect((await store.getAllOutcomes()).length).toBe(10);
  });
});

describe('Section I — Golden-Set (50+ threads) & Time-Split Self-Learning Evaluation', () => {
  it('Golden set achieves 0 false approvals and >= 95% accuracy across all 5 statuses', async () => {
    const report = await runGoldenSetEvaluation();
    expect(report.totalThreads).toBeGreaterThanOrEqual(50);
    expect(report.falseApprovalCount).toBe(0);
    expect(report.falseApprovalRate).toBe(0);
    expect(report.overallAccuracy).toBeGreaterThanOrEqual(0.95);
  });

  it('Time-split learning evaluation catches anomalies without mutating any thread status', async () => {
    const report = await runTimeSplitLearningEvaluation();
    expect(report.statusChangedByHistory).toBe(0);
    expect(report.anomalyCatchRate).toBe(1);
    expect(report.falseFlagRate).toBe(0);
  });
});
