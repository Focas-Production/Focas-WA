-- ============================================================
-- 042_shopify_integration.sql — Shopify → WhatsApp notifications
--
-- Lets an account connect a Shopify store and map store events
-- (order created / paid / fulfilled / cancelled) to WhatsApp template
-- sends. Shopify POSTs its webhooks to `/api/shopify/webhook`; the
-- receiver resolves the account by the `X-Shopify-Shop-Domain` header
-- against `shop_domain`, verifies `X-Shopify-Hmac-Sha256` with the
-- stored signing secret, matches the order's customer phone to a
-- contact (creating one if needed — same find-or-create as the
-- public API), and sends the mapped template.
--
-- Design notes
--   - One store per account (`account_id` UNIQUE) keeps the mapping
--     model flat; multi-store accounts can be a later migration.
--   - `shop_domain` is the permanent *.myshopify.com domain (what the
--     webhook header always carries, even for custom storefront
--     domains). UNIQUE so the receiver's domain → account lookup is
--     unambiguous.
--   - `webhook_secret` is the store's webhook signing secret, stored
--     AES-256-GCM-encrypted at rest (same `encrypt()`/`decrypt()` as
--     whatsapp_config.access_token and webhook_endpoints.secret).
--   - `event_templates` is a jsonb map of Shopify topic →
--     { enabled, template_name, language, params[] }, validated in
--     the app layer (src/lib/shopify/events.ts) so adding a topic is
--     a code change, not a migration — same model as webhook events.
--
-- RLS: settings-class, mirroring webhook_endpoints — any member may
-- read, admin+ may write. The receiver uses the service-role client.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS shopify_config (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  shop_domain     text NOT NULL UNIQUE,      -- mystore.myshopify.com (lowercase)
  webhook_secret  text NOT NULL,             -- AES-256-GCM-encrypted signing secret
  is_active       boolean NOT NULL DEFAULT true,
  event_templates jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The receiver resolves the tenant by shop domain on every delivery.
CREATE INDEX IF NOT EXISTS shopify_config_shop_domain_idx
  ON shopify_config (shop_domain);

ALTER TABLE shopify_config ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+) can see the config.
DROP POLICY IF EXISTS shopify_config_select ON shopify_config;
CREATE POLICY shopify_config_select ON shopify_config FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ only (settings-class).
DROP POLICY IF EXISTS shopify_config_insert ON shopify_config;
CREATE POLICY shopify_config_insert ON shopify_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS shopify_config_update ON shopify_config;
CREATE POLICY shopify_config_update ON shopify_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS shopify_config_delete ON shopify_config;
CREATE POLICY shopify_config_delete ON shopify_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- Reuse the shared updated_at trigger (defined in 001).
DROP TRIGGER IF EXISTS set_updated_at ON shopify_config;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON shopify_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
