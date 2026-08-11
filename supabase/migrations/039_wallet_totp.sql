-- ============================================================
-- 039_wallet_totp.sql — TOTP approver gate for manual wallet credits
--
-- Manual credit invents balance out of thin air, so it gets a
-- two-person rule: once an account has a row here, every manual
-- credit must carry a valid 6-digit TOTP code from the approver's
-- authenticator app (Google Authenticator / Authy — RFC 6238,
-- SHA-1, 30 s period, 6 digits).
--
--   secret_encrypted — the base32 TOTP secret, encrypted with the
--                      same app-level scheme as WhatsApp tokens
--                      (src/lib/whatsapp/encryption.ts). Never
--                      readable via RLS.
--   last_used_step   — replay guard. A code is valid for one use:
--                      the verify path claims its 30 s time-step
--                      with a guarded UPDATE (last_used_step < step),
--                      so the same code can't approve two credits.
--
-- RLS is enabled with NO policies: only service_role (the API
-- routes) can touch this table. A browser session must never read
-- the secret or reset the replay counter.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS wallet_approver_totp (
  account_id       uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  secret_encrypted text NOT NULL,
  label            text NOT NULL DEFAULT 'Approver',
  last_used_step   bigint NOT NULL DEFAULT 0,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE wallet_approver_totp ENABLE ROW LEVEL SECURITY;
