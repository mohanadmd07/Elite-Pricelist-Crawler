-- ==============================================================================
-- Supabase Migration: Staging Layer & Contractor Aliases Dictionary
-- Designed per /supabase and /nodejs-best-practices
-- ==============================================================================

-- 1. Raw Email Staging (Immutable Ingestion Log)
CREATE TABLE IF NOT EXISTS public.raw_email_staging (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ews_item_id TEXT NOT NULL UNIQUE,
    ews_change_key TEXT,
    conversation_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    subject TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    raw_html TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    retry_count INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Strategic indexes for queue processing and thread lookup
CREATE INDEX IF NOT EXISTS idx_raw_email_status ON public.raw_email_staging (status, retry_count);
CREATE INDEX IF NOT EXISTS idx_raw_email_conversation ON public.raw_email_staging (conversation_id);
CREATE INDEX IF NOT EXISTS idx_raw_email_received ON public.raw_email_staging (received_at DESC);

-- 2. Contractor Aliases Dictionary (100% Deterministic Resolution)
CREATE TABLE IF NOT EXISTS public.contractor_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alias_name TEXT NOT NULL UNIQUE,
    canonical_company_name TEXT NOT NULL,
    default_price_list_year SMALLINT NOT NULL DEFAULT 2025 CHECK (default_price_list_year BETWEEN 2020 AND 2035),
    assigned_officer TEXT NOT NULL,
    discount_percentage NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_contractor_alias_name ON public.contractor_aliases (alias_name);
CREATE INDEX IF NOT EXISTS idx_contractor_canonical_name ON public.contractor_aliases (canonical_company_name);

-- 3. Ingestion Sync Checkpoints (Exchange EWS Watermark)
CREATE TABLE IF NOT EXISTS public.sync_checkpoints (
    folder_name TEXT PRIMARY KEY,
    sync_state_token TEXT,
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    total_synced_count BIGINT NOT NULL DEFAULT 0
);

-- Enable RLS as required by /supabase
ALTER TABLE public.raw_email_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_checkpoints ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS automatically; create staff select policies
CREATE POLICY "Staff can view raw email staging"
    ON public.raw_email_staging FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Staff can view contractor aliases"
    ON public.contractor_aliases FOR SELECT
    TO authenticated
    USING (true);
