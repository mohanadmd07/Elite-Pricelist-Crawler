-- ==============================================================================
-- Supabase Migration: Phase 3 Mail Ingestion & Attachment Storage
-- Enforces:
-- 1. Private Supabase Storage bucket for approval attachments with RLS.
-- 2. Additive attachment metadata and raw body fields on inpatient_approvals.
-- 3. Automated PHI retention purge function for raw email bodies.
-- ==============================================================================

-- 1. Additive columns for attachments and raw email retention tracking
ALTER TABLE public.inpatient_approvals
    ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS raw_body TEXT;

-- 2. Create Storage Bucket for Approval Attachments (Private, restricted MIME types)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'approval-attachments',
    'approval-attachments',
    false, -- strictly private; accessed only via authenticated signed URLs
    15728640, -- 15MB limit
    ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/tiff']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 3. Storage Object RLS Policies (storage.objects has RLS enabled by default)
-- Allow Service Role full access to approval-attachments
DROP POLICY IF EXISTS "Service role full access on approval-attachments" ON storage.objects;
CREATE POLICY "Service role full access on approval-attachments"
    ON storage.objects
    FOR ALL
    TO service_role
    USING (bucket_id = 'approval-attachments')
    WITH CHECK (bucket_id = 'approval-attachments');

-- Allow Authenticated Staff read access to approval-attachments
DROP POLICY IF EXISTS "Authenticated staff read on approval-attachments" ON storage.objects;
CREATE POLICY "Authenticated staff read on approval-attachments"
    ON storage.objects
    FOR SELECT
    TO authenticated
    USING (bucket_id = 'approval-attachments');

-- 4. Automated Retention Purge Function (PHI Data Minimization)
-- Purges raw email bodies older than retention_days (default 30 days)
CREATE OR REPLACE FUNCTION public.purge_expired_raw_emails(retention_days INT DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    purged_staging_count INT := 0;
    purged_approvals_count INT := 0;
    cutoff_time TIMESTAMPTZ;
BEGIN
    cutoff_time := timezone('utc'::text, now()) - (retention_days || ' days')::INTERVAL;

    -- 1. Purge raw HTML from staging table
    UPDATE public.raw_email_staging
    SET raw_html = '[PURGED_RETENTION_POLICY]',
        updated_at = timezone('utc'::text, now())
    WHERE received_at < cutoff_time
      AND raw_html != '[PURGED_RETENTION_POLICY]';
    GET DIAGNOSTICS purged_staging_count = ROW_COUNT;

    -- 2. Purge raw email body from inpatient_approvals table
    UPDATE public.inpatient_approvals
    SET raw_body = NULL,
        updated_at = timezone('utc'::text, now())
    WHERE received_at < cutoff_time
      AND raw_body IS NOT NULL;
    GET DIAGNOSTICS purged_approvals_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'success', true,
        'retention_days', retention_days,
        'cutoff_time', cutoff_time,
        'purged_staging_count', purged_staging_count,
        'purged_approvals_count', purged_approvals_count
    );
END;
$$;
