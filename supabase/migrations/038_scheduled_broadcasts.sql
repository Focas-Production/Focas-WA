-- ============================================================
-- 038_scheduled_broadcasts.sql — Scheduled broadcasts
--
-- The wizard's "Schedule & Send" step gains a real schedule mode:
-- the broadcast row is fully materialized at schedule time (audience
-- resolved into broadcast_recipients, wallet prepaid, variables +
-- header media stored) with status 'scheduled', and a cron endpoint
-- (/api/broadcasts/cron) claims due rows and delivers them entirely
-- server-side — no browser needs to be open.
--
--   - `header_media_url`: media-header templates need the URL at
--     send time; the wizard collected it but never persisted it, so
--     neither scheduled sends nor draft resume could work.
--   - status gains 'cancelled': a scheduled broadcast the user calls
--     off. Recipients flip to failed/"Cancelled" and the campaign's
--     wallet debit is settled back in one refund row.
--   - Partial index so the cron's due-scan stays cheap regardless of
--     table size.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS header_media_url text;

-- Postgres has no ALTER CONSTRAINT for CHECKs — drop + re-add.
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'));

CREATE INDEX IF NOT EXISTS broadcasts_due_scheduled_idx
  ON broadcasts (scheduled_at)
  WHERE status = 'scheduled';
