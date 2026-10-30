-- Durable EWS ingestion watermark
--
-- sync_checkpoints.last_synced_at records the wall clock of the last run, which is
-- useless for recovery: if the pipeline is down (or a batch fails) longer than the
-- FindItem fallback's overlap window, the next run queries a range that starts AFTER
-- the missing mail and those approvals are lost silently.
--
-- watermark_received_at stores the highest item DateTimeReceived actually ingested,
-- so the recovery window is anchored on mailbox time rather than process time.

ALTER TABLE public.sync_checkpoints
    ADD COLUMN IF NOT EXISTS watermark_received_at TIMESTAMPTZ;

COMMENT ON COLUMN public.sync_checkpoints.watermark_received_at IS
    'Highest Exchange DateTimeReceived durably ingested for this folder; drives the FindItem recovery window.';
