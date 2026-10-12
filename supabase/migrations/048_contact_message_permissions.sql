-- ============================================================
-- 048_contact_message_permissions.sql
--
-- Per-contact switches for TEMPLATE messages that nobody on the team
-- sends by hand (campaigns already have allow_campaign, migration 047):
--
--   allow_api_templates        — templates sent through the public API
--                                (POST /api/v1/messages) and the
--                                Shopify order-notification webhook.
--   allow_automation_templates — templates sent by automation rules.
--
-- Both default to TRUE. FALSE makes that send fail before the wallet is
-- charged (src/lib/whatsapp/send-message.ts,
-- src/lib/automations/meta-send.ts). Free-form replies inside the 24 h
-- window, manual sends from the inbox, and system messages (wallet
-- approval codes) are not affected.
--
-- NOT NULL DEFAULT TRUE backfills existing rows as a metadata-only
-- change. Idempotent.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS allow_api_templates BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS allow_automation_templates BOOLEAN NOT NULL DEFAULT TRUE;
