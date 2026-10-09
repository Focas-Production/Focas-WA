-- ============================================================
-- 046_message_error.sql
--
-- messages.error_message — WHY an outbound message failed.
--
-- Meta reports delivery failures asynchronously on the status
-- webhook (e.g. "131026 Message undeliverable", "131049 …"). Until
-- now only broadcast_recipients kept that reason, so an inbox / API /
-- Shopify send that failed showed a bare red icon in the thread with
-- no way to tell what went wrong. The webhook now writes the reason
-- here and the inbox bubble renders it under the message.
--
-- Nullable, no backfill: earlier failures never stored a reason.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS error_message TEXT;
