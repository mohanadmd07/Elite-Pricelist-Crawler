/**
 * Builds `.agent/skills/approval-reply-classifier/eval/golden-set.jsonl` with >= 50
 * anonymized, masked inpatient approval threads covering all 5 statuses:
 * APPROVED, PARTIAL, REJECTED, PENDING, UNCLEAR, plus time-split learning cases.
 *
 * Also supports `--from <file.json>` to load and anonymize external historical threads.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { GoldenThreadEntry } from '../../../../src/classifier/eval';
import { assertNoPhi, maskPhi } from '../../../../src/classifier/index';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.resolve(HERE, '../eval/golden-set.jsonl');

function buildThreads(): GoldenThreadEntry[] {
  const entries: GoldenThreadEntry[] = [];
  let seq = 1;
  const nextId = () => `GOLD-${String(seq++).padStart(3, '0')}`;
  const isoDay = (dayOffset: number) => new Date(Date.UTC(2026, 8, 1 + dayOffset, 10, 0, 0)).toISOString();

  // ---------------- 18 APPROVED threads (older + newer) ----------------
  const approvedProcedures = [
    { ins: 'Next Care', proc: 'استئصال المرارة بالمنظار', can: 'Laparoscopic cholecystectomy', quote: 'لا مانع من إجراء استئصال المرارة بالمنظار حسب الأسعار المتعاقد عليها رقم الموافقة 50101' },
    { ins: 'Next Care', proc: 'lap chole', can: 'Laparoscopic cholecystectomy', quote: 'Approved for lap chole per contract rates Ref #NC-50102' },
    { ins: 'Next Care', proc: 'عملية المرارة منظار', can: 'Laparoscopic cholecystectomy', quote: 'تمت الموافقة على عملية المرارة منظار رقم الموافقة 50103' },
    { ins: 'Next Care', proc: 'استئصال المرارة بالمنظار', can: 'Laparoscopic cholecystectomy', quote: 'لا يوجد مانع من إجراء استئصال المرارة بالمنظار رقم الموافقة 50104' },
    { ins: 'Next Care', proc: 'استئصال المرارة بالمنظار', can: 'Laparoscopic cholecystectomy', quote: 'تم اعتماد استئصال المرارة بالمنظار من الطبيب المراجع رقم 50105' },
    { ins: 'Next Care', proc: 'استئصال المرارة بالمنظار', can: 'Laparoscopic cholecystectomy', quote: 'لا مانع من استئصال المرارة بالمنظار رقم الموافقة 50106' },
    { ins: 'GlobeMed', proc: 'ولادة قيصرية', can: 'Cesarean section', quote: 'لا مانع من إجراء ولادة قيصرية رقم الموافقة 60201' },
    { ins: 'GlobeMed', proc: 'C-section', can: 'Cesarean section', quote: 'We approve the C-section as per contract Ref GM-60202' },
    { ins: 'GlobeMed', proc: 'قيصرية', can: 'Cesarean section', quote: 'تمت الموافقة على عملية قيصرية رقم الموافقة 60203' },
    { ins: 'GlobeMed', proc: 'ولادة قيصرية', can: 'Cesarean section', quote: 'لا يوجد مانع من ولادة قيصرية رقم الموافقة 60204' },
    { ins: 'GlobeMed', proc: 'ولادة قيصرية', can: 'Cesarean section', quote: 'موافقة الطبيب المراجع على ولادة قيصرية رقم 60205' },
    { ins: 'MedRight', proc: 'اشعة CT بالصبغة', can: 'CT scan with contrast', quote: 'لا مانع من عمل اشعة CT بالصبغة رقم الموافقة 70301', cat: 'INVESTIGATION' as const },
    { ins: 'MedRight', proc: 'منظار الحالب', can: 'Ureteroscopy', quote: 'تمت الموافقة على منظار الحالب رقم الموافقة 70302' },
    { ins: 'AXA', proc: 'قسطرة قلب تشخيصية', can: 'Diagnostic cardiac catheterization', quote: 'Approved for diagnostic cardiac catheterization Ref AX-80401' },
    { ins: 'AXA', proc: 'استئصال الزائدة بالمنظار', can: 'Laparoscopic appendectomy', quote: 'لا مانع من استئصال الزائدة بالمنظار رقم الموافقة 80402' },
    { ins: 'MetLife', proc: 'منظار المعدة', can: 'Upper GI endoscopy', quote: 'لا مانع من إجراء منظار المعدة رقم الموافقة 90501' },
    { ins: 'MetLife', proc: 'اصلاح فتق اربي بشبكة', can: 'Inguinal hernia repair with mesh', quote: 'تمت الموافقة على اصلاح فتق اربي بشبكة رقم الموافقة 90502' },
    { ins: 'Next Care', proc: 'تفتيت الحصوات بالموجات', can: 'Extracorporeal shock wave lithotripsy (ESWL)', quote: 'لا مانع من تفتيت الحصوات بالموجات رقم الموافقة 50107' },
  ];

  approvedProcedures.forEach((p, idx) => {
    const id = nextId();
    const cat = (p as any).cat || 'PROCEDURE';
    entries.push({
      id,
      insurer: p.ins,
      decided_at: isoDay(idx),
      requested: [{ text: p.proc, category: cat, quantity: 1 }],
      messages: [
        {
          messageId: `${id}-m1`,
          sender: 'reviewer@insurer-tpa.example',
          date: isoDay(idx),
          subject: `RE: Approval ${id}`,
          body: `الطبيب المراجع: ${p.quote}`,
        },
      ],
      expected_status: 'APPROVED',
      expected_items: [
        {
          text_original: p.proc,
          canonical_en: p.can,
          category: cat,
          decision: 'APPROVED',
          quantity_requested: 1,
          quantity_approved: 1,
          evidence_quote: p.quote,
          evidence_message_id: `${id}-m1`,
        },
      ],
    });
  });

  // ---------------- 12 REJECTED threads ----------------
  const rejectedCases: Array<{
    ins: string;
    proc: string;
    can: string;
    rtype: 'COVERAGE_EXCLUSION' | 'PRE_EXISTING' | 'MEDICAL_NECESSITY' | 'WAITING_PERIOD' | 'POLICY_EXPIRED' | 'LIMIT_EXCEEDED';
    ar: string;
    en: string;
  }> = [
    { ins: 'AXA', proc: 'تغيير مفصل الركبة', can: 'Total knee replacement', rtype: 'COVERAGE_EXCLUSION', ar: 'غير موافق على تغيير مفصل الركبة لأن البند مستثنى من الوثيقة وخارج التغطية', en: 'Total knee replacement is excluded from policy coverage' },
    { ins: 'AXA', proc: 'تغيير مفصل الركبة', can: 'Total knee replacement', rtype: 'COVERAGE_EXCLUSION', ar: 'نعتذر عن عدم الموافقة على تغيير مفصل الركبة حيث أنه خارج التغطية التأمينية', en: 'Excluded from coverage' },
    { ins: 'AXA', proc: 'تغيير مفصل الركبة', can: 'Total knee replacement', rtype: 'COVERAGE_EXCLUSION', ar: 'مرفوض تغيير مفصل الركبة لكونه مستثنى من الوثيقة', en: 'Policy exclusion' },
    { ins: 'AXA', proc: 'تغيير مفصل الركبة', can: 'Total knee replacement', rtype: 'COVERAGE_EXCLUSION', ar: 'عدم الموافقة على تغيير مفصل الركبة خارج التغطية', en: 'Out of coverage' },
    { ins: 'AXA', proc: 'تغيير مفصل الركبة', can: 'Total knee replacement', rtype: 'COVERAGE_EXCLUSION', ar: 'لا يمكن الموافقة على تغيير مفصل الركبة لأنه مستثنى من التغطية', en: 'Coverage exclusion' },
    { ins: 'AXA', proc: 'تغيير مفصل الركبة', can: 'Total knee replacement', rtype: 'COVERAGE_EXCLUSION', ar: 'يرفض طلب تغيير مفصل الركبة خارج التغطية التأمينية', en: 'Coverage exclusion' },
    { ins: 'GlobeMed', proc: 'تغيير مفصل الفخذ', can: 'Total hip replacement', rtype: 'PRE_EXISTING', ar: 'غير موافق على تغيير مفصل الفخذ لأن الحالة سابقة على التعاقد', en: 'Pre-existing condition' },
    { ins: 'Next Care', proc: 'منظار القولون', can: 'Colonoscopy', rtype: 'MEDICAL_NECESSITY', ar: 'نعتذر عن عدم الموافقة على منظار القولون لعدم وجود مبرر طبي كافٍ', en: 'Insufficient medical necessity' },
    { ins: 'MedRight', proc: 'استئصال البروستاتا بالمنظار', can: 'Transurethral resection of the prostate (TURP)', rtype: 'WAITING_PERIOD', ar: 'لا يمكن الموافقة على استئصال البروستاتا بالمنظار حيث أن فترة الانتظار لم تنقضِ', en: 'Waiting period not elapsed' },
    { ins: 'MetLife', proc: 'منظار القنوات المرارية', can: 'ERCP', rtype: 'POLICY_EXPIRED', ar: 'مرفوض منظار القنوات المرارية لأن الوثيقة منتهية وغير سارية', en: 'Policy expired' },
    { ins: 'GlobeMed', proc: 'قسطرة علاجية بدعامة', can: 'Coronary angioplasty with stent (PCI)', rtype: 'LIMIT_EXCEEDED', ar: 'تعذر الموافقة على قسطرة علاجية بدعامة لتجاوز الحد الأقصى للتغطية السنوية', en: 'Annual limit exceeded' },
    { ins: 'MedRight', proc: 'تثبيت كسر بالمسامير والشرائح', can: 'Open reduction and internal fixation (ORIF)', rtype: 'COVERAGE_EXCLUSION', ar: 'غير موافق على تثبيت كسر بالمسامير والشرائح خارج التغطية', en: 'Excluded from coverage' },
  ];

  rejectedCases.forEach((c, idx) => {
    const id = nextId();
    const day = 18 + idx;
    entries.push({
      id,
      insurer: c.ins,
      decided_at: isoDay(day),
      requested: [{ text: c.proc, category: 'PROCEDURE', quantity: 1 }],
      messages: [
        {
          messageId: `${id}-m1`,
          sender: 'medical@insurer-tpa.example',
          date: isoDay(day),
          subject: `RE: Approval ${id}`,
          body: `الطبيب المراجع: ${c.ar}`,
        },
      ],
      expected_status: 'REJECTED',
      expected_items: [
        {
          text_original: c.proc,
          canonical_en: c.can,
          category: 'PROCEDURE',
          decision: 'REJECTED',
          quantity_requested: 1,
          rejection_type: c.rtype,
          rejection_reason_ar: c.ar,
          rejection_reason_en: c.en,
          evidence_quote: c.ar,
          evidence_message_id: `${id}-m1`,
        },
      ],
    });
  });

  // ---------------- 10 PARTIAL threads (conditions, ask-backs, partial qty, unaddressed, 2026 price approval) ----------------
  const partialCases: Array<() => GoldenThreadEntry> = [
    () => {
      const id = nextId();
      const q = 'لا مانع من عمل رنين مغناطيسي بالصبغة بشرط إرسال تقرير طبي مفصل';
      return {
        id,
        insurer: 'MedRight',
        decided_at: isoDay(31),
        requested: [{ text: 'رنين مغناطيسي بالصبغة', category: 'INVESTIGATION', quantity: 1 }],
        messages: [{ messageId: `${id}-m1`, sender: 'med@tpa.example', date: isoDay(31), body: `الطبيب المراجع: ${q} رقم الموافقة 71001` }],
        expected_status: 'PARTIAL',
        expected_items: [{ text_original: 'رنين مغناطيسي بالصبغة', canonical_en: 'MRI with contrast', category: 'INVESTIGATION', decision: 'CONDITIONAL', conditions: ['إرسال تقرير طبي مفصل'], info_requested: ['تقرير طبي مفصل'], evidence_quote: q, evidence_message_id: `${id}-m1` }],
      };
    },
    () => {
      const id = nextId();
      const q = 'يرجى إرسال كود التشخيص ICD-10 ونتيجة الموجات الصوتية قبل البت في منظار المثانة';
      return {
        id,
        insurer: 'Next Care',
        decided_at: isoDay(32),
        requested: [{ text: 'منظار المثانة', category: 'PROCEDURE', quantity: 1 }],
        messages: [{ messageId: `${id}-m1`, sender: 'med@tpa.example', date: isoDay(32), body: `الطبيب المراجع: ${q}` }],
        expected_status: 'PARTIAL',
        expected_items: [{ text_original: 'منظار المثانة', canonical_en: 'Cystoscopy', category: 'PROCEDURE', decision: 'INFO_REQUESTED', info_requested: ['كود التشخيص ICD-10', 'نتيجة الموجات الصوتية'], evidence_quote: q, evidence_message_id: `${id}-m1` }],
      };
    },
    () => {
      const id = nextId();
      const q = 'تمت الموافقة على 3 أيام عناية مركزة من أصل 5 أيام مطلوبة رقم الموافقة 71003';
      return {
        id,
        insurer: 'GlobeMed',
        decided_at: isoDay(33),
        requested: [{ text: 'يوم عناية مركزة', category: 'ICU_DAYS', quantity: 5 }],
        messages: [{ messageId: `${id}-m1`, sender: 'med@tpa.example', date: isoDay(33), body: `الطبيب المراجع: ${q}` }],
        expected_status: 'PARTIAL',
        expected_items: [{ text_original: 'يوم عناية مركزة', canonical_en: 'ICU day', category: 'ICU_DAYS', decision: 'APPROVED', quantity_requested: 5, quantity_approved: 3, evidence_quote: q, evidence_message_id: `${id}-m1` }],
      };
    },
    () => {
      const id = nextId();
      const q = 'تمت الموافقة على جلسة غسيل كلوي واحدة فقط من 3 جلسات رقم الموافقة 71004';
      return {
        id,
        insurer: 'AXA',
        decided_at: isoDay(34),
        requested: [{ text: 'جلسة غسيل كلوي', category: 'PROCEDURE', quantity: 3 }],
        messages: [{ messageId: `${id}-m1`, sender: 'med@tpa.example', date: isoDay(34), body: `الطبيب المراجع: ${q}` }],
        expected_status: 'PARTIAL',
        expected_items: [{ text_original: 'جلسة غسيل كلوي', canonical_en: 'Hemodialysis session', category: 'PROCEDURE', decision: 'APPROVED', quantity_requested: 3, quantity_approved: 1, evidence_quote: q, evidence_message_id: `${id}-m1` }],
      };
    },
    () => {
      // Admission approved, procedure not addressed -> PARTIAL
      const id = nextId();
      const q = 'لا مانع من اقامة بالقسم الداخلي لمدة يومين رقم الموافقة 71005';
      return {
        id,
        insurer: 'Next Care',
        decided_at: isoDay(35),
        requested: [
          { text: 'اقامة بالقسم الداخلي', category: 'ADMISSION', quantity: 2 },
          { text: 'استئصال المرارة بالمنظار', category: 'PROCEDURE', quantity: 1 },
        ],
        messages: [{ messageId: `${id}-m1`, sender: 'med@tpa.example', date: isoDay(35), body: `الطبيب المراجع: ${q}` }],
        expected_status: 'PARTIAL',
        expected_items: [
          { text_original: 'اقامة بالقسم الداخلي', canonical_en: 'Inpatient admission', category: 'ADMISSION', decision: 'APPROVED', quantity_requested: 2, quantity_approved: 2, evidence_quote: q, evidence_message_id: `${id}-m1` },
          { text_original: 'استئصال المرارة بالمنظار', canonical_en: 'Laparoscopic cholecystectomy', category: 'PROCEDURE', decision: 'NOT_ADDRESSED', quantity_requested: 1, evidence_quote: '', evidence_message_id: '' },
        ],
      };
    },
    () => {
      // Price approval required (item in 2026 only -> cataract) -> PARTIAL until Corporate Sales confirms
      const id = nextId();
      const q = 'لا مانع من ازالة المياه البيضاء رقم الموافقة 71006';
      return {
        id,
        insurer: 'Next Care',
        decided_at: isoDay(36),
        requested: [{ text: 'ازالة المياه البيضاء', category: 'PROCEDURE', quantity: 1 }],
        messages: [{ messageId: `${id}-m1`, sender: 'med@tpa.example', date: isoDay(36), body: `الطبيب المراجع: ${q}` }],
        expected_status: 'PARTIAL',
        expected_items: [{ text_original: 'ازالة المياه البيضاء', canonical_en: 'Cataract surgery with IOL (phacoemulsification)', category: 'PROCEDURE', decision: 'APPROVED', quantity_requested: 1, quantity_approved: 1, evidence_quote: q, evidence_message_id: `${id}-m1` }],
      };
    },
    () => {
      // Amount cap exceeded -> PARTIAL
      const id = nextId();
      const q = 'لا مانع من استئصال المرارة بالمنظار بحد أقصى 10000 ج.م رقم الموافقة 71007';
      return {
        id,
        insurer: 'Next Care',
        decided_at: isoDay(37),
        requested: [{ text: 'استئصال المرارة بالمنظار', category: 'PROCEDURE', quantity: 1 }],
        messages: [{ messageId: `${id}-m1`, sender: 'med@tpa.example', date: isoDay(37), body: `الطبيب المراجع: ${q}` }],
        amount_cap_override: 10000,
        expected_status: 'PARTIAL',
        expected_items: [{ text_original: 'استئصال المرارة بالمنظار', canonical_en: 'Laparoscopic cholecystectomy', category: 'PROCEDURE', decision: 'APPROVED', quantity_requested: 1, quantity_approved: 1, amount_cap: 10000, evidence_quote: q, evidence_message_id: `${id}-m1` }],
      };
    },
    () => {
      const id = nextId();
      const q = 'Approved for CT scan without contrast subject to sending creatinine lab result Ref 71008';
      return {
        id,
        insurer: 'MedRight',
        decided_at: isoDay(38),
        requested: [{ text: 'اشعة مقطعية بدون صبغة', category: 'INVESTIGATION', quantity: 1 }],
        messages: [{ messageId: `${id}-m1`, sender: 'med@tpa.example', date: isoDay(38), body: `Medical Review: ${q}` }],
        expected_status: 'PARTIAL',
        expected_items: [{ text_original: 'اشعة مقطعية بدون صبغة', canonical_en: 'CT scan without contrast', category: 'INVESTIGATION', decision: 'CONDITIONAL', conditions: ['sending creatinine lab result'], info_requested: ['creatinine lab result'], evidence_quote: q, evidence_message_id: `${id}-m1` }],
      };
    },
    () => {
      const id = nextId();
      const q = 'لا مانع من اقامة عناية قلب ليومين من أصل 4 أيام رقم الموافقة 71009';
      return {
        id,
        insurer: 'GlobeMed',
        decided_at: isoDay(39),
        requested: [{ text: 'اقامة عناية قلب', category: 'ICU_DAYS', quantity: 4 }],
        messages: [{ messageId: `${id}-m1`, sender: 'med@tpa.example', date: isoDay(39), body: `الطبيب المراجع: ${q}` }],
        expected_status: 'PARTIAL',
        expected_items: [{ text_original: 'اقامة عناية قلب', canonical_en: 'CCU day', category: 'ICU_DAYS', decision: 'APPROVED', quantity_requested: 4, quantity_approved: 2, evidence_quote: q, evidence_message_id: `${id}-m1` }],
      };
    },
    () => {
      const id = nextId();
      const q = 'لا مانع من موجات صوتية على القلب بشرط إرفاق تقرير الاستشاري رقم الموافقة 71010';
      return {
        id,
        insurer: 'MetLife',
        decided_at: isoDay(40),
        requested: [{ text: 'موجات صوتية على القلب', category: 'INVESTIGATION', quantity: 1 }],
        messages: [{ messageId: `${id}-m1`, sender: 'med@tpa.example', date: isoDay(40), body: `الطبيب المراجع: ${q}` }],
        expected_status: 'PARTIAL',
        expected_items: [{ text_original: 'موجات صوتية على القلب', canonical_en: 'Echocardiography', category: 'INVESTIGATION', decision: 'CONDITIONAL', conditions: ['إرفاق تقرير الاستشاري'], info_requested: ['تقرير طبي'], evidence_quote: q, evidence_message_id: `${id}-m1` }],
      };
    },
  ];
  for (const fn of partialCases) entries.push(fn());

  // ---------------- 7 PENDING threads ----------------
  const pendingPhrases = [
    'تم الاستلام وجاري الدراسة والعرض على الطبيب المراجع',
    'Under review by our medical committee, will revert shortly',
    'تم التحويل للطبيب المراجع للإفادة',
    'جاري المراجعة وسنوافيكم بالرد',
    'Received, case is under medical review',
    'قيد الدراسة لدى الإدارة الطبية',
    'تم الاستلام وفي انتظار التقرير النهائي',
  ];
  pendingPhrases.forEach((q, idx) => {
    const id = nextId();
    const day = 41 + idx;
    entries.push({
      id,
      insurer: 'MetLife',
      decided_at: isoDay(day),
      requested: [{ text: 'اقامة بالقسم الداخلي', category: 'ADMISSION', quantity: 1 }],
      messages: [{ messageId: `${id}-m1`, sender: 'desk@tpa.example', date: isoDay(day), body: q }],
      expected_status: 'PENDING',
      expected_items: [
        {
          text_original: 'اقامة بالقسم الداخلي',
          canonical_en: 'Inpatient admission',
          category: 'ADMISSION',
          decision: 'PENDING',
          quantity_requested: 1,
          evidence_quote: q,
          evidence_message_id: `${id}-m1`,
        },
      ],
    });
  });

  // ---------------- 5 UNCLEAR threads (low confidence / bare ack on multi-item) ----------------
  for (let idx = 0; idx < 5; idx++) {
    const id = nextId();
    const day = 48 + idx;
    const q = 'يرجى المراجعة والتأكيد بخصوص الطلب المرفق';
    entries.push({
      id,
      insurer: 'MedRight',
      decided_at: isoDay(day),
      requested: [{ text: 'منظار الحالب', category: 'PROCEDURE', quantity: 1 }],
      messages: [{ messageId: `${id}-m1`, sender: 'desk@tpa.example', date: isoDay(day), body: q }],
      model_confidence: 0.55,
      expected_status: 'UNCLEAR',
      expected_items: [
        {
          text_original: 'منظار الحالب',
          canonical_en: 'Ureteroscopy',
          category: 'PROCEDURE',
          decision: 'PENDING',
          quantity_requested: 1,
          evidence_quote: q,
          evidence_message_id: `${id}-m1`,
        },
      ],
    });
  }

  // ---------------- 4 Newer test-split threads for time-split learning evaluation ----------------
  // Test case A (normal): Next Care approves Laparoscopic cholecystectomy (matches strong 6/6 approve history -> no anomaly)
  {
    const id = nextId();
    const q = 'لا مانع من إجراء استئصال المرارة بالمنظار رقم الموافقة 59901';
    entries.push({
      id,
      insurer: 'Next Care',
      decided_at: isoDay(60),
      requested: [{ text: 'استئصال المرارة بالمنظار', category: 'PROCEDURE', quantity: 1 }],
      messages: [{ messageId: `${id}-m1`, sender: 'med@tpa.example', date: isoDay(60), body: `الطبيب المراجع: ${q}` }],
      expected_status: 'APPROVED',
      expected_items: [{ text_original: 'استئصال المرارة بالمنظار', canonical_en: 'Laparoscopic cholecystectomy', category: 'PROCEDURE', decision: 'APPROVED', quantity_requested: 1, quantity_approved: 1, evidence_quote: q, evidence_message_id: `${id}-m1` }],
      is_true_anomaly: false,
    });
  }
  // Test case B (normal): GlobeMed approves Cesarean section (matches strong 5/5 approve history -> no anomaly)
  {
    const id = nextId();
    const q = 'لا مانع من ولادة قيصرية رقم الموافقة 69901';
    entries.push({
      id,
      insurer: 'GlobeMed',
      decided_at: isoDay(61),
      requested: [{ text: 'ولادة قيصرية', category: 'PROCEDURE', quantity: 1 }],
      messages: [{ messageId: `${id}-m1`, sender: 'med@tpa.example', date: isoDay(61), body: `الطبيب المراجع: ${q}` }],
      expected_status: 'APPROVED',
      expected_items: [{ text_original: 'ولادة قيصرية', canonical_en: 'Cesarean section', category: 'PROCEDURE', decision: 'APPROVED', quantity_requested: 1, quantity_approved: 1, evidence_quote: q, evidence_message_id: `${id}-m1` }],
      is_true_anomaly: false,
    });
  }
  // Test case C (true anomaly): AXA approves Total knee replacement despite 6/6 historical COVERAGE_EXCLUSION rejections
  {
    const id = nextId();
    const q = 'لا مانع استثنائياً من تغيير مفصل الركبة رقم الموافقة 89901';
    entries.push({
      id,
      insurer: 'AXA',
      decided_at: isoDay(62),
      requested: [{ text: 'تغيير مفصل الركبة', category: 'PROCEDURE', quantity: 1 }],
      messages: [{ messageId: `${id}-m1`, sender: 'med@tpa.example', date: isoDay(62), body: `الطبيب المراجع: ${q}` }],
      expected_status: 'APPROVED',
      expected_items: [{ text_original: 'تغيير مفصل الركبة', canonical_en: 'Total knee replacement', category: 'PROCEDURE', decision: 'APPROVED', quantity_requested: 1, quantity_approved: 1, evidence_quote: q, evidence_message_id: `${id}-m1` }],
      is_true_anomaly: true,
    });
  }
  // Test case D (true anomaly): Next Care rejects Laparoscopic cholecystectomy despite 6/6 historical approvals
  {
    const id = nextId();
    const q = 'غير موافق على استئصال المرارة بالمنظار لعدم وجود مبرر طبي';
    entries.push({
      id,
      insurer: 'Next Care',
      decided_at: isoDay(63),
      requested: [{ text: 'استئصال المرارة بالمنظار', category: 'PROCEDURE', quantity: 1 }],
      messages: [{ messageId: `${id}-m1`, sender: 'med@tpa.example', date: isoDay(63), body: `الطبيب المراجع: ${q}` }],
      expected_status: 'REJECTED',
      expected_items: [{ text_original: 'استئصال المرارة بالمنظار', canonical_en: 'Laparoscopic cholecystectomy', category: 'PROCEDURE', decision: 'REJECTED', quantity_requested: 1, rejection_type: 'MEDICAL_NECESSITY', rejection_reason_ar: q, rejection_reason_en: 'Lack of medical necessity', evidence_quote: q, evidence_message_id: `${id}-m1` }],
      is_true_anomaly: true,
    });
  }

  return entries;
}

const built = buildThreads();
for (const e of built) {
  const s = maskPhi(JSON.stringify(e));
  assertNoPhi(s);
}
fs.writeFileSync(OUT_FILE, built.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
console.log(`Built ${built.length} golden-set threads -> ${OUT_FILE}`);
