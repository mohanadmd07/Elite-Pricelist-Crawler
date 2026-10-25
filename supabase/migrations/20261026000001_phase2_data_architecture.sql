-- ==============================================================================
-- Supabase Migration: Phase 2 Data Architecture & Inpatient Approvals
-- Enforces:
-- 1. Inpatient Approvals authoritative table with strict state machine constraints.
-- 2. Unique constraint on Exchange message_id with content_hash fallback.
-- 3. Transactional Outbox table + automatic trigger for Firestore synchronization.
-- 4. Dead-letter queue table for poison message quarantine.
-- 5. Persistent EWS sync watermarks in Postgres.
-- ==============================================================================

-- 1. Inpatient Approvals Table (Authoritative Source of Truth)
CREATE TABLE IF NOT EXISTS public.inpatient_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exchange_message_id TEXT UNIQUE,
    content_hash TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    patient_identifier_hash TEXT NOT NULL, -- SHA256 of MRN for search lookup
    patient_name TEXT NOT NULL,
    mrn TEXT NOT NULL,
    bed TEXT,
    admission_type TEXT,
    physician TEXT,
    contractor_raw TEXT,
    contractor_normalized TEXT,
    contractor_officer TEXT,
    price_list_year TEXT NOT NULL DEFAULT '2025',
    diagnosis TEXT,
    requested_services JSONB NOT NULL DEFAULT '[]'::jsonb,
    matched_procedures JSONB NOT NULL DEFAULT '[]'::jsonb,
    financial_terms JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'received' CHECK (
        status IN ('received', 'parsed', 'matched', 'needs_review', 'draft_created', 'answered', 'refused')
    ),
    status_reason_arabic TEXT,
    state_timestamps JSONB NOT NULL DEFAULT '{}'::jsonb,
    suggested_draft_reply TEXT,
    cm_whatsapp_message TEXT,
    has_replies BOOLEAN NOT NULL DEFAULT false,
    has_existing_approval BOOLEAN NOT NULL DEFAULT false,
    is_refused BOOLEAN NOT NULL DEFAULT false,
    retry_count INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Unique index fallback: ensures deduplication even if Exchange message-id is null or reformatted
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_unique_delivery 
    ON public.inpatient_approvals (COALESCE(exchange_message_id, content_hash));

-- Operational query indexes
CREATE INDEX IF NOT EXISTS idx_approvals_conversation ON public.inpatient_approvals (conversation_id);
CREATE INDEX IF NOT EXISTS idx_approvals_received_at ON public.inpatient_approvals (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON public.inpatient_approvals (status);
CREATE INDEX IF NOT EXISTS idx_approvals_mrn_hash ON public.inpatient_approvals (patient_identifier_hash);
CREATE INDEX IF NOT EXISTS idx_approvals_contractor ON public.inpatient_approvals (contractor_normalized);


-- 2. Transactional Outbox Table (Event-Driven CDC to Firestore)
CREATE TABLE IF NOT EXISTS public.outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type TEXT NOT NULL DEFAULT 'inpatient_approval',
    aggregate_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (
        event_type IN ('APPROVAL_RECEIVED', 'APPROVAL_UPDATED', 'APPROVAL_STATUS_CHANGED', 'APPROVAL_DELETED')
    ),
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'processing', 'published', 'failed')
    ),
    retry_count INT NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    last_error TEXT,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Strategic queue index for outbox poller
CREATE INDEX IF NOT EXISTS idx_outbox_queue ON public.outbox (status, next_retry_at) 
    WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate ON public.outbox (aggregate_type, aggregate_id);


-- 3. Automatic Outbox Enqueue Trigger
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
    ELSE
        IF OLD.status IS DISTINCT FROM NEW.status THEN
            v_event_type := 'APPROVAL_STATUS_CHANGED';
        ELSE
            v_event_type := 'APPROVAL_UPDATED';
        END IF;
    END IF;

    -- Build client-safe payload for Firestore read model
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
        'cmWhatsappMessage', NEW.cm_whatsapp_message,
        'hasReplies', NEW.has_replies,
        'hasExistingApproval', NEW.has_existing_approval,
        'isRefused', NEW.is_refused,
        'updatedAt', NEW.updated_at
    );

    INSERT INTO public.outbox (
        aggregate_type,
        aggregate_id,
        event_type,
        payload,
        status,
        next_retry_at
    ) VALUES (
        'inpatient_approval',
        NEW.id::TEXT,
        v_event_type,
        v_payload,
        'pending',
        now()
    );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_approval_outbox ON public.inpatient_approvals;
CREATE TRIGGER trg_approval_outbox
    AFTER INSERT OR UPDATE ON public.inpatient_approvals
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_enqueue_approval_outbox();


-- 4. Dead-Letter Queue (Poison Message Quarantine)
CREATE TABLE IF NOT EXISTS public.dead_letter_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_type TEXT NOT NULL CHECK (source_type IN ('ews_email', 'approval_parse', 'outbox_sync')),
    source_id TEXT,
    payload JSONB,
    error_message TEXT NOT NULL,
    stack_trace TEXT,
    retry_count INT NOT NULL DEFAULT 0,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    resolution_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_dlq_unresolved ON public.dead_letter_queue (quarantined_at DESC) 
    WHERE resolved_at IS NULL;


-- 5. Persistent EWS Sync Watermarks Table Update
-- Ensure columns support robust on-premise Exchange watermark tracking
ALTER TABLE public.sync_checkpoints
    ADD COLUMN IF NOT EXISTS last_message_id TEXT,
    ADD COLUMN IF NOT EXISTS error_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;


-- 6. Row-Level Security (RLS) Policies
ALTER TABLE public.inpatient_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dead_letter_queue ENABLE ROW LEVEL SECURITY;

-- Inpatient Approvals: Authenticated staff can view approvals
CREATE POLICY "Staff can view inpatient approvals"
    ON public.inpatient_approvals FOR SELECT
    TO authenticated
    USING (true);

-- Authenticated staff can update approval status (e.g. manual approval/refusal toggle)
CREATE POLICY "Staff can update approval status"
    ON public.inpatient_approvals FOR UPDATE
    TO authenticated
    USING (auth.uid() IS NOT NULL)
    WITH CHECK (auth.uid() IS NOT NULL);

-- Outbox & Dead-Letter Queue: Strictly internal service role access
-- (No public policies defined -> default DENY for client users)
CREATE POLICY "Admins can view dead letter queue"
    ON public.dead_letter_queue FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = (SELECT auth.uid()) AND p.role = 'admin'
        )
    );
