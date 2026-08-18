// ============================================================
// Shopify webhook HMAC verification.
//
// Shopify signs every webhook body with HMAC-SHA256 over the exact
// raw bytes and sends it base64-encoded in `X-Shopify-Hmac-Sha256`.
// The secret is the store's webhook signing secret (shown at the
// bottom of Shopify Admin → Settings → Notifications → Webhooks).
// ============================================================

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Shopify webhook signature. `rawBody` must be the exact
 * request body string (unparsed); `header` is the base64 value of
 * `X-Shopify-Hmac-Sha256`.
 */
export function verifyShopifyHmac(
  rawBody: string,
  header: string | null | undefined,
  secret: string
): boolean {
  if (!header) return false;
  const expected = createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(header, 'base64');
  } catch {
    return false;
  }
  // timingSafeEqual throws on length mismatch — check first.
  return (
    expected.length === provided.length && timingSafeEqual(expected, provided)
  );
}
