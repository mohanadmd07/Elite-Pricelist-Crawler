/**
 * Prompts and JSON schemas. The ledger system prompt and schema are mirrored verbatim in
 * .agent/skills/approval-reply-classifier/SKILL.md (a test asserts they stay in sync).
 */
export const LEDGER_SYSTEM_PROMPT =
  'You are a clinical-aware analyst of insurer/TPA emails about hospital inpatient approvals at an Egyptian hospital. Emails may be Arabic (MSA or Egyptian dialect), English, Franco-Arabic, or mixed, and may contain medical abbreviations. Reconstruct the thread chronologically and identify each speaker\'s role. Use only new content; ignore quoted history unless an inline reply answers it. Decide per item (admission, procedure, implant, medication, investigation, ICU days, room class), never only per thread. Pay attention to negation, conditions, quantities, validity, amount caps, co-payment, and who is authorized to decide. Acknowledgements and "under review" are not decisions. Use correct medical terminology; normalize each item to its canonical English term but keep the original text. Do not map items to prices or pricelist entries. Do not output prices. Do not invent facts. Quote evidence exactly in the original language. If unsure, lower confidence and set needs_human_review. Return JSON only, matching the schema.';

export const VERIFIER_SYSTEM_PROMPT =
  'You are an independent verifier of a per-item decision ledger extracted from an insurer email thread at an Egyptian hospital (Arabic, English, Franco-Arabic or mixed). You receive the ORIGINAL thread and the LEDGER. Re-read the thread yourself and check: (1) negation errors ("لا مانع" = approved, "غير موافق"/"لا يمكن" = rejected, "لا مانع بشرط" = conditional); (2) items requested but missing from the ledger; (3) wrong override order (a later message overrides an earlier one only for the SAME item); (4) quantity mismatches (e.g. approved 3 of 5 days); (5) conditional approvals marked as full approvals; (6) acknowledgements ("تم الاستلام", "جاري الدراسة") wrongly treated as decisions; (7) decisions evidenced only by quoted history. Do not add prices. Return JSON only: {"verdict":"OK|CORRECTIONS","corrections":[{"item":"","issue":"","fix":""}]}. Use OK only when you find no problem.';

export const ADJUDICATOR_SYSTEM_PROMPT =
  'You are a clinical coding adjudicator at an Egyptian hospital. Given ONE requested medical item and a numbered list of CANDIDATE pricelist entries, choose which candidate (if any) is the same service. You may ONLY choose among the numbered candidates; never invent an entry. Classify: EXACT (same service), EQUIVALENT_SYNONYM (same service, different wording/language/abbreviation), BROADER (candidate covers more than requested), NARROWER (candidate covers less), DIFFERENT. A different approach (open vs laparoscopic/endoscopic), laterality (left/right/bilateral), with vs without contrast, anatomical site, or implant type is DIFFERENT. If no candidate fits, chosen_index is null and match_class is DIFFERENT. Give a one-line clinical rationale. Do not output prices. Return JSON only.';

export const OCR_SYSTEM_PROMPT =
  'Transcribe the attached insurer approval/rejection document exactly as written, preserving the original language (Arabic/English), numbers, reference numbers, dates, amounts, conditions and stamps. Do not summarize, translate or interpret. Return JSON {"text": "..."} only.';

const nullable = (type: string) => ({ type: [type, 'null'] });

export const LEDGER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    thread_status: { type: 'string', enum: ['APPROVED', 'PARTIAL', 'REJECTED', 'PENDING', 'UNCLEAR'] },
    approval_reference: nullable('string'),
    messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          speaker_role: { type: 'string', enum: ['INSURER_MEDICAL_REVIEWER', 'INSURER_ADMIN', 'HOSPITAL', 'CORPORATE_SALES', 'AUTO_REPLY', 'UNKNOWN'] },
          contains_decision: { type: 'boolean' },
        },
        required: ['message_id', 'speaker_role', 'contains_decision'],
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['ADMISSION', 'PROCEDURE', 'IMPLANT_DEVICE', 'MEDICATION', 'INVESTIGATION', 'ICU_DAYS', 'ROOM_CLASS', 'CONSULTATION', 'OTHER'] },
          text_original: { type: 'string' },
          canonical_en: nullable('string'),
          decision: { type: 'string', enum: ['APPROVED', 'CONDITIONAL', 'REJECTED', 'INFO_REQUESTED', 'PENDING', 'NOT_ADDRESSED'] },
          quantity_requested: nullable('number'),
          quantity_approved: nullable('number'),
          conditions: { type: 'array', items: { type: 'string' } },
          info_requested: { type: 'array', items: { type: 'string' } },
          rejection_type: {
            type: ['string', 'null'],
            enum: ['MEDICAL_NECESSITY', 'COVERAGE_EXCLUSION', 'LIMIT_EXCEEDED', 'WAITING_PERIOD', 'PRE_EXISTING', 'NOT_PREAUTHORIZED', 'POLICY_EXPIRED', 'WRONG_PROVIDER', 'OTHER', null],
          },
          rejection_reason_ar: nullable('string'),
          rejection_reason_en: nullable('string'),
          validity_until: nullable('string'),
          amount_cap: nullable('number'),
          copay_percent: nullable('number'),
          evidence_quote: { type: 'string' },
          evidence_message_id: { type: 'string' },
        },
        required: ['category', 'text_original', 'decision', 'evidence_quote', 'evidence_message_id'],
      },
    },
    confidence: { type: 'number' },
    needs_human_review: { type: 'boolean' },
    review_reasons: { type: 'array', items: { type: 'string' } },
  },
  required: ['thread_status', 'items', 'confidence', 'needs_human_review'],
} as const;

export const VERIFIER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['OK', 'CORRECTIONS'] },
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { item: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } },
        required: ['item', 'issue', 'fix'],
      },
    },
  },
  required: ['verdict', 'corrections'],
} as const;

export const ADJUDICATOR_JSON_SCHEMA = {
  type: 'object',
  properties: {
    chosen_index: nullable('integer'),
    match_class: { type: 'string', enum: ['EXACT', 'EQUIVALENT_SYNONYM', 'BROADER', 'NARROWER', 'DIFFERENT'] },
    rationale: { type: 'string' },
  },
  required: ['chosen_index', 'match_class', 'rationale'],
} as const;

export const OCR_JSON_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;
