// ============================================================
// Shopify order → template variables — pure, no I/O.
//
// Extracts a flat `{{variable}}` map from an order webhook payload
// (all four supported topics carry an Order resource) and fills the
// admin-configured positional template params with it. Unknown
// placeholders resolve to '' rather than leaking `{{raw}}` text to a
// customer.
// ============================================================

/** Variables an admin can reference in template params. */
export const ORDER_VARIABLES = [
  'customer_name', // "Priya Sharma"
  'first_name', // "Priya"
  'order_number', // "#1001"
  'order_id', // Shopify's numeric order id
  'total', // "1499.00"
  'currency', // "INR"
  'total_with_currency', // "1499.00 INR"
  'item_count', // "3"
  'first_item', // title of the first line item
  'financial_status', // "paid"
  'tracking_number', // first fulfillment's tracking number
  'tracking_url', // first fulfillment's tracking URL
  'shop', // shop domain
] as const;

export type OrderVariable = (typeof ORDER_VARIABLES)[number];

interface ShopifyAddress {
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

/** The slice of Shopify's Order resource the extractor reads. */
export interface ShopifyOrderPayload {
  id?: number | string;
  name?: string; // "#1001"
  order_number?: number | string;
  total_price?: string;
  currency?: string;
  financial_status?: string;
  customer?: {
    phone?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    default_address?: ShopifyAddress | null;
  } | null;
  shipping_address?: ShopifyAddress | null;
  billing_address?: ShopifyAddress | null;
  line_items?: Array<{ title?: string; quantity?: number }> | null;
  fulfillments?: Array<{
    tracking_number?: string | null;
    tracking_url?: string | null;
    tracking_numbers?: string[] | null;
    tracking_urls?: string[] | null;
  }> | null;
}

/**
 * Best phone for the order's customer, or null. Shopify scatters the
 * phone across customer / addresses depending on checkout settings —
 * take the first non-empty in a stable priority order.
 */
export function extractOrderPhone(order: ShopifyOrderPayload): string | null {
  const candidates = [
    order.customer?.phone,
    order.customer?.default_address?.phone,
    order.shipping_address?.phone,
    order.billing_address?.phone,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

/** Customer display name ("First Last"), falling back through addresses. */
export function extractCustomerName(order: ShopifyOrderPayload): string {
  const sources: (ShopifyAddress | null | undefined)[] = [
    order.customer,
    order.customer?.default_address,
    order.shipping_address,
    order.billing_address,
  ];
  for (const s of sources) {
    const full = [s?.first_name, s?.last_name]
      .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      .join(' ')
      .trim();
    if (full) return full;
  }
  return '';
}

/** Flatten an order into the `{{variable}}` map. */
export function extractOrderVariables(
  order: ShopifyOrderPayload,
  shopDomain: string
): Record<OrderVariable, string> {
  const name = extractCustomerName(order);
  const fulfillment = order.fulfillments?.[0];
  const items = order.line_items ?? [];
  const itemCount = items.reduce((n, li) => n + (li.quantity ?? 1), 0);
  const total = order.total_price ?? '';
  const currency = order.currency ?? '';

  return {
    customer_name: name,
    first_name: name.split(' ')[0] ?? '',
    order_number:
      order.name ?? (order.order_number != null ? `#${order.order_number}` : ''),
    order_id: order.id != null ? String(order.id) : '',
    total,
    currency,
    total_with_currency: total && currency ? `${total} ${currency}` : total,
    item_count: String(itemCount),
    first_item: items[0]?.title ?? '',
    financial_status: order.financial_status ?? '',
    tracking_number:
      fulfillment?.tracking_number ?? fulfillment?.tracking_numbers?.[0] ?? '',
    tracking_url:
      fulfillment?.tracking_url ?? fulfillment?.tracking_urls?.[0] ?? '',
    shop: shopDomain,
  };
}

/**
 * Fill configured params: every `{{key}}` placeholder is replaced with
 * its variable value; unknown keys become ''. Meta rejects empty body
 * params, so blank results fall back to '-'.
 */
export function fillTemplateParams(
  params: string[],
  vars: Record<string, string>
): string[] {
  return params.map((p) => {
    const filled = p
      .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key: string) => vars[key] ?? '')
      .trim();
    return filled || '-';
  });
}
