-- ============================================================
-- 045_wallet_usage.sql — Attributed wallet ledger + usage reports
--
-- The 037 ledger records WHAT moved (debit/refund/credit, amount)
-- but not WHERE the spend came from, so every single send looks the
-- same and the dashboard could only total a month by downloading
-- every row into the browser (capped at 20k — silently wrong beyond).
--
-- This migration:
--   1. Adds attribution columns to wallet_transactions:
--        source            inbox | api | shopify | automation |
--                          broadcast | topup | adjustment | other
--        source_ref        broadcast id / automation id / API key id /
--                          Shopify topic — the "campaign" a row belongs to
--        template_name     the template sent (debits + refunds)
--        template_category marketing | utility | authentication — kept
--                          on refunds too (their `category` is 'refund')
--        quantity          messages the row covers (a broadcast debit
--                          covers N; an aggregate refund covers the
--                          unsent count)
--   2. Backfills existing rows from reference_id / description.
--      Single sends made before this migration can't be told apart
--      (inbox vs API vs Shopify) and are labelled 'other'.
--   3. Extends wallet_charge / wallet_credit with optional
--      attribution params. Refunds inherit attribution from the debit
--      they reverse, so callers rarely need to pass it.
--   4. Adds wallet_usage_summary(): grouped spend computed in SQL
--      (by campaign, template, source, category, day, or total).
--
-- Ledger granularity is unchanged and intentional: one row per
-- single send (needed for per-message refunds keyed by wamid), one
-- row per broadcast campaign. Rows are ~300 bytes; reports aggregate
-- over the (account_id, created_at) index.
--
-- DEPLOY ORDER: run this migration BEFORE deploying the app code
-- that passes the new p_source/... params. Old code keeps working
-- against the new functions (all new params have defaults).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

BEGIN;

-- ─── 1. Columns ─────────────────────────────────────────────

ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS source            text,
  ADD COLUMN IF NOT EXISTS source_ref        text,
  ADD COLUMN IF NOT EXISTS template_name     text,
  ADD COLUMN IF NOT EXISTS template_category text,
  ADD COLUMN IF NOT EXISTS quantity          integer;

