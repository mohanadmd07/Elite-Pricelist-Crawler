-- ==============================================================================
-- Approval Reply Classifier: additive migration
-- * Nothing is dropped or altered. Existing `status` column is untouched; new
--   classifier results live in `classifier_status` and sibling columns.
-- * All statements are idempotent (IF NOT EXISTS).
-- * Rollback: supabase/rollbacks/20261028000000_approval_reply_classifier.down.sql (kept outside migrations/ so it never auto-runs)
-- ==============================================================================

-- 1. inpatient_approvals: classifier columns ------------------------------------
ALTER TABLE public.inpatient_approvals
    ADD COLUMN IF NOT EXISTS classifier_status TEXT
        CHECK (classifier_status IS NULL OR classifier_status IN ('APPROVED','PARTIAL','REJECTED','PENDING','UNCLEAR')),
    ADD COLUMN IF NOT EXISTS status_locked_by_human BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS items_json JSONB,
    ADD COLUMN IF NOT EXISTS requested_items JSONB,
    ADD COLUMN IF NOT EXISTS rejection_reason_ar TEXT,
    ADD COLUMN IF NOT EXISTS rejection_reason_en TEXT,
    ADD COLUMN IF NOT EXISTS rejection_type TEXT,
    ADD COLUMN IF NOT EXISTS evidence_quote TEXT,
    ADD COLUMN IF NOT EXISTS confidence NUMERIC(4,3),
    ADD COLUMN IF NOT EXISTS needs_human_review BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS review_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS classified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS source_message_id TEXT,
    ADD COLUMN IF NOT EXISTS model_version TEXT,
    ADD COLUMN IF NOT EXISTS coverage_results_json JSONB,
    ADD COLUMN IF NOT EXISTS priced_items_json JSONB,
    ADD COLUMN IF NOT EXISTS history_hints_json JSONB,
    ADD COLUMN IF NOT EXISTS contractor_pricelist_id UUID,
    ADD COLUMN IF NOT EXISTS contract_total NUMERIC(14,4),
    ADD COLUMN IF NOT EXISTS price_approval_total NUMERIC(14,4),
    ADD COLUMN IF NOT EXISTS price_approval_required BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS price_approval_draft_en TEXT,
    ADD COLUMN IF NOT EXISTS price_approval_status TEXT
        CHECK (price_approval_status IS NULL OR price_approval_status IN ('DRAFT','SENT','APPROVED','REFUSED')),
    ADD COLUMN IF NOT EXISTS price_approval_sent_to TEXT,
    ADD COLUMN IF NOT EXISTS price_approval_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS approval_reference TEXT;

-- Idempotency: one classification per (approval, source message)
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_classified_source
    ON public.inpatient_approvals (id, source_message_id)
    WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_approvals_classifier_status ON public.inpatient_approvals (classifier_status);

