-- ============================================================
-- 037_wallet.sql — Prepaid message wallet (WATI-style)
--
-- Template messages are billed per-send from a prepaid, account-
-- scoped wallet instead of leaving Meta charges opaque. Session
-- (free-form) messages are never charged — only template sends.
--
-- Tables
--   wallets              — one row per account; balance in PAISE
--                          (numeric — Meta's per-message rates carry
--                          fractions of a paisa, e.g. ₹0.7846 =
--                          78.46 paise, and the ledger must track
--                          them exactly).
--   wallet_transactions  — append-only ledger. Every balance change
--                          is a row carrying the balance *after* it,
--                          so history reads need no re-derivation.
--   wallet_topup_orders  — Razorpay order lifecycle (created → paid),
--                          the idempotency anchor for online top-ups.
--
-- Per-message rates are NOT stored or configurable — they are Meta's
-- actual rate card, fixed in code (src/lib/wallet/meta-rates.ts), so
-- the wallet always mirrors real Meta spend.
--
-- Money flow invariants
--   - Balance can never go negative: wallet_charge locks the wallet
--     row FOR UPDATE, checks funds, and raises on shortfall.
--   - Charges are idempotent per reference (a retried send can't
--     double-debit), refunds are idempotent per reference (a
--     replayed webhook can't double-refund) — both via partial
--     unique indexes.
--   - Mutations happen ONLY through the two SECURITY DEFINER
--     functions below, executable by service_role alone. The
--     dashboard reads balances/ledger via RLS but can never write
--     them — otherwise any member could credit themselves.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ─── wallets ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wallets (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                  uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  -- numeric, not bigint: Meta rates are fractional paise (78.46).
  balance_paise               numeric(14,2) NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
  currency                    text NOT NULL DEFAULT 'INR',
  -- Dashboard shows a warning when balance drops below this. ₹500.
  low_balance_threshold_paise bigint NOT NULL DEFAULT 50000,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;

-- Members can see their account's balance; nobody writes via RLS.
DROP POLICY IF EXISTS wallets_select ON wallets;
CREATE POLICY wallets_select ON wallets FOR SELECT
  USING (is_account_member(account_id));

-- Owner/admin may tune the low-balance threshold (not the balance —
-- a column-level grant keeps balance_paise out of reach even here).
DROP POLICY IF EXISTS wallets_update ON wallets;
CREATE POLICY wallets_update ON wallets FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

REVOKE UPDATE ON wallets FROM authenticated;
GRANT UPDATE (low_balance_threshold_paise) ON wallets TO authenticated;

-- ─── wallet_transactions (ledger) ───────────────────────────

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id           uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type                text NOT NULL CHECK (type IN ('credit', 'debit', 'refund')),
  amount_paise        numeric(14,2) NOT NULL CHECK (amount_paise > 0),
  balance_after_paise numeric(14,2) NOT NULL,
  -- What the money moved for. Debits: template category. Credits:
  -- the top-up channel. Refunds: 'refund'.
  category            text NOT NULL CHECK (category IN (
                        'marketing', 'utility', 'authentication',
                        'topup_razorpay', 'topup_manual', 'adjustment', 'refund'
                      )),
  description         text,
  -- Debits: wamid (stamped post-send) or a recipient-row key.
  -- Refunds: the reference of the debit being reversed.
  -- Razorpay credits: the payment id.
  reference_id        text,
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- History reads: newest-first per account.
CREATE INDEX IF NOT EXISTS wallet_tx_account_created_idx
  ON wallet_transactions (account_id, created_at DESC);
-- Webhook refund path looks a debit up by its wamid.
CREATE INDEX IF NOT EXISTS wallet_tx_reference_idx
  ON wallet_transactions (reference_id) WHERE reference_id IS NOT NULL;
-- Idempotency anchors: one debit and one refund per reference.
CREATE UNIQUE INDEX IF NOT EXISTS wallet_tx_debit_once
  ON wallet_transactions (reference_id) WHERE type = 'debit' AND reference_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wallet_tx_refund_once
  ON wallet_transactions (reference_id) WHERE type = 'refund' AND reference_id IS NOT NULL;

ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wallet_tx_select ON wallet_transactions;
CREATE POLICY wallet_tx_select ON wallet_transactions FOR SELECT
  USING (is_account_member(account_id));
-- No INSERT/UPDATE/DELETE policies: the ledger is append-only and
-- written exclusively by the SECURITY DEFINER functions.

-- ─── wallet_topup_orders ────────────────────────────────────

CREATE TABLE IF NOT EXISTS wallet_topup_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider            text NOT NULL DEFAULT 'razorpay',
  provider_order_id   text UNIQUE,
  provider_payment_id text,
  amount_paise        bigint NOT NULL CHECK (amount_paise > 0),
  currency            text NOT NULL DEFAULT 'INR',
  status              text NOT NULL DEFAULT 'created'
                      CHECK (status IN ('created', 'paid', 'failed')),
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallet_topup_account_idx
  ON wallet_topup_orders (account_id, created_at DESC);

ALTER TABLE wallet_topup_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wallet_topup_select ON wallet_topup_orders;
CREATE POLICY wallet_topup_select ON wallet_topup_orders FOR SELECT
  USING (is_account_member(account_id));
-- Writes only via API routes using the service-role client.

-- ─── wallet_ensure ──────────────────────────────────────────
-- Creates the wallet row on first touch. Per-message rates live in
-- code (Meta's actual rate card), never in the database.

CREATE OR REPLACE FUNCTION wallet_ensure(p_account_id uuid)
RETURNS wallets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w wallets;
BEGIN
  INSERT INTO wallets (account_id)
  VALUES (p_account_id)
  ON CONFLICT (account_id) DO NOTHING;

  SELECT * INTO w FROM wallets WHERE account_id = p_account_id;
  RETURN w;
END;
$$;

-- ─── wallet_charge ──────────────────────────────────────────
-- Atomic debit. Locks the wallet row, refuses to overdraw, appends
-- the ledger row. Returns the new balance (paise).
--
-- Raises 'WALLET_INSUFFICIENT_FUNDS' on shortfall — callers match on
-- that token to map it to a clean user-facing error.
--
-- Idempotent per p_reference_id: a second call with a reference that
-- already has a debit is a no-op returning the current balance.

CREATE OR REPLACE FUNCTION wallet_charge(
  p_account_id   uuid,
  p_amount_paise numeric,
  p_category     text,
  p_description  text DEFAULT NULL,
  p_reference_id text DEFAULT NULL,
  p_created_by   uuid DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w wallets;
BEGIN
  IF p_amount_paise <= 0 THEN
    RAISE EXCEPTION 'WALLET_BAD_AMOUNT';
  END IF;

  PERFORM wallet_ensure(p_account_id);

  SELECT * INTO w FROM wallets
    WHERE account_id = p_account_id
    FOR UPDATE;

  IF p_reference_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM wallet_transactions
      WHERE reference_id = p_reference_id AND type = 'debit'
  ) THEN
    RETURN w.balance_paise; -- already charged
  END IF;

  IF w.balance_paise < p_amount_paise THEN
    RAISE EXCEPTION 'WALLET_INSUFFICIENT_FUNDS';
  END IF;

  UPDATE wallets
    SET balance_paise = balance_paise - p_amount_paise,
        updated_at = now()
    WHERE id = w.id;

  INSERT INTO wallet_transactions
    (wallet_id, account_id, type, amount_paise, balance_after_paise,
     category, description, reference_id, created_by)
  VALUES
    (w.id, p_account_id, 'debit', p_amount_paise,
     w.balance_paise - p_amount_paise,
     p_category, p_description, p_reference_id, p_created_by);

  RETURN w.balance_paise - p_amount_paise;
END;
$$;

-- ─── wallet_credit ──────────────────────────────────────────
-- Atomic credit (top-up, manual load, or refund via p_type).
-- Refunds are idempotent per reference (unique partial index) —
-- a duplicate refund silently no-ops so webhook replays are safe.

CREATE OR REPLACE FUNCTION wallet_credit(
  p_account_id   uuid,
  p_amount_paise numeric,
  p_category     text,
  p_description  text DEFAULT NULL,
  p_reference_id text DEFAULT NULL,
  p_created_by   uuid DEFAULT NULL,
  p_type         text DEFAULT 'credit'
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w wallets;
BEGIN
  IF p_amount_paise <= 0 THEN
    RAISE EXCEPTION 'WALLET_BAD_AMOUNT';
  END IF;
  IF p_type NOT IN ('credit', 'refund') THEN
    RAISE EXCEPTION 'WALLET_BAD_TYPE';
  END IF;

  PERFORM wallet_ensure(p_account_id);

  SELECT * INTO w FROM wallets
    WHERE account_id = p_account_id
    FOR UPDATE;

  BEGIN
    INSERT INTO wallet_transactions
      (wallet_id, account_id, type, amount_paise, balance_after_paise,
       category, description, reference_id, created_by)
    VALUES
      (w.id, p_account_id, p_type, p_amount_paise,
       w.balance_paise + p_amount_paise,
       p_category, p_description, p_reference_id, p_created_by);
  EXCEPTION WHEN unique_violation THEN
    RETURN w.balance_paise; -- duplicate credit/refund for this reference
  END;

  UPDATE wallets
    SET balance_paise = balance_paise + p_amount_paise,
        updated_at = now()
    WHERE id = w.id;

  RETURN w.balance_paise + p_amount_paise;
END;
$$;

-- ─── wallet_stamp_debit_reference ───────────────────────────
-- After a successful Meta send we swap the debit's provisional
-- reference (recipient-row key) for the wamid, so the webhook's
-- failed-status refund can find it. No-op if the wamid reference
-- already exists (idempotent under retries).

CREATE OR REPLACE FUNCTION wallet_stamp_debit_reference(
  p_old_reference text,
  p_new_reference text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE wallet_transactions
    SET reference_id = p_new_reference
    WHERE reference_id = p_old_reference AND type = 'debit';
EXCEPTION WHEN unique_violation THEN
  NULL;
END;
$$;

-- Mutating functions are service-role only. A member could otherwise
-- credit their own wallet from the browser console.
REVOKE ALL ON FUNCTION wallet_ensure(uuid) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION wallet_charge(uuid, numeric, text, text, text, uuid) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION wallet_credit(uuid, numeric, text, text, text, uuid, text) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION wallet_stamp_debit_reference(text, text) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION wallet_ensure(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION wallet_charge(uuid, numeric, text, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION wallet_credit(uuid, numeric, text, text, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION wallet_stamp_debit_reference(text, text) TO service_role;

ALTER FUNCTION wallet_ensure(uuid) OWNER TO postgres;
ALTER FUNCTION wallet_charge(uuid, numeric, text, text, text, uuid) OWNER TO postgres;
ALTER FUNCTION wallet_credit(uuid, numeric, text, text, text, uuid, text) OWNER TO postgres;
ALTER FUNCTION wallet_stamp_debit_reference(text, text) OWNER TO postgres;
