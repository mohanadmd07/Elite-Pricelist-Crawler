---
name: approval-reply-classifier
description: Medical-aware, self-learning classifier for insurer/TPA email replies (Arabic, English, Franco-Arabic, mixed) to inpatient approval requests. Builds a per-item decision ledger, verifies it, prices items from the insurer's contractor pricelist (falling back to the 2026 hospital list as "موافقة سعرية"), drafts English price-approval requests to Corporate Sales, learns each insurer's approval/rejection patterns from finalized mails as advisory history, and updates the approvals DB. Use when ingesting, re-processing, or backfilling approval mail threads.
---

# Approval Reply Classifier

## Phase 0 (mandatory before any change)
Inspect the app (mail ingestion, DB schema, Gemini helpers, pricelist tables, insurer-to-pricelist mapping, outbound channel, recipients, historical threads, how outcomes get confirmed). Report findings and a plan first. Apply changes additively.

## Statuses
APPROVED | PARTIAL | REJECTED | PENDING | UNCLEAR

## Pipeline
1. Thread reconstruction: messages, speaker roles, new vs quoted content, inline replies, attachments/OCR, auto-reply filtering.
2. Per-item decision ledger (Gemini, temperature 0, JSON schema). Thread status derives from the ledger. Few-shot examples give phrasing only; no statistics are passed.
3. Verifier pass (second Gemini call); disagreement → human review.
4. Coverage matching: glossary normalization, top-5 candidates from the contractor pricelist, Gemini adjudicates among candidates only, code decides COVERED / NEEDS_REVIEW / NOT_COVERED, package-inclusion check.
5. Resolve prices in code: contractor pricelist first; if not found, 2026 hospital pricelist (gross, no discounts) labeled موافقة سعرية. Draft to Corporate Sales covers only those items.
6. Scope and quantity separation.
7. History check: advisory hints and anomaly flags from learned stats; never changes a decision.
8. Validate, write to DB, notify with price table and historical pattern.
9. After finalization or human correction: record an anonymized outcome, update stats, propose learned rules.

## Decision rules
- APPROVED only if every item is approved, nothing is outstanding, and no NOT_COVERED/NEEDS_REVIEW/NOT_FOUND item exists.
- Conditions or any request for info/documents → PARTIAL with each item and exact question.
- Rejection → REJECTED with exact reason (Arabic verbatim + English) and rejection_type.
- confidence < 0.80 → UNCLEAR + human review. Never auto-approve UNCLEAR. Never overwrite a human-set status.
- Admission ≠ procedure ≠ implant ≠ medication ≠ ICU days. Quantities are exact.
- Acknowledgements and "under review" are PENDING, not decisions.
- Pricing: contractor price as stored; else 2026 gross price labeled موافقة سعرية; else NOT_FOUND. Never model-generated, never discounted or rounded. NEEDS_REVIEW is never auto-priced.
- Amount cap exceeded by resolved total → PARTIAL with the gap.
- Recipient is always the internal Corporate Sales Department; block non-hospital domains/groups.
- Drafts are English; each price-approval line labeled موافقة سعرية; procedure names in English and Arabic.
- Store evidence quote (original language) and message ID for every decision.

## Learning rules
- Learn only from finalized or human-confirmed outcomes; exclude PENDING/UNCLEAR/unresolved review.
- Human corrections override auto labels.
- Store anonymized outcomes only (no patient identifiers); mask few-shot examples.
- Per insurer; minimum 5 outcomes before showing percentages; recency-weighted; flag possible policy changes.
- History is advisory: it can flag anomalies for review but never changes a status, price, or coverage result.
- Learned rules (phrases, aliases, document requirements, pricelist suggestions) are PROPOSED until I approve them; only APPROVED rules apply; any promotion must pass the golden set.
- Pricelist suggestions go to Corporate Sales as suggestions only; pricelists are never auto-modified.
- Resources: resources/*, scripts/*, eval/golden-set.jsonl.

## Gemini system prompt (ledger pass)
You are a clinical-aware analyst of insurer/TPA emails about hospital inpatient approvals at an Egyptian hospital. Emails may be Arabic (MSA or Egyptian dialect), English, Franco-Arabic, or mixed, and may contain medical abbreviations. Reconstruct the thread chronologically and identify each speaker's role. Use only new content; ignore quoted history unless an inline reply answers it. Decide per item (admission, procedure, implant, medication, investigation, ICU days, room class), never only per thread. Pay attention to negation, conditions, quantities, validity, amount caps, co-payment, and who is authorized to decide. Acknowledgements and "under review" are not decisions. Use correct medical terminology; normalize each item to its canonical English term but keep the original text. Do not map items to prices or pricelist entries. Do not output prices. Do not invent facts. Quote evidence exactly in the original language. If unsure, lower confidence and set needs_human_review. Return JSON only, matching the schema.

## Response schema
{
  "type": "object",
  "properties": {
    "thread_status": {"type":"string","enum":["APPROVED","PARTIAL","REJECTED","PENDING","UNCLEAR"]},
    "approval_reference": {"type":"string","nullable":true},
    "messages": {"type":"array","items":{"type":"object","properties":{
      "message_id":{"type":"string"},
      "speaker_role":{"type":"string","enum":["INSURER_MEDICAL_REVIEWER","INSURER_ADMIN","HOSPITAL","CORPORATE_SALES","AUTO_REPLY","UNKNOWN"]},
      "contains_decision":{"type":"boolean"}
    },"required":["message_id","speaker_role","contains_decision"]}},
    "items": {"type":"array","items":{"type":"object","properties":{
      "category":{"type":"string","enum":["ADMISSION","PROCEDURE","IMPLANT_DEVICE","MEDICATION","INVESTIGATION","ICU_DAYS","ROOM_CLASS","CONSULTATION","OTHER"]},
      "text_original":{"type":"string"},
      "canonical_en":{"type":"string","nullable":true},
      "decision":{"type":"string","enum":["APPROVED","CONDITIONAL","REJECTED","INFO_REQUESTED","PENDING","NOT_ADDRESSED"]},
      "quantity_requested":{"type":"number","nullable":true},
      "quantity_approved":{"type":"number","nullable":true},
      "conditions":{"type":"array","items":{"type":"string"}},
      "info_requested":{"type":"array","items":{"type":"string"}},
      "rejection_type":{"type":"string","enum":["MEDICAL_NECESSITY","COVERAGE_EXCLUSION","LIMIT_EXCEEDED","WAITING_PERIOD","PRE_EXISTING","NOT_PREAUTHORIZED","POLICY_EXPIRED","WRONG_PROVIDER","OTHER"],"nullable":true},
      "rejection_reason_ar":{"type":"string","nullable":true},
      "rejection_reason_en":{"type":"string","nullable":true},
      "validity_until":{"type":"string","nullable":true},
      "amount_cap":{"type":"number","nullable":true},
      "copay_percent":{"type":"number","nullable":true},
      "evidence_quote":{"type":"string"},
      "evidence_message_id":{"type":"string"}
    },"required":["category","text_original","decision","evidence_quote","evidence_message_id"]}},
    "confidence":{"type":"number"},
    "needs_human_review":{"type":"boolean"},
    "review_reasons":{"type":"array","items":{"type":"string"}}
  },
  "required":["thread_status","items","confidence","needs_human_review"]
}
