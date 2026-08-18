# API Docs — FOCAS WhatsApp integration

How to send and receive WhatsApp messages from your own code through
wacrm. This is the practical guide for our deployment; the full
upstream reference is [public-api.md](./public-api.md).

## The model — only two directions

**Outbound — you send a message:**

```
your server  →  wacrm API  →  WhatsApp  →  customer
```

**Inbound — a customer messages you:**

```
customer  →  WhatsApp  →  wacrm  →  webhook  →  your server
```

The **API** is how you send. The **webhook** is how you receive.
That's the whole thing.

## How our production is wired

The MCQ bot is a working example of both halves:

1. A student messages our WhatsApp business number.
2. WhatsApp delivers it to wacrm.
3. wacrm POSTs the event to the Mentor server's webhook endpoint
   (`/api/data/wacrm-webhook`).
4. The Mentor server decides the reply.
5. The Mentor server calls the wacrm API to send it back.

Steps 3 and 5 are already deployed. Nothing needs configuring to keep
that running — this guide is for writing *new* integrations.

## Setup

Get an API key from **wacrm → Settings → API keys → New API key**.
The full key is shown **once** — store it in your `.env`, never in
source control.

```bash
export WACRM_BASE_URL=https://<your-wacrm-host>
export WACRM_API_KEY=wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx
```

Every request authenticates with that key as a bearer token. Check it
works — this needs no scopes and prints the account it belongs to:

```bash
curl "$WACRM_BASE_URL/api/v1/me" \
  -H "Authorization: Bearer $WACRM_API_KEY"
```

Grant a key only the scopes it needs: `messages:send`, `messages:read`,
`contacts:read`, `contacts:write`, `conversations:read`,
`broadcasts:send`, `webhooks:manage`.

## Sending messages

All sends are `POST /api/v1/messages` with scope `messages:send`. You
pass a phone number in E.164 — the contact and conversation are
found-or-created automatically.

### Text

```bash
curl -X POST "$WACRM_BASE_URL/api/v1/messages" \
  -H "Authorization: Bearer $WACRM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "to": "+91XXXXXXXXXX",
        "type": "text",
        "text": "Hello from FOCAS 👋"
      }'
```

> ⚠️ **24-hour rule.** Plain text only reaches someone who messaged
> you within the last 24 hours. Outside that window WhatsApp rejects
> it and you must send an approved **template** instead.

### Template

```bash
curl -X POST "$WACRM_BASE_URL/api/v1/messages" \
  -H "Authorization: Bearer $WACRM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "to": "+91XXXXXXXXXX",
        "type": "template",
        "template": {
          "name": "your_template_name",
          "language": "en_US",
          "params": ["Ravi", "12 Aug"]
        }
      }'
```

`params` fills `{{1}}`, `{{2}}`… in the template body, in order.

> ⚠️ **Do not send OTP/authentication templates through this API.**
> They require the code in both the body and a copy-code button, and
> wacrm's template sync drops OTP buttons — Meta rejects the send.
> OTPs go straight to the Meta Graph API from the Mentor server
> instead (`services/whatsappService.js`). Keep it that way.

### Media

`type` may be `image`, `video`, `document`, or `audio`. `text` becomes
the caption (max 1024 chars; audio carries none).

```bash
curl -X POST "$WACRM_BASE_URL/api/v1/messages" \
  -H "Authorization: Bearer $WACRM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "to": "+91XXXXXXXXXX",
        "type": "document",
        "media_url": "https://example.com/notes.pdf",
        "filename": "CA-Foundation-Notes.pdf",
        "text": "This week'"'"'s notes"
      }'
```

### Interactive list

Tap-to-choose menu — what the MCQ bot uses for level/subject/chapter
selection. **Max 10 rows total** across all sections.

