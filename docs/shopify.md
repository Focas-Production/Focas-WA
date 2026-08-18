# Shopify integration

Connect a Shopify store and send automatic WhatsApp template messages
on order events — no Shopify app or OAuth required, just Shopify's
built-in notification webhooks.

## How it works

1. Shopify POSTs order webhooks to `https://<your-wacrm>/api/shopify/webhook`.
2. The receiver resolves the account by the `X-Shopify-Shop-Domain`
   header and verifies `X-Shopify-Hmac-Sha256` with the store's
   signing secret (stored encrypted).
3. The customer's phone is matched to a contact (created if new — the
   `contact.created` webhook fires), and the template mapped to that
   event is sent through the normal send core (wallet charging and
   `template.message.sent` / `template.message.failed` webhooks
   included).

## Supported events

| Shopify webhook event | Topic              | Typical use                |
| --------------------- | ------------------ | -------------------------- |
| Order creation        | `orders/create`    | Order confirmation         |
| Order payment         | `orders/paid`      | Payment received           |
| Order fulfillment     | `orders/fulfilled` | Shipped + tracking         |
| Order cancellation    | `orders/cancelled` | Cancellation notice        |

## Setup

1. Apply migration `042_shopify_integration.sql`.
2. In **Shopify Admin → Settings → Notifications → Webhooks**, create a
   webhook per event above (format JSON) pointing at
   `https://<your-wacrm>/api/shopify/webhook`.
3. Copy the signing secret shown at the bottom of that Shopify page.
4. In **wacrm → Settings → Shopify**: enter your `*.myshopify.com`
   domain and the secret, map each event to an approved template, and
   save.

## Template parameters

Each mapped event has a list of body parameters (one per line), which
may mix literal text with variables:

```
{{customer_name}}
Order {{order_number}}
{{total_with_currency}}
```

Available variables: `customer_name`, `first_name`, `order_number`,
`order_id`, `total`, `currency`, `total_with_currency`, `item_count`,
`first_item`, `financial_status`, `tracking_number`, `tracking_url`,
`shop`. Unknown variables resolve to `-` (Meta rejects empty params).

## Notes

- Orders without any customer phone are skipped (logged server-side).
- Business failures (empty wallet, unapproved template) are ACKed with
  200 so Shopify doesn't retry or drop the subscription; check server
  logs.
- Abandoned-checkout reminders need delayed scheduling and are not
  part of this integration yet.
