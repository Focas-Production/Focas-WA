// ============================================================
// WhatsApp order (cart) helpers.
//
// Meta's `order` messages carry only product_retailer_id / quantity /
// item_price / currency per line item — never the product name — and
// the catalog itself cannot be read via the Graph API for coexistence
// numbers ("(#10) This operation can not be performed on SMB business
// type"). So names come from the local `catalog_products` map
// (migration 043): the webhook auto-captures each retailer_id on
// first sight and an admin names it once in Settings → Catalog
// products.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

/** Shape of `message.order` on an inbound WhatsApp webhook. */
export interface WhatsAppOrder {
  catalog_id?: string
  /** Free-text note the customer attached to the cart. */
  text?: string
  product_items?: Array<{
    product_retailer_id?: string
    quantity?: number
    /** Unit price in currency UNITS (1.5 = ₹1.50), not subunits. */
    item_price?: number
    currency?: string
  }>
}

/**
 * "1 INR" → "₹1.00". Meta sends ISO-4217 codes, but guard anyway — a
 * bad code must never make the webhook drop the whole order message.
 * (lib/currency's formatCurrency rounds to whole units, which would
 * turn a ₹1.50 line item into ₹2 — so format locally with 2 decimals.)
 */
export function formatOrderAmount(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
    }).format(value)
  } catch {
    return `${currency} ${value.toFixed(2)}`
  }
}

/**
 * Human-readable multi-line cart summary for the inbox bubble (and
 * conversation preview). `names` maps retailer_id → product name;
 * unknown ids fall back to the raw retailer_id so the message always
 * renders. Pure — the DB lookup lives in
 * `captureAndResolveOrderProducts`.
 */
export function buildOrderSummary(
  order: WhatsAppOrder,
  names: ReadonlyMap<string, string>
): string {
  const items = order.product_items ?? []
  const itemCount = items.reduce((n, item) => n + (item.quantity ?? 1), 0)
  const currency = items[0]?.currency
  const total = items.reduce(
    (sum, item) => sum + (item.item_price ?? 0) * (item.quantity ?? 1),
    0
  )
  const lines = [
    `🛒 Order — ${itemCount} item${itemCount === 1 ? '' : 's'}${
      currency ? ` · ${formatOrderAmount(total, currency)}` : ''
    }`,
    ...items.map((item) => {
      const label =
        (item.product_retailer_id && names.get(item.product_retailer_id)) ||
        item.product_retailer_id ||
        'item'
      return `• ${item.quantity ?? 1} × ${label}${
        item.item_price != null && item.currency
          ? ` — ${formatOrderAmount(item.item_price, item.currency)}`
          : ''
      }`
    }),
  ]
  if (order.text) lines.push(`Note: ${order.text}`)
  return lines.join('\n')
}

/**
 * Auto-capture the order's line items into `catalog_products` and
 * return the known names (retailer_id → name) for this account.
 *
 * The upsert intentionally omits `name`, so a user-entered name is
 * never clobbered by later orders — only the observed price/currency/
 * catalog and last_seen_at refresh. Never throws: runs on the inbound
 * webhook path, where a missing table (migration 043 not applied yet)
 * or a transient DB error must not cost the message; the caller just
 * renders retailer ids instead.
 */
export async function captureAndResolveOrderProducts(
  db: SupabaseClient,
  accountId: string,
  order: WhatsAppOrder
): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>()
  try {
    const byRetailerId = new Map<
      string,
      NonNullable<WhatsAppOrder['product_items']>[number]
    >()
    for (const item of order.product_items ?? []) {
      if (item.product_retailer_id) {
        byRetailerId.set(item.product_retailer_id, item)
      }
    }
    if (byRetailerId.size === 0) return names

    const nowIso = new Date().toISOString()
    const { error: upsertError } = await db.from('catalog_products').upsert(
      [...byRetailerId.values()].map((item) => ({
        account_id: accountId,
        retailer_id: item.product_retailer_id,
        price: item.item_price ?? null,
        currency: item.currency ?? null,
        catalog_id: order.catalog_id ?? null,
        last_seen_at: nowIso,
      })),
      { onConflict: 'account_id,retailer_id' }
    )
    if (upsertError) {
      console.warn('[order-products] capture failed:', upsertError.message)
    }

    const { data: rows, error: selectError } = await db
      .from('catalog_products')
      .select('retailer_id, name')
      .eq('account_id', accountId)
      .in('retailer_id', [...byRetailerId.keys()])
      .not('name', 'is', null)
    if (selectError) {
      console.warn('[order-products] lookup failed:', selectError.message)
      return names
    }
    for (const row of rows ?? []) {
      if (row.name) names.set(row.retailer_id, row.name)
    }
    return names
  } catch (err) {
    console.warn(
      '[order-products] capture/resolve threw (non-fatal):',
      err instanceof Error ? err.message : err
    )
    return names
  }
}
