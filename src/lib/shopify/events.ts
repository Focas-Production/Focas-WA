// ============================================================
// Shopify integration vocabulary — pure, no I/O.
//
// A store maps Shopify webhook topics to WhatsApp template sends.
// Adding a topic is one entry here plus (if its payload isn't an
// order) an extraction tweak in order-variables.ts — the DB stores
// the mapping as free jsonb, so no migration is needed.
// ============================================================

/** Shopify webhook topics we react to (the `X-Shopify-Topic` header). */
export const SHOPIFY_TOPICS = [
  'orders/create', // order placed → order confirmation
  'orders/paid', // payment captured → payment confirmation
  'orders/fulfilled', // order fulfilled → shipping/tracking update
  'orders/cancelled', // order cancelled → cancellation notice
] as const;

export type ShopifyTopic = (typeof SHOPIFY_TOPICS)[number];

export function isShopifyTopic(value: unknown): value is ShopifyTopic {
  return (
    typeof value === 'string' &&
    (SHOPIFY_TOPICS as readonly string[]).includes(value)
  );
}

/** Per-topic template mapping stored in `shopify_config.event_templates`. */
export interface ShopifyEventTemplate {
  enabled: boolean;
  template_name: string;
  language: string;
  /**
   * Positional template body params. Each entry may contain
   * `{{variable}}` placeholders resolved against the order at send
   * time (see order-variables.ts).
   */
  params: string[];
}

export type ShopifyEventTemplates = Partial<
  Record<ShopifyTopic, ShopifyEventTemplate>
>;

const MAX_PARAMS = 20;
const MAX_PARAM_LEN = 500;

/**
 * Validate + normalize a caller-supplied event_templates map. Unknown
 * topics or malformed entries return `null` (callers 400). An empty
 * map is fine — it means "connected but nothing mapped yet".
 */
export function normalizeEventTemplates(
  input: unknown
): ShopifyEventTemplates | null {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const out: ShopifyEventTemplates = {};
  for (const [topic, raw] of Object.entries(input)) {
    if (!isShopifyTopic(topic)) return null;
    if (raw == null || typeof raw !== 'object') return null;
    const entry = raw as Record<string, unknown>;

    const templateName =
      typeof entry.template_name === 'string' ? entry.template_name.trim() : '';
    const language =
      typeof entry.language === 'string' && entry.language.trim()
        ? entry.language.trim()
        : 'en_US';
    const enabled = entry.enabled === true;
    // An enabled mapping without a template can never send — reject so
    // the mistake surfaces at save time, not silently at order time.
    if (enabled && !templateName) return null;

    const rawParams = Array.isArray(entry.params) ? entry.params : [];
    if (rawParams.length > MAX_PARAMS) return null;
    const params: string[] = [];
    for (const p of rawParams) {
      if (typeof p !== 'string' || p.length > MAX_PARAM_LEN) return null;
      params.push(p);
    }

    out[topic] = { enabled, template_name: templateName, language, params };
  }
  return out;
}

/**
 * Normalize a shop domain to its canonical form: lowercase host,
 * no protocol/path. Must be a *.myshopify.com domain — that is what
 * the `X-Shopify-Shop-Domain` header always carries (even for stores
 * with a custom storefront domain). Returns null when invalid.
 */
export function normalizeShopDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let host = input.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host)) return null;
  return host;
}