```bash
curl -X POST "$WACRM_BASE_URL/api/v1/messages" \
  -H "Authorization: Bearer $WACRM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "to": "+91XXXXXXXXXX",
        "type": "interactive",
        "interactive_payload": {
          "kind": "list",
          "body": "Select your CA level",
          "button_label": "Choose",
          "sections": [{
            "title": "CA Levels",
            "rows": [
              { "id": "lvl-0", "title": "Foundation" },
              { "id": "lvl-1", "title": "Intermediate" },
              { "id": "lvl-2", "title": "Final" }
            ]
          }]
        }
      }'
```

Limits: `button_label` ≤ 20, row `title` ≤ 24, row `description` ≤ 72,
`body` ≤ 1024, optional `header`/`footer` ≤ 60.

The `id` you set comes back in the webhook when the user taps — use it
to route the reply.

### Interactive buttons

1–3 buttons, `title` ≤ 20 chars.

```bash
curl -X POST "$WACRM_BASE_URL/api/v1/messages" \
  -H "Authorization: Bearer $WACRM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "to": "+91XXXXXXXXXX",
        "type": "interactive",
        "interactive_payload": {
          "kind": "buttons",
          "body": "Continue practising?",
          "buttons": [
            { "id": "yes", "title": "Yes" },
            { "id": "no",  "title": "Stop" }
          ]
        }
      }'
```

### Broadcast

Template send to many recipients. Capped at **1000 per request**;
returns immediately and fans out in the background. Scope:
`broadcasts:send`.

```bash
curl -X POST "$WACRM_BASE_URL/api/v1/broadcasts" \
  -H "Authorization: Bearer $WACRM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "Aug batch reminder",
        "template_name": "your_template_name",
        "template_language": "en_US",
        "recipients": [
          { "to": "+91XXXXXXXXXX", "params": ["Ravi"] },
          { "to": "+91YYYYYYYYYY" }
        ]
      }'
```

Poll progress:

```bash
curl "$WACRM_BASE_URL/api/v1/broadcasts/<broadcast_id>" \
  -H "Authorization: Bearer $WACRM_API_KEY"
```

### Wallet billing

Every **template** send (single or broadcast, dashboard or API) is
prepaid from the account wallet (Settings → Wallet). Each message is
debited at its Meta-category rate before the Meta call; a send Meta
rejects — or later reports `failed` — is refunded automatically.
Free-form/session messages are never charged.

If the wallet runs dry mid-broadcast, the remaining recipients are
marked `failed` with `Insufficient wallet balance` (visible when you
poll the broadcast). Single template sends return HTTP `402` with the
same message. Top up in Settings → Wallet before retrying.

## Reading data

```bash
# conversations (newest first)
curl "$WACRM_BASE_URL/api/v1/conversations?limit=20" \
  -H "Authorization: Bearer $WACRM_API_KEY"

# messages in one conversation
curl "$WACRM_BASE_URL/api/v1/conversations/<conversation_id>/messages" \
  -H "Authorization: Bearer $WACRM_API_KEY"

# find a contact by phone
curl "$WACRM_BASE_URL/api/v1/contacts?search=XXXXXXXXXX" \
  -H "Authorization: Bearer $WACRM_API_KEY"
```

All list endpoints page with `?limit=` (default 50, max 100) and the
opaque `meta.next_cursor` → pass it back as `?cursor=`.
`next_cursor: null` means last page.

## Webhooks — receiving messages

A webhook is **not something you log into**. It's a URL *you* own that
wacrm calls whenever something happens. Ours already points at the
Mentor server, which is how the MCQ bot hears from students.

### See what's registered

```bash
curl "$WACRM_BASE_URL/api/v1/webhooks" \
  -H "Authorization: Bearer $WACRM_API_KEY"
```

### Register a new one

Only needed if a *different* server should also receive messages. The
`secret` is returned **exactly once** — store it immediately.