-- 2. contractor_pricelist_map --------------------------------------------------
-- Maps an insurer (companies.id) to the hospital master pricelist that is its
-- contract list, plus its contract discount. Falls back to companies/contractors.json
-- (priceListYear + discountPercentage) when no row exists.
CREATE TABLE IF NOT EXISTS public.contractor_pricelist_map (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    insurer_id TEXT NOT NULL,
    pricelist_id UUID NOT NULL REFERENCES public.pricelists(id) ON DELETE RESTRICT,
    discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
    valid_from DATE,
    valid_to DATE,
    source TEXT NOT NULL DEFAULT 'contractors.json',
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_cpm_insurer ON public.contractor_pricelist_map (insurer_id, valid_from DESC);

-- 3. classification_corrections (human edits feed learning) ---------------------
CREATE TABLE IF NOT EXISTS public.classification_corrections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    approval_id UUID NOT NULL,
    field TEXT NOT NULL,
    model_value TEXT,
    human_value TEXT,
    note TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_corrections_approval ON public.classification_corrections (approval_id, created_at DESC);

-- 4. approval_outcomes (anonymized; NO patient identifiers, NO free-text quotes) -
CREATE TABLE IF NOT EXISTS public.approval_outcomes (
    id TEXT PRIMARY KEY,                       -- sha256(source_approval_hash | canonical_procedure)
    insurer_id TEXT NOT NULL,
    canonical_procedure TEXT NOT NULL,
    category TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approved','conditional','rejected')),
    rejection_type TEXT,
    conditions TEXT[] NOT NULL DEFAULT '{}',   -- controlled vocabulary codes only
    info_requested TEXT[] NOT NULL DEFAULT '{}',-- controlled vocabulary codes only
    quantity_requested NUMERIC,
    quantity_approved NUMERIC,
    amount_cap NUMERIC,
    copay_percent NUMERIC,
    validity_days INT,
    decided_at TIMESTAMPTZ NOT NULL,
    turnaround_hours NUMERIC,
    label_source TEXT NOT NULL CHECK (label_source IN ('HUMAN_CONFIRMED','AUTO_VERIFIED')),
    source_approval_hash TEXT NOT NULL,        -- one-way salted hash of source_message_id
    contract_missing BOOLEAN NOT NULL DEFAULT false, -- approved item absent from the contract list
    observed_alias TEXT,                       -- scrubbed clinical term, for alias proposals
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_outcomes_lookup ON public.approval_outcomes (insurer_id, canonical_procedure, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_source ON public.approval_outcomes (source_approval_hash);

-- 5. insurer_procedure_stats ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.insurer_procedure_stats (
    insurer_id TEXT NOT NULL,
    canonical_procedure TEXT NOT NULL,
    n INT NOT NULL,
    approved_n INT NOT NULL,
    conditional_n INT NOT NULL,
    rejected_n INT NOT NULL,
    rejection_type_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
    top_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
    top_info_requested JSONB NOT NULL DEFAULT '[]'::jsonb,
    info_requested_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
    typical_approved_qty NUMERIC,
    weighted JSONB NOT NULL DEFAULT '{}'::jsonb,       -- recency/label-weighted shares
    recent_decisions JSONB NOT NULL DEFAULT '[]'::jsonb, -- newest-first, for drift
    last_decided_at TIMESTAMPTZ,
    window_months INT NOT NULL DEFAULT 24,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    PRIMARY KEY (insurer_id, canonical_procedure)
);

-- 6. learned_rules -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.learned_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    insurer_id TEXT,
    rule_key TEXT NOT NULL,                    -- stable key so proposals are not duplicated
    rule_text TEXT NOT NULL,
    rule_type TEXT NOT NULL CHECK (rule_type IN ('PHRASE','ALIAS','DOCUMENT_REQUIREMENT','PRICELIST_SUGGESTION','POLICY_NOTE')),
    evidence_count INT NOT NULL DEFAULT 0,
    example_hashes TEXT[] NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','APPROVED','REJECTED','RETIRED')),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    proposed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    decided_by TEXT,
    decided_at TIMESTAMPTZ,
    UNIQUE (insurer_id, rule_key)
);

-- 7. few_shot_pool (masked snippets with human-verified expected output) --------
CREATE TABLE IF NOT EXISTS public.few_shot_pool (
    id TEXT PRIMARY KEY,                       -- hash of masked snippet
    insurer_id TEXT NOT NULL,
    category TEXT NOT NULL,
    language TEXT,
    masked_snippet TEXT NOT NULL,
    expected_output JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_fewshot_lookup ON public.few_shot_pool (insurer_id, category);

-- 8. Audit tables --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.classifier_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action TEXT NOT NULL,                      -- PROMOTE_RULE | REJECT_RULE | RETIRE_RULE | FORGET_OUTCOME | PROMOTION_BLOCKED | LEARNING_ENABLED ...
    target_id TEXT,
    actor TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.classifier_llm_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    approval_ref TEXT,                         -- one-way hash only
    pass TEXT NOT NULL,
    model TEXT NOT NULL,
    masked_input TEXT NOT NULL,
    masked_output TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 9. Backfill shadow results (dry-run never touches live approvals) -------------
CREATE TABLE IF NOT EXISTS public.backfill_results (
    source_message_id TEXT PRIMARY KEY,        -- idempotency key
    insurer_id TEXT,
    result JSONB NOT NULL,
    reviewed_correct BOOLEAN,                  -- set during the 30-sample validation
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 10. RLS: service role only, except read access to anonymized stats ------------
ALTER TABLE public.contractor_pricelist_map     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classification_corrections   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_outcomes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insurer_procedure_stats      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learned_rules                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.few_shot_pool                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classifier_audit_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classifier_llm_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backfill_results             ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff read stats" ON public.insurer_procedure_stats;
CREATE POLICY "Staff read stats" ON public.insurer_procedure_stats
    FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Staff read rules" ON public.learned_rules;
CREATE POLICY "Staff read rules" ON public.learned_rules
    FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Staff add corrections" ON public.classification_corrections;
CREATE POLICY "Staff add corrections" ON public.classification_corrections
    FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);
-- No other policies: default DENY for clients; the service role bypasses RLS.

-- 11. Outbox payload: replicate classifier fields to the Firestore read model ---
-- (Additive: existing keys preserved; adds classifier keys.)
CREATE OR REPLACE FUNCTION public.fn_enqueue_approval_outbox()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_event_type TEXT;
    v_payload JSONB;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_event_type := 'APPROVAL_RECEIVED';
    ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
        v_event_type := 'APPROVAL_STATUS_CHANGED';
    ELSE
        v_event_type := 'APPROVAL_UPDATED';
    END IF;

    v_payload := jsonb_build_object(
        'id', NEW.id,
        'exchangeMessageId', NEW.exchange_message_id,
        'contentHash', NEW.content_hash,
        'conversationId', NEW.conversation_id,
        'receivedAt', NEW.received_at,
        'patientName', NEW.patient_name,
        'mrn', NEW.mrn,
        'bed', NEW.bed,
        'admissionType', NEW.admission_type,
        'physician', NEW.physician,
        'contractorRaw', NEW.contractor_raw,
        'contractorNormalized', NEW.contractor_normalized,
        'contractorOfficer', NEW.contractor_officer,
        'priceListYear', NEW.price_list_year,
        'diagnosis', NEW.diagnosis,
        'requestedServices', NEW.requested_services,
        'matchedProcedures', NEW.matched_procedures,
        'financialTerms', NEW.financial_terms,
        'status', NEW.status,
        'statusReasonArabic', NEW.status_reason_arabic,
        'stateTimestamps', NEW.state_timestamps,
        'suggestedDraftReply', NEW.suggested_draft_reply,
        'draftBody', NEW.suggested_draft_reply,
        'cmWhatsappMessage', NEW.cm_whatsapp_message,
        'hasReplies', NEW.has_replies,
        'hasExistingApproval', NEW.has_existing_approval,
        'isRefused', NEW.is_refused,
        'updatedAt', NEW.updated_at,
        -- classifier additions
        'classifierStatus', NEW.classifier_status,
        'needsHumanReview', NEW.needs_human_review,
        'reviewReasons', NEW.review_reasons,
        'priceApprovalRequired', NEW.price_approval_required,
        'priceApprovalStatus', NEW.price_approval_status,
        'pricedItems', NEW.priced_items_json,
        'historyHints', NEW.history_hints_json,
        'itemsLedger', NEW.items_json,
        'confidence', NEW.confidence
    );

    INSERT INTO public.outbox (aggregate_type, aggregate_id, event_type, payload)
    VALUES ('inpatient_approval', NEW.id, v_event_type, v_payload);
    RETURN NEW;
END;
$$;
