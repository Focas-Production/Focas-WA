-- ============================================================
-- 044_broadcast_engine.sql — Server-side campaign engine
--
-- Every campaign ("Send now", scheduled, cron-resumed) is now
-- delivered by one server-side engine (src/lib/whatsapp/
-- broadcast-engine.ts) instead of a browser tab. Two columns make
-- that engine crash-safe:
--
--   - broadcasts.locked_until: a lease. The process running a
--     campaign renews it every few seconds; if the process dies
--     (deploy, crash, OOM) the lease lapses and the next
--     /api/broadcasts/cron tick resumes the campaign where it
--     stopped. Rows that were 'sending' before this migration have
--     NULL here and are never auto-resumed.
--
--   - broadcast_recipients.attempted_at: stamped (conditionally, as
--     a per-recipient claim) right before the Meta call. A resumed
--     campaign skips recipients that were mid-send when the process
--     died instead of messaging them twice, and a "Stop sending"
--     can never race the engine into messaging a cancelled
--     recipient. Changing it never touches `status`, so the
--     aggregate count trigger (migration 005) does not fire.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS locked_until timestamptz;

ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS attempted_at timestamptz;

-- Cron's stale-lease scan.
CREATE INDEX IF NOT EXISTS broadcasts_sending_lease_idx
  ON broadcasts (locked_until)
  WHERE status = 'sending';

-- Engine's keyset scan over a campaign's unsent recipients.
CREATE INDEX IF NOT EXISTS broadcast_recipients_pending_idx
  ON broadcast_recipients (broadcast_id, id)
  WHERE status = 'pending';
