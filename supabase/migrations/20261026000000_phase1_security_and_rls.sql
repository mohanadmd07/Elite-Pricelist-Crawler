-- ==============================================================================
-- Supabase Migration: Phase 1 Security, RLS Hardening & Audit Logging
-- Enforces:
-- 1. Explicit RLS on every table (service role for watcher, read-only for staff,
--    except explicit override tables).
-- 2. Revokes public/staff SELECT on raw_email_staging (contains raw PHI).
-- 3. Adds append-only public.audit_log table.
-- 4. Adds public.procedure_overrides table for clinician/staff overrides.
-- ==============================================================================

-- 1. Append-Only Audit Log
CREATE TABLE IF NOT EXISTS public.audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    user_email TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    previous_state JSONB,
    new_state JSONB,
    details JSONB DEFAULT '{}'::jsonb,
    ip_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_created ON public.audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON public.audit_log (entity_type, entity_id);

-- Enforce append-only semantics via RLS
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- Staff can insert audit records for their actions
CREATE POLICY "Staff can insert audit logs"
    ON public.audit_log FOR INSERT
    TO authenticated
    WITH CHECK (true);

-- Authenticated staff can read audit records
CREATE POLICY "Staff can view audit logs"
    ON public.audit_log FOR SELECT
    TO authenticated
    USING (true);

-- Disallow UPDATE and DELETE explicitly for all non-service roles
-- (No policies created for UPDATE / DELETE means default DENY)


-- 2. Procedure Matching Overrides Table
CREATE TABLE IF NOT EXISTS public.procedure_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query_text TEXT NOT NULL,
    query_text_normalized TEXT NOT NULL,
    chosen_procedure_id UUID REFERENCES public.procedures(id) ON DELETE CASCADE,
    chosen_code TEXT,
    chosen_name TEXT NOT NULL,
    contractor_name TEXT,
    overridden_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    overridden_by_email TEXT,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_overrides_norm_query ON public.procedure_overrides (query_text_normalized);
CREATE INDEX IF NOT EXISTS idx_overrides_code ON public.procedure_overrides (chosen_code);
CREATE INDEX IF NOT EXISTS idx_overrides_created ON public.procedure_overrides (created_at DESC);

ALTER TABLE public.procedure_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view procedure overrides"
    ON public.procedure_overrides FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Staff can insert procedure overrides"
    ON public.procedure_overrides FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Staff can update own procedure overrides"
    ON public.procedure_overrides FOR UPDATE
    TO authenticated
    USING (overridden_by = (SELECT auth.uid()))
    WITH CHECK (overridden_by = (SELECT auth.uid()));


-- 3. Hardening Raw Email Staging (PHI Protection)
-- Drop existing broad read policy on raw_email_staging if present
DROP POLICY IF EXISTS "Staff can view raw email staging" ON public.raw_email_staging;

-- Allow only admins to select from raw_email_staging; general staff denied
CREATE POLICY "Admins can view raw email staging"
    ON public.raw_email_staging FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = (SELECT auth.uid()) AND p.role = 'admin'
        )
    );


-- 4. Verify RLS Enabled on All Tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_reps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricelists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procedures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.raw_email_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procedure_overrides ENABLE ROW LEVEL SECURITY;
