-- ============================================================
-- 040_wallet_credit_otp.sql — WhatsApp-OTP approval for manual
-- wallet credits (replaces the TOTP code as the per-credit gate).
--
-- New model:
--   - Every manual credit becomes a REQUEST: the server texts the
--     approver's WhatsApp a one-time code that names the exact
--     amount and workspace, so the approver never approves blind.
--   - The authenticator (TOTP) secret from migration 039 stays, but
--     now guards the APPROVER SETTINGS instead: changing the
--     approver's WhatsApp number (or rotating the secret) requires
--     a current authenticator code. Otherwise anyone with an owner
--     session could point approvals at their own phone.
--
--   wallet_approver_totp.approver_phone — where approval codes go
--     (E.164, digits only). NULL until first configured.
--
--   wallet_credit_otps — one row per approval request:
--     code_hash    — HMAC-SHA256 of the 6-digit code (never plain).
--     amount_paise — locked at request time; the credit uses THIS
--                    value, so a code can't approve a different
--                    amount than the approver saw.
--     expires_at   — 5 minutes after creation.
--     used_at      — single-use claim (guarded update on IS NULL).
--     attempts     — wrong-code counter; the row dies at 5.
--
-- RLS enabled with NO policies on both — service-role only.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE wallet_approver_totp
  ADD COLUMN IF NOT EXISTS approver_phone text;

CREATE TABLE IF NOT EXISTS wallet_credit_otps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount_paise numeric(14,2) NOT NULL CHECK (amount_paise > 0),
  note         text,
  code_hash    text NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  attempts     int NOT NULL DEFAULT 0,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_credit_otps_account
  ON wallet_credit_otps(account_id, created_at DESC);

ALTER TABLE wallet_credit_otps ENABLE ROW LEVEL SECURITY;
