-- Rollback for 20261028000000_approval_reply_classifier.sql
-- Safe: the legacy pipeline never reads these objects.
-- NOTE: the outbox trigger function is restored to the 20261027000001 definition
-- (re-run that migration's CREATE OR REPLACE after this script).

DROP TABLE IF EXISTS public.backfill_results;
DROP TABLE IF EXISTS public.classifier_llm_log;
DROP TABLE IF EXISTS public.classifier_audit_log;
DROP TABLE IF EXISTS public.few_shot_pool;
DROP TABLE IF EXISTS public.learned_rules;
DROP TABLE IF EXISTS public.insurer_procedure_stats;
DROP TABLE IF EXISTS public.approval_outcomes;
DROP TABLE IF EXISTS public.classification_corrections;
DROP TABLE IF EXISTS public.contractor_pricelist_map;

DROP INDEX IF EXISTS public.idx_approvals_classified_source;
DROP INDEX IF EXISTS public.idx_approvals_classifier_status;

ALTER TABLE public.inpatient_approvals
    DROP COLUMN IF EXISTS classifier_status,
    DROP COLUMN IF EXISTS status_locked_by_human,
    DROP COLUMN IF EXISTS items_json,
    DROP COLUMN IF EXISTS requested_items,
    DROP COLUMN IF EXISTS rejection_reason_ar,
    DROP COLUMN IF EXISTS rejection_reason_en,
    DROP COLUMN IF EXISTS rejection_type,
    DROP COLUMN IF EXISTS evidence_quote,
    DROP COLUMN IF EXISTS confidence,
    DROP COLUMN IF EXISTS needs_human_review,
    DROP COLUMN IF EXISTS review_reasons,
    DROP COLUMN IF EXISTS classified_at,
    DROP COLUMN IF EXISTS source_message_id,
    DROP COLUMN IF EXISTS model_version,
    DROP COLUMN IF EXISTS coverage_results_json,
    DROP COLUMN IF EXISTS priced_items_json,
    DROP COLUMN IF EXISTS history_hints_json,
    DROP COLUMN IF EXISTS contractor_pricelist_id,
    DROP COLUMN IF EXISTS contract_total,
    DROP COLUMN IF EXISTS price_approval_total,
    DROP COLUMN IF EXISTS price_approval_required,
    DROP COLUMN IF EXISTS price_approval_draft_en,
    DROP COLUMN IF EXISTS price_approval_status,
    DROP COLUMN IF EXISTS price_approval_sent_to,
    DROP COLUMN IF EXISTS price_approval_sent_at,
    DROP COLUMN IF EXISTS approval_reference;
