-- ============================================================
-- 043_catalog_products.sql — Local WhatsApp catalog product map
--
-- WHY THIS TABLE EXISTS: order messages from Meta carry only
-- product_retailer_id / quantity / item_price / currency — never the
-- product name. And for coexistence numbers the catalog itself is
-- API-inaccessible (Graph returns "(#10) This operation can not be
-- performed on SMB business type"; Meta's coexistence docs list
-- catalog access as unsupported), so names can never be fetched from
-- Meta. Instead the inbound webhook auto-captures each retailer_id
-- the first time it appears in an order (with its observed price),
-- and an admin fills in the product name once in Settings → Catalog
-- products. From then on orders render full product details in the
-- inbox bubble and in the order.received outbound webhook.
--
-- RLS: settings-class (mirrors webhook_endpoints) — any member may
-- read; admin+ writes. The webhook's auto-capture path writes with
-- the service-role client and bypasses RLS.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS catalog_products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  retailer_id   text NOT NULL,   -- Meta's product_retailer_id ("content id")
  name          text,            -- user-entered; NULL until filled in
  price         numeric,         -- last observed unit price, in currency UNITS
  currency      text,            -- ISO code of the observed price
  catalog_id    text,            -- catalog the product was last seen in
  image_url     text,            -- optional, user-entered
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, retailer_id)
);

-- The settings list and the webhook's name lookup both filter by
-- account and want newest-seen first.
CREATE INDEX IF NOT EXISTS catalog_products_account_seen_idx
  ON catalog_products (account_id, last_seen_at DESC);

ALTER TABLE catalog_products ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+).
DROP POLICY IF EXISTS catalog_products_select ON catalog_products;
CREATE POLICY catalog_products_select ON catalog_products FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ only (settings-class).
DROP POLICY IF EXISTS catalog_products_insert ON catalog_products;
CREATE POLICY catalog_products_insert ON catalog_products FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS catalog_products_update ON catalog_products;
CREATE POLICY catalog_products_update ON catalog_products FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS catalog_products_delete ON catalog_products;
CREATE POLICY catalog_products_delete ON catalog_products FOR DELETE
  USING (is_account_member(account_id, 'admin'));
