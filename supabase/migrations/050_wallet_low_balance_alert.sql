-- ============================================================
-- 050 — Low-balance reminders (email + WhatsApp).
--
-- The threshold drops from ₹500 to ₹100, and the same threshold now
-- drives both the in-app warning and the outbound reminders.
--
-- One reminder per crossing: `low_balance_alerted_at` is stamped
-- when a reminder is claimed and cleared by a trigger as soon as the
-- balance is back at/above the threshold (top-up, manual credit,
-- refund — every write path goes through UPDATE wallets), so the
-- next drop below the line alerts again.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE wallets
  ALTER COLUMN low_balance_threshold_paise SET DEFAULT 10000;

-- Move wallets still on the old default; a threshold someone tuned
-- by hand is left alone.
UPDATE wallets
  SET low_balance_threshold_paise = 10000
  WHERE low_balance_threshold_paise = 50000;

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS low_balance_alerted_at timestamptz;

-- ─── re-arm on recovery ─────────────────────────────────────

CREATE OR REPLACE FUNCTION wallets_rearm_low_balance_alert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.low_balance_alerted_at IS NOT NULL
     AND NEW.balance_paise >= NEW.low_balance_threshold_paise THEN
    NEW.low_balance_alerted_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wallets_rearm_low_balance_alert ON wallets;
CREATE TRIGGER wallets_rearm_low_balance_alert
  BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION wallets_rearm_low_balance_alert();

-- ─── wallet_claim_low_balance_alert ─────────────────────────
-- Atomically claims the reminder for this crossing. Returns one row
-- (balance + threshold) only to the single caller that should send
-- it; concurrent charges racing past the threshold get nothing.

CREATE OR REPLACE FUNCTION wallet_claim_low_balance_alert(p_account_id uuid)
RETURNS TABLE (balance_paise numeric, threshold_paise bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE wallets w
    SET low_balance_alerted_at = now()
    WHERE w.account_id = p_account_id
      AND w.low_balance_alerted_at IS NULL
      AND w.balance_paise < w.low_balance_threshold_paise
    RETURNING w.balance_paise, w.low_balance_threshold_paise;
END;
$$;

REVOKE ALL ON FUNCTION wallet_claim_low_balance_alert(uuid) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION wallet_claim_low_balance_alert(uuid) TO service_role;