DO $$ BEGIN
  ALTER TABLE wallet_transactions
    ADD CONSTRAINT wallet_tx_source_check CHECK (
      source IS NULL OR source IN (
        'inbox', 'api', 'shopify', 'automation', 'broadcast',
        'topup', 'adjustment', 'other'
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE wallet_transactions
    ADD CONSTRAINT wallet_tx_quantity_check CHECK (quantity IS NULL OR quantity >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Drill-down from a campaign row to its transactions.
CREATE INDEX IF NOT EXISTS wallet_tx_account_source_ref_idx
  ON wallet_transactions (account_id, source_ref, created_at DESC)
  WHERE source_ref IS NOT NULL;

-- ─── 2. Backfill (only rows not yet attributed) ─────────────

-- Credits: top-ups and manual adjustments.
UPDATE wallet_transactions
  SET source = CASE WHEN category = 'adjustment' THEN 'adjustment' ELSE 'topup' END
  WHERE source IS NULL AND type = 'credit';

-- Broadcast debits: reference `broadcast:<id>`, description
-- `Broadcast "<name>" — N × Template "<tpl>"`.
UPDATE wallet_transactions
  SET source            = 'broadcast',
      source_ref        = substring(reference_id FROM 11),
      template_name     = substring(description FROM 'Template "([^"]+)"'),
      template_category = category,
      quantity          = COALESCE(substring(description FROM '(\d+) × Template')::int, 1)
  WHERE source IS NULL AND type = 'debit' AND reference_id LIKE 'broadcast:%';

-- Automation debits: description ends with "(automation)".
UPDATE wallet_transactions
  SET source            = 'automation',
      template_name     = substring(description FROM 'Template "([^"]+)"'),
      template_category = category,
      quantity          = 1
  WHERE source IS NULL AND type = 'debit' AND description LIKE '%(automation)';

-- Remaining single-send debits: origin unknown before this migration.
UPDATE wallet_transactions
  SET source            = 'other',
      template_name     = substring(description FROM 'Template "([^"]+)"'),
      template_category = category,
      quantity          = 1
  WHERE source IS NULL AND type = 'debit';

-- Aggregate broadcast refunds share the debit's `broadcast:<id>` reference.
UPDATE wallet_transactions r
  SET source            = d.source,
      source_ref        = d.source_ref,
      template_name     = d.template_name,
      template_category = d.template_category,
      quantity          = COALESCE(substring(r.description FROM '(\d+) unsent')::int, 0)
  FROM wallet_transactions d
  WHERE r.source IS NULL AND r.type = 'refund'
    AND r.reference_id LIKE 'broadcast:%'
    AND d.type = 'debit' AND d.reference_id = r.reference_id;

-- Per-message broadcast refunds (delivery failed): reference is the
-- wamid, which maps back to its broadcast via broadcast_recipients.
UPDATE wallet_transactions r
  SET source            = 'broadcast',
      source_ref        = br.broadcast_id::text,
      template_name     = b.template_name,
      template_category = (
        SELECT d.template_category FROM wallet_transactions d
        WHERE d.type = 'debit' AND d.reference_id = 'broadcast:' || br.broadcast_id::text
        LIMIT 1
      ),
      quantity          = 1
  FROM broadcast_recipients br
  JOIN broadcasts b ON b.id = br.broadcast_id
  WHERE r.source IS NULL AND r.type = 'refund'
    AND br.whatsapp_message_id = r.reference_id;

-- Single-send refunds share the debit's reference (the wamid).
UPDATE wallet_transactions r
  SET source            = d.source,
      source_ref        = d.source_ref,
      template_name     = d.template_name,
      template_category = d.template_category,
      quantity          = 1
  FROM wallet_transactions d
  WHERE r.source IS NULL AND r.type = 'refund'
    AND d.type = 'debit' AND d.reference_id = r.reference_id;

UPDATE wallet_transactions
  SET source = 'other', quantity = COALESCE(quantity, 1)
  WHERE source IS NULL;

-- ─── 3. Charge / credit with attribution ────────────────────
-- Signatures change, so the old functions are dropped first (two
-- overloads with defaulted params would make PostgREST's named-arg
-- resolution ambiguous). The transaction keeps the swap atomic.

DROP FUNCTION IF EXISTS wallet_charge(uuid, numeric, text, text, text, uuid);

CREATE OR REPLACE FUNCTION wallet_charge(
  p_account_id    uuid,
  p_amount_paise  numeric,
  p_category      text,
  p_description   text    DEFAULT NULL,
  p_reference_id  text    DEFAULT NULL,
  p_created_by    uuid    DEFAULT NULL,
  p_source        text    DEFAULT NULL,
  p_source_ref    text    DEFAULT NULL,
  p_template_name text    DEFAULT NULL,
  p_quantity      integer DEFAULT NULL
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
     category, description, reference_id, created_by,
     source, source_ref, template_name, template_category, quantity)
  VALUES
    (w.id, p_account_id, 'debit', p_amount_paise,
     w.balance_paise - p_amount_paise,
     p_category, p_description, p_reference_id, p_created_by,
     COALESCE(p_source, 'other'), p_source_ref, p_template_name,
     p_category, COALESCE(p_quantity, 1));

  RETURN w.balance_paise - p_amount_paise;
END;
$$;

DROP FUNCTION IF EXISTS wallet_credit(uuid, numeric, text, text, text, uuid, text);

CREATE OR REPLACE FUNCTION wallet_credit(
  p_account_id        uuid,
  p_amount_paise      numeric,
  p_category          text,
  p_description       text    DEFAULT NULL,
  p_reference_id      text    DEFAULT NULL,
  p_created_by        uuid    DEFAULT NULL,
  p_type              text    DEFAULT 'credit',
  p_source            text    DEFAULT NULL,
  p_source_ref        text    DEFAULT NULL,
  p_template_name     text    DEFAULT NULL,
  p_template_category text    DEFAULT NULL,
  p_quantity          integer DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w wallets;
  v_source       text    := p_source;
  v_source_ref   text    := p_source_ref;
  v_template     text    := p_template_name;
  v_tpl_category text    := p_template_category;
  v_quantity     integer := p_quantity;
  d_source       text;
  d_source_ref   text;
  d_template     text;
  d_tpl_category text;
BEGIN
  IF p_amount_paise <= 0 THEN
    RAISE EXCEPTION 'WALLET_BAD_AMOUNT';
  END IF;
  IF p_type NOT IN ('credit', 'refund') THEN
    RAISE EXCEPTION 'WALLET_BAD_TYPE';
  END IF;

  IF p_type = 'refund' THEN
    -- Inherit attribution from the debit being reversed (same
    -- reference: the wamid for single sends, `broadcast:<id>` for a
    -- campaign settle). Explicit params win.
    IF p_reference_id IS NOT NULL THEN
      SELECT source, source_ref, template_name, template_category
        INTO d_source, d_source_ref, d_template, d_tpl_category
        FROM wallet_transactions
        WHERE reference_id = p_reference_id AND type = 'debit'
        LIMIT 1;
    END IF;
    v_source       := COALESCE(v_source, d_source, 'other');
    v_source_ref   := COALESCE(v_source_ref, d_source_ref);
    v_template     := COALESCE(v_template, d_template);
    v_tpl_category := COALESCE(v_tpl_category, d_tpl_category);
    v_quantity     := COALESCE(v_quantity, 1);
  ELSE
    v_source := COALESCE(
      v_source,
      CASE WHEN p_category = 'adjustment' THEN 'adjustment' ELSE 'topup' END
    );
  END IF;

  PERFORM wallet_ensure(p_account_id);

  SELECT * INTO w FROM wallets
    WHERE account_id = p_account_id
    FOR UPDATE;

  BEGIN
    INSERT INTO wallet_transactions
      (wallet_id, account_id, type, amount_paise, balance_after_paise,
       category, description, reference_id, created_by,
       source, source_ref, template_name, template_category, quantity)
    VALUES
      (w.id, p_account_id, p_type, p_amount_paise,
       w.balance_paise + p_amount_paise,
       p_category, p_description, p_reference_id, p_created_by,
       v_source, v_source_ref, v_template, v_tpl_category, v_quantity);
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

-- ─── 4. Usage summary ───────────────────────────────────────
-- Grouped spend for one account over [p_from, p_to). Groups:
--   campaign — (source, source_ref): each broadcast / automation /
--              API key / Shopify topic, plus one row per source for
--              unreferenced sends (inbox, legacy)
--   template | category | source | day (in p_tz) | total
-- Credits (top-ups) are only counted in 'total' and 'source'; the
-- other groupings are about message spend.

CREATE OR REPLACE FUNCTION wallet_usage_summary(
  p_account_id uuid,
  p_from       timestamptz DEFAULT NULL,
  p_to         timestamptz DEFAULT NULL,
  p_group      text        DEFAULT 'campaign',
  p_tz         text        DEFAULT 'Asia/Kolkata'
)
RETURNS TABLE (
  group_key         text,
  label             text,
  source            text,
  source_ref        text,
  debit_paise       numeric,
  refund_paise      numeric,
  credit_paise      numeric,
  messages          bigint,
  refunded_messages bigint,
  tx_count          bigint,
  first_at          timestamptz,
  last_at           timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF p_group NOT IN ('campaign', 'template', 'category', 'source', 'day', 'total') THEN
    RAISE EXCEPTION 'WALLET_BAD_GROUP';
  END IF;

  RETURN QUERY
  WITH tx AS (
    SELECT t.*
    FROM wallet_transactions t
    WHERE t.account_id = p_account_id
      AND (p_from IS NULL OR t.created_at >= p_from)
      AND (p_to   IS NULL OR t.created_at <  p_to)
      AND (p_group IN ('total', 'source') OR t.type <> 'credit')
  ),
  keyed AS (
    SELECT tx.*,
      CASE p_group
        WHEN 'total'    THEN 'total'
        WHEN 'source'   THEN COALESCE(tx.source, 'other')
        WHEN 'template' THEN COALESCE(tx.template_name, '')
        WHEN 'category' THEN COALESCE(tx.template_category, '')
        WHEN 'day'      THEN to_char(tx.created_at AT TIME ZONE p_tz, 'YYYY-MM-DD')
        ELSE COALESCE(tx.source, 'other') || ':' || COALESCE(tx.source_ref, '')
      END AS gkey
    FROM tx
  ),
  agg AS (
    SELECT k.gkey,
      max(k.source)     AS g_source,
      max(k.source_ref) AS g_source_ref,
      COALESCE(sum(k.amount_paise) FILTER (WHERE k.type = 'debit'),  0) AS g_debit,
      COALESCE(sum(k.amount_paise) FILTER (WHERE k.type = 'refund'), 0) AS g_refund,
      COALESCE(sum(k.amount_paise) FILTER (WHERE k.type = 'credit'), 0) AS g_credit,
      COALESCE(sum(COALESCE(k.quantity, 1)) FILTER (WHERE k.type = 'debit'),  0)::bigint AS g_messages,
      COALESCE(sum(COALESCE(k.quantity, 1)) FILTER (WHERE k.type = 'refund'), 0)::bigint AS g_refunded,
      count(*)::bigint  AS g_count,
      min(k.created_at) AS g_first,
      max(k.created_at) AS g_last
    FROM keyed k
    GROUP BY k.gkey
  )
  SELECT
    a.gkey,
    CASE
      WHEN p_group <> 'campaign' THEN NULL
      WHEN a.g_source = 'broadcast'  THEN b.name
      WHEN a.g_source = 'automation' THEN au.name
      WHEN a.g_source = 'api'        THEN ak.name
      ELSE NULL
    END,
    CASE WHEN p_group IN ('campaign', 'source') THEN a.g_source END,
    CASE WHEN p_group = 'campaign' THEN a.g_source_ref END,
    a.g_debit, a.g_refund, a.g_credit,
    a.g_messages, a.g_refunded, a.g_count, a.g_first, a.g_last
  FROM agg a
  LEFT JOIN broadcasts b
    ON p_group = 'campaign' AND a.g_source = 'broadcast'
   AND b.account_id = p_account_id AND b.id::text = a.g_source_ref
  LEFT JOIN automations au
    ON p_group = 'campaign' AND a.g_source = 'automation'
   AND au.account_id = p_account_id AND au.id::text = a.g_source_ref
  LEFT JOIN api_keys ak
    ON p_group = 'campaign' AND a.g_source = 'api'
   AND ak.account_id = p_account_id AND ak.id::text = a.g_source_ref;
END;
$$;

-- ─── Permissions (service role only, as in 037) ─────────────

REVOKE ALL ON FUNCTION wallet_charge(uuid, numeric, text, text, text, uuid, text, text, text, integer) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION wallet_credit(uuid, numeric, text, text, text, uuid, text, text, text, text, text, integer) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION wallet_usage_summary(uuid, timestamptz, timestamptz, text, text) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION wallet_charge(uuid, numeric, text, text, text, uuid, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION wallet_credit(uuid, numeric, text, text, text, uuid, text, text, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION wallet_usage_summary(uuid, timestamptz, timestamptz, text, text) TO service_role;

ALTER FUNCTION wallet_charge(uuid, numeric, text, text, text, uuid, text, text, text, integer) OWNER TO postgres;
ALTER FUNCTION wallet_credit(uuid, numeric, text, text, text, uuid, text, text, text, text, text, integer) OWNER TO postgres;
ALTER FUNCTION wallet_usage_summary(uuid, timestamptz, timestamptz, text, text) OWNER TO postgres;

COMMIT;