```bash
curl -X POST "$WACRM_BASE_URL/api/v1/webhooks" \
  -H "Authorization: Bearer $WACRM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "url": "https://your-server.example.com/hook",
        "events": ["message.received"]
      }'
```

Available events: `message.received`, `message.sent`,
`template.message.sent`, `template.message.failed`,
`message.status_updated`, `conversation.created`, `contact.created`.
The URL must be `https://` and publicly
resolvable (localhost and private ranges are refused).

### Update / disable

```bash
curl -X PATCH "$WACRM_BASE_URL/api/v1/webhooks/<webhook_id>" \
  -H "Authorization: Bearer $WACRM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "is_active": false }'
```

Re-enabling with `{"is_active": true}` also resets the failure counter.

### What your endpoint receives

```json
{
  "id": "8f3c…",
  "event": "message.received",
  "occurred_at": "2026-08-07T12:49:08.744Z",
  "account_id": "…",
  "data": {
    "conversation_id": "…",
    "contact_id": "…",
    "whatsapp_message_id": "wamid.…",
    "content_type": "text",
    "text": "MCQ",
    "phone": "+917305504500",
    "wa_id": "917305504500",
    "sender_name": "Dinesh S",
    "contact_name": "Dinesh S",
    "timestamp": "2026-08-07T12:49:07.000Z",
    "media_url": null,
    "interactive_reply": null,
    "reply_to_whatsapp_message_id": null
  }
}
```

`data` is self-contained (WATI-style) — the sender's `phone` / `wa_id`
and names ride on every event, so no follow-up contact lookup is
needed.

For an interactive tap, `content_type` is `interactive`, `text` is the
tapped row's **title**, and `interactive_reply` carries the structured
tap so you can match by **row id** instead:

```json
"interactive_reply": {
  "type": "list_reply",
  "id": "row_generate_more",
  "title": "Generate More",
  "description": null
}
```

For media messages, `media_url` is a proxy URL serving the file.

### Verifying the signature

Header: `X-Wacrm-Signature: t=<unix_seconds>,v1=<hex>` where
`v1 = HMAC-SHA256(secret, "{t}.{rawBody}")`.

```js
const [, t, v1] = header.match(/t=(\d+),v1=([0-9a-f]+)/);
const expected = crypto.createHmac('sha256', process.env.WACRM_WEBHOOK_SECRET)
  .update(`${t}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
```

Two things that are easy to get wrong:

- Verify against the **raw** body, before JSON parsing. In Express:
  `app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }))`.
- Reject timestamps older than a few minutes, to block replays.

Working reference: `Focas-Ai-Mentor-App-Server/controllers/wacrmWebhookController.js`.

### Delivery semantics

Best-effort, **single attempt** per event, redirects not followed.
So:

- **Dedupe on `id`** — the same event can arrive more than once.
- **Don't assume ordering** — status callbacks especially.
- Repeated consecutive failures **auto-disable** the endpoint; re-enable
  with the PATCH above.
- Always ACK fast (`200`) and do the real work afterwards.

## Errors

Every response uses one of two shapes:

```jsonc
{ "data": { /* … */ } }                                   // success
{ "error": { "code": "forbidden", "message": "…" } }      // failure
```

Branch on `error.code` — it's stable; `message` is for humans.

| Status | `code` | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | Missing / unknown / revoked key |
| 403 | `forbidden` | Valid key, missing scope |
| 429 | `rate_limited` | Over 120 requests/min for this key |
| 400 | `bad_request` | Malformed input |
| 404 | `not_found` | No such resource |
| 502 | `meta_error` | Meta rejected the send |

On `429`, respect `Retry-After`.

## Security

- Keys live in `.env` only — never in git, never in client-side code.
- Grant minimum scopes; use separate keys per integration so one can be
  revoked without breaking the others.
- Revoke in **Settings → API keys → Revoke**; effective on the key's
  next request.
- Webhook secrets are as sensitive as API keys — anyone holding one can
  forge events that look genuine.
