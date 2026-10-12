-- ============================================================
-- 049_message_deleted_at.sql
--
-- messages.deleted_at — when the sender deleted the message on
-- WhatsApp ("Delete for everyone").
--
-- Coexistence numbers receive a `revoke` webhook pointing at the
-- original message. Until now it fell through to the unsupported-type
-- branch and was stored as its own bubble reading
-- "[Unsupported message type: revoke]", while the deleted message
-- gave no sign it had been deleted. The webhook now stamps deleted_at
-- on the original; the inbox keeps showing its content (agents still
-- need to read it) with a "Deleted" label next to the time.
--
-- Also removes the junk revoke bubbles stored before this fix (their
-- payload wasn't kept, so the original can't be flagged) and resets
-- any conversation preview that still shows one. Idempotent.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DELETE FROM messages
  WHERE content_text = '[Unsupported message type: revoke]';

UPDATE conversations
  SET last_message_text = 'This message was deleted'
  WHERE last_message_text = '[Unsupported message type: revoke]';
