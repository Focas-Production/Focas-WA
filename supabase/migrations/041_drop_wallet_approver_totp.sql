-- ============================================================
-- 041_drop_wallet_approver_totp.sql — retire the authenticator-app
-- approver gate.
--
-- The approver for manual wallet credits is now configured by
-- environment (WALLET_APPROVER_PHONE / WALLET_APPROVER_NAME — see
-- src/lib/wallet/credit-otp.ts) instead of a per-account DB row:
-- repointing approvals now requires server access, which is a
-- cleaner boundary than a TOTP secret, and it removes the
-- lost-authenticator lockout entirely. wallet_credit_otps (the
-- per-request WhatsApp codes, migration 040) stays.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DROP TABLE IF EXISTS wallet_approver_totp;
