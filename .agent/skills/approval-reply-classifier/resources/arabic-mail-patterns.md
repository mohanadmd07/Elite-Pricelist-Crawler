# Arabic, English & Franco-Arabic Mail Context Rules

This document codifies the mail-context rules used by the `approval-reply-classifier` skill and enforced deterministically in `src/classifier/patterns.ts` and `src/classifier/ledger.ts`.

## 1. Negation & Idioms (Never Confuse "لا مانع" with Negation)

| Phrase / Pattern | Meaning | Classifier Decision |
|---|---|---|
| `لا مانع` / `لا يوجد مانع` / `تمت الموافقة` / `موافق` / `تم الاعتماد` / `No objection` / `Approved` | Explicit approval | `APPROVED` |
| `لا مانع بشرط ...` / `موافقة مشروطة` / `بشرط إرسال ...` / `Approved subject to ...` | Conditional approval | `CONDITIONAL` (thread status `PARTIAL`) |
| `غير موافق` / `عدم الموافقة` / `لا يمكن الموافقة` / `مرفوض` / `نعتذر عن عدم تغطية` / `خارج التغطية` / `Declined` / `Not covered` | Explicit rejection | `REJECTED` |
| `تمام` / `ماشي` / `OK` / `تم` (without item name or approval reference) | Bare acknowledgement | `APPROVED` **only** if the immediately quoted request is a single unambiguous item; otherwise `UNCLEAR` + `needs_human_review = true` |

## 2. Acknowledgement ≠ Decision

The following phrases indicate receipt or in-progress review and must **never** be classified as `APPROVED` or `REJECTED`:

- `تم الاستلام` / `جاري الدراسة` / `جاري المراجعة` / `تحت الدراسة`
- `تم التحويل للطبيب المراجع` / `قيد المراجعة` / `سيتم الرد` / `سنوافيكم بالرد`
- `Received` / `Under review` / `Will revert` / `In process`
- Any automatic reply (`Out of Office`, `Automatic reply`, `رد تلقائي`, `إجازة سنوية`) → speaker role `AUTO_REPLY`, ignored for decisions.

## 3. Approval Metadata Extraction

Whenever present in an insurer message or attached approval letter, capture:
- **Approval Reference** (`approval_reference`): e.g. `رقم الموافقة: ٩٨٧٦٥` (normalized to ASCII `98765`), `Auth #AX-2026-441`.
- **Validity / Expiry** (`validity_until`): e.g. `صالحة لمدة 7 أيام`, `valid until 2026-11-05`.
- **Amount Cap** (`amount_cap`): e.g. `بحد أقصى 15,000 ج.م`, `up to EGP 25,000`.
- **Co-payment %** (`copay_percent`): e.g. `نسبة تحمل المريض 10%`, `co-pay 20%`.
- **Approved LOS / Quantity** (`quantity_approved` vs `quantity_requested`): e.g. `الموافقة على 3 أيام رعاية من أصل 5 أيام` → `quantity_approved = 3`, `quantity_requested = 5` (`PARTIAL`).

## 4. Speaker Authority & Provenance

- Decisions from `HOSPITAL` or `CORPORATE_SALES` (including internal Patient Accounts instructions such as Mohamed Fekry's "مطلوب موافقة سعرية") are **never** insurer approvals.
- A decision from `INSURER_ADMIN` that lacks medical-review language (`الطبيب المراجع`, `المراجع الطبي`, `اللجنة الطبية`, `Medical Review`) **and** lacks an approval reference sets `needs_human_review = true`.
- Evidence quotes must appear in the author's **new content** or **attachment OCR text**. A quote found only in quoted history (`> ...` or below `From:/Sent:`) is downgraded to `PENDING` with `DECISION_IN_QUOTED_TEXT_ONLY`.

## 5. Conflicts & Revisions

- **Chronological revision**: A later insurer message overrides an earlier insurer message **only for the same item** (e.g. initial rejection of `Laparoscopic cholecystectomy` followed by approval after medical report submission → `APPROVED`).
- **Same-message / body-vs-attachment conflict**: If the email body and the attached PDF letter (or two clauses in the same message) disagree on the same item, status is `UNCLEAR`, `needs_human_review = true`, and both quotes are surfaced.

## 6. Ask-Back Detection (Info / Document Requests)

When the insurer asks for clinical information or documents before deciding, record `decision = INFO_REQUESTED` (or `CONDITIONAL` if paired with conditional approval), thread status `PARTIAL`, and populate `info_requested` with the exact question/document:
- Medical report (`تقرير طبي مفصل`)
- Diagnosis / ICD-10 code (`كود التشخيص ICD-10`)
- Clinical indication (`دواعي الإجراء / المبرر الطبي`)
- Investigation / imaging results (`نتيجة الأشعة / التحاليل`)
- Duration of symptoms / prior treatment (`مدة الأعراض`)

## 7. Rejection Types (`rejection_type`)

Separate medical necessity from administrative/policy causes:
- `MEDICAL_NECESSITY`: `عدم وجود مبرر طبي كافٍ`, `لا تستدعي الحالة التدخل الجراحي حالياً`
- `COVERAGE_EXCLUSION`: `خارج التغطية التأمينية`, `البند مستثنى من الوثيقة`
- `LIMIT_EXCEEDED`: `تجاوز الحد الأقصى للتغطية السنوية`
- `WAITING_PERIOD`: `فترة الانتظار لم تنقضِ`
- `PRE_EXISTING`: `حالة سابقة على التعاقد (Pre-existing condition)`
- `NOT_PREAUTHORIZED`: `لم يتم الحصول على موافقة مسبقة`
- `POLICY_EXPIRED`: `الوثيقة منتهية / غير سارية`
- `WRONG_PROVIDER`: `المستشفى خارج الشبكة الطبية لهذه الفئة`
- `OTHER`: any other explicit rejection reason

## 8. Approved Learned Phrasing Rules

*(Approved `PHRASE` rules promoted via the golden-set gate are appended below through reviewed changes only.)*
