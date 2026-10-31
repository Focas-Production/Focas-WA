-- ============================================================
-- 052_message_edited_at.sql
--
-- messages.edited_at — when the sender edited the message on
-- WhatsApp.
--
-- An `edit` webhook (customer edits, and phone-app edits arriving as
-- smb_message_echoes) points at the original message and carries the
-- new content. Until now it fell through and was stored as its own
-- bubble reading "[edit]" (echoes) or
-- "[Unsupported message type: edit]" (inbound). The webhook now
-- rewrites the original's text and stamps edited_at; the inbox shows
-- an "Edited" label next to the time.
--
-- Also removes the junk edit bubbles stored before this fix (their
-- payload wasn't kept, so the original can't be updated) and resets
-- any conversation preview that still shows one. Idempotent.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

DELETE FROM messages
  WHERE content_text IN ('[edit]', '[Unsupported message type: edit]');

UPDATE conversations
  SET last_message_text = 'This message was edited'
  WHERE last_message_text IN ('[edit]', '[Unsupported message type: edit]');
