# Sending WhatsApp template messages from the Shopify server

A step-by-step guide to calling the wacrm API from another server (for
example our Shopify backend). It covers creating an API key, storing it,
and sending approved template messages.

- **wacrm base URL:** `https://wa.focasedu.online`
- **Endpoint used:** `POST /api/v1/messages`
- **Full API reference:** [public-api.md](public-api.md)

---

## Step 1: Create the API key in wacrm

You must be an **admin or owner** of the workspace.

1. Open **https://wa.focasedu.online/settings?tab=api** (**Settings → API keys**).
2. Click **+ New API key**.
3. **Name:** `Shopify server`. Name each key after the system that uses it,
   so you know which one to revoke later.
4. **Scopes:** tick only what the server needs.

   | Scope           | Tick it? | Why                                                    |
   | --------------- | -------- | ------------------------------------------------------ |
   | `messages:send` | **Yes**  | Required for sending template messages                 |
   | `messages:read` | Optional | Only if the server will read delivery status            |
   | All others      | No       | The Shopify server doesn't need them                   |

5. Click **Create key**.
6. **Copy the key now.** It looks like `wacrm_live_xxxxxxxx…`. wacrm shows
   the full key **only once** and stores only a hash. If you lose it,
   revoke it and create a new one.

> Don't reuse the existing `WA_CRM` key. A separate key per integration
> means you can revoke the Shopify key without breaking anything else.

---

## Step 2: Store the key on the Shopify server

Put the key in an environment variable. Never commit it to git and never
put it in browser or theme code (Liquid/JS that runs in the customer's
browser). Call wacrm only from server-side code.

```bash
# .env on the Shopify server
WACRM_BASE_URL=https://wa.focasedu.online
WACRM_API_KEY=wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Make sure `.env` is listed in `.gitignore`.

---

## Step 3: Check that the key works

Run this from the Shopify server (it needs a valid key but no scope):

```bash
curl https://wa.focasedu.online/api/v1/me \
  -H "Authorization: Bearer $WACRM_API_KEY"
```

Expected response:

```json
{
  "data": {
    "account": { "id": "…", "name": "FOCAS Edu" },
    "key": { "id": "…", "scopes": ["messages:send"] }
  }
}
```

If you get `401 unauthorized`, the key was copied incorrectly or has been
revoked.

---

## Step 4: Find the template details

In wacrm, open **Settings → Templates** and note, for the template you
want to send:

| What you need           | Example               | Notes                                                       |
| ----------------------- | --------------------- | ----------------------------------------------------------- |
| Template **name**       | `order_confirmation`  | Exact name, lowercase with underscores                      |
| **Language** code       | `en` or `en_US`       | Must match the approved language exactly                   |
| **Body variables**      | `{{1}}`, `{{2}}`, …   | Count them; you send one value per variable, in order       |
| Header type             | none / text / image   | A text header with `{{1}}` needs a value (see Step 6)        |
| Buttons                 | URL with `{{1}}`?     | A dynamic URL button needs a value (see Step 6)              |

The template must be **Approved** by Meta. If you created or edited it in
Meta Business Suite, click **Sync from Meta** in wacrm first.

---

## Step 5: Send a template message

### Request

```
POST https://wa.focasedu.online/api/v1/messages
Authorization: Bearer <WACRM_API_KEY>
Content-Type: application/json
```

```json
{
  "to": "+919876543210",
  "type": "template",
  "name": "Ravi Kumar",
  "template": {
    "name": "order_confirmation",
    "language": "en",
    "params": ["Ravi", "#1042", "₹1,499"]
  }
}
```

| Field               | Required | Description                                                                 |
| ------------------- | -------- | --------------------------------------------------------------------------- |
| `to`                | Yes      | Customer phone in **E.164** format: `+` and country code, e.g. `+919876543210` |
| `type`              | Yes      | Always `"template"` for template messages                                   |
| `template.name`     | Yes      | Approved template name                                                      |
| `template.language` | Yes      | Template language code (defaults to `en_US` if omitted, so always set it)   |
| `template.params`   | If the template has variables | Body values in order: `params[0]` → `{{1}}`, `params[1]` → `{{2}}`. For templates with named variables, use the object form in [Named variables](#named-variables) |
| `name`              | No       | Contact name. Used only if this phone isn't in wacrm yet                    |

You don't need to create the contact first. wacrm finds the contact by
phone number or creates it, then sends. The message appears in the wacrm
**Inbox** like any other outbound message.

### curl

```bash
curl -X POST https://wa.focasedu.online/api/v1/messages \
  -H "Authorization: Bearer $WACRM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+919876543210",
    "type": "template",
    "name": "Ravi Kumar",
    "template": {
      "name": "order_confirmation",
      "language": "en",
      "params": ["Ravi", "#1042", "₹1,499"]
    }
  }'
```

### Success response (`201 Created`)

```json
{
  "data": {
    "message_id": "3f1c…",
    "whatsapp_message_id": "wamid.HBgM…",
    "conversation_id": "a8b2…",
    "contact_id": "c91d…",
    "contact_created": false
  }
}
```

Save `whatsapp_message_id` against the order if you want to track
delivery later.

### Named variables

If the template uses named variables such as `{{name}}` and
`{{calendar_link}}`, pass `params` as an object keyed by variable name.
Key order doesn't matter:

```json
{
  "to": "+919876543210",
  "type": "template",
  "name": "Ravi Kumar",
  "template": {
    "name": "live_class_removed",
    "language": "en_US",
    "params": {
      "name": "Ravi",
      "calendar_link": "https://app.focasedu.com/student/live-classes?view=calendar"
    }
  }
}
```

- Every variable in the template needs a value, and every key must match a
  variable name exactly. A missing or misspelled key returns
  `400 invalid_template_params`, which lists the expected names. No message
  is sent and your wallet isn't charged.
- If the template has a **text** header with a named variable, include that
  variable in the same object.
- Values must be strings or numbers and can't be empty.
- Positional templates (`{{1}}`, `{{2}}`) accept the same form with keys
  `"1"`, `"2"`.

Use this form for named templates. The array form fills named variables
in **alphabetical** order of their names, not in the order they appear in
the template, and breaks if a variable is added or renamed.

---

## Step 6: Templates with a header, buttons or media

If the template has only body variables, the array form in Step 5 is
enough. For anything else, pass `params` as an **object**:

```json
{
  "to": "+919876543210",
  "type": "template",
  "template": {
    "name": "order_shipped",
    "language": "en",
    "params": {
      "body": ["Ravi", "#1042"],
      "headerText": "#1042",
      "headerMediaUrl": "https://cdn.shopify.com/s/files/…/invoice.pdf",
      "buttonParams": { "0": "orders/1042" }
    }
  }
}
```

| Key              | Use it when                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `body`           | The body has variables. An array (same as the array form) or an object keyed by variable name, e.g. `{ "name": "Ravi" }` |
| `headerText`     | The **text** header contains `{{1}}`                                                         |
| `headerMediaUrl` | The header is an image, video or document and you want a different file per message (public HTTPS URL). Leave it out to use the file the template was approved with. |
| `buttonParams`   | A **URL button** ends in `{{1}}`. The key is the button's position, starting at `"0"`; the value is the part of the URL that replaces `{{1}}`. |

Quick-reply and phone-number buttons, and URL buttons without a variable,
need nothing.

With named variables, you can put `headerMediaUrl` and `buttonParams` next
to the variable names instead of nesting them under `body`:

```json
"params": {
  "name": "Ravi",
  "order_id": "#1042",
  "headerMediaUrl": "https://cdn.shopify.com/s/files/…/invoice.pdf",
  "buttonParams": { "0": "orders/1042" }
}
```

---

## Step 7: Code for the Shopify server

### Node.js (18+, built-in `fetch`)

```js
// wacrm.js
const BASE_URL = process.env.WACRM_BASE_URL; // https://wa.focasedu.online
const API_KEY = process.env.WACRM_API_KEY;

/**
 * Convert a phone from Shopify into E.164. Shopify may store
 * "9876543210", "09876543210", "+91 98765 43210" or "919876543210".
 * Defaults to India (+91) for 10-digit numbers.
 */
function toE164(raw, defaultCountryCode = '91') {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  if (digits.length === 10) digits = defaultCountryCode + digits;
  return digits.length >= 11 && digits.length <= 15 ? `+${digits}` : null;
}

async function sendTemplate({ phone, customerName, templateName, language, params }) {
  const to = toE164(phone);
  if (!to) throw new Error(`Invalid phone number: ${phone}`);

  const res = await fetch(`${BASE_URL}/api/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to,
      type: 'template',
      name: customerName,
      template: { name: templateName, language, params },
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = json.error?.code ?? 'unknown';
    const message = json.error?.message ?? res.statusText;
    const err = new Error(`wacrm ${res.status} ${code}: ${message}`);
    err.status = res.status;
    err.code = code;
    err.retryAfter = Number(res.headers.get('Retry-After')) || null;
    throw err;
  }
  return json.data; // { message_id, whatsapp_message_id, ... }
}

module.exports = { sendTemplate, toE164 };
```

Use it when an order is created (for example, inside your Shopify
`orders/create` webhook handler):

```js
const { sendTemplate } = require('./wacrm');

app.post('/shopify/orders-create', async (req, res) => {
  // 1. Verify the Shopify HMAC first (not shown).
  // 2. Reply to Shopify right away so it doesn't time out and retry.
  res.sendStatus(200);

  const order = req.body;
  const phone =
    order.shipping_address?.phone || order.billing_address?.phone ||
    order.customer?.phone || order.phone;
  const firstName = order.customer?.first_name || 'Customer';

  try {
    const result = await sendTemplate({
      phone,
      customerName: `${order.customer?.first_name ?? ''} ${order.customer?.last_name ?? ''}`.trim(),
      templateName: 'order_confirmation',
      language: 'en',
      params: [firstName, order.name, `₹${order.total_price}`],
    });
    console.log('WhatsApp sent', order.name, result.whatsapp_message_id);
  } catch (err) {
    console.error('WhatsApp send failed', order.name, err.message);
  }
});
```

### Python (`requests`)

```python
import os, re, requests

BASE_URL = os.environ["WACRM_BASE_URL"]
API_KEY = os.environ["WACRM_API_KEY"]

def to_e164(raw, default_cc="91"):
    digits = re.sub(r"\D", "", str(raw or "")).lstrip("0")
    if len(digits) == 10:
        digits = default_cc + digits
    return f"+{digits}" if 11 <= len(digits) <= 15 else None

def send_template(phone, template_name, language, params, customer_name=None):
    to = to_e164(phone)
    if not to:
        raise ValueError(f"Invalid phone: {phone}")
    r = requests.post(
        f"{BASE_URL}/api/v1/messages",
        headers={"Authorization": f"Bearer {API_KEY}"},
        json={
            "to": to,
            "type": "template",
            "name": customer_name,
            "template": {"name": template_name, "language": language, "params": params},
        },
        timeout=20,
    )
    body = r.json() if r.content else {}
    if not r.ok:
        err = body.get("error", {})
        raise RuntimeError(f"wacrm {r.status_code} {err.get('code')}: {err.get('message')}")
    return body["data"]

# send_template("9876543210", "order_confirmation", "en", ["Ravi", "#1042", "₹1,499"], "Ravi Kumar")
```

---

## Step 8: Handle errors

Errors always look like this:

```json
{ "error": { "code": "forbidden", "message": "This API key is missing the 'messages:send' scope" } }
```

Base your code on `error.code`. The `message` text may change.

| Status | `code`                    | What it means                                        | What to do                                         |
| ------ | ------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| 400    | `bad_request`             | Bad JSON, missing `to`, or the phone isn't valid E.164 | Fix the request. **Don't retry.**                 |
| 400    | `whatsapp_not_configured` | WhatsApp isn't connected in wacrm                    | Check Settings → WhatsApp                          |
| 401    | `unauthorized`            | Key missing, wrong, revoked or expired               | Check `WACRM_API_KEY`                              |
| 403    | `forbidden`               | Key doesn't have the `messages:send` scope           | Create a new key with the right scope              |
| 429    | `rate_limited`            | More than **120 requests/minute** for this key       | Wait for `Retry-After` seconds, then retry         |
| 500    | `template_malformed`      | wacrm's local copy of the template is broken         | Settings → Templates → **Sync from Meta**          |
| 502    | `meta_error`              | Meta rejected the send (wrong template name, language or variable count, template not approved, or the number isn't on WhatsApp) | Read `message` and fix it. Usually not worth retrying |
| 500    | `internal`                | Server error                                         | Retry with backoff (for example after 5s, 30s, 2m) |

**Retry only** on `429`, `500 internal`, and network timeouts. Never retry
`400`, `401` or `403`: the same request will fail again.

---

## Step 9: Sending to many customers at once

`POST /api/v1/messages` sends **one message per call** and is limited to
**120 calls per minute** per key. For a campaign to many customers, use
`POST /api/v1/broadcasts` instead (up to 1000 recipients per call, needs
the `broadcasts:send` scope). See [public-api.md](public-api.md#post-apiv1broadcasts).

---

## Security checklist

- [ ] One key per integration, with only the `messages:send` scope
- [ ] Key kept in an environment variable, not in git and not in browser code
- [ ] All calls go over `https://`
- [ ] If the key may have leaked: **Settings → API keys → Revoke**, then
      create a new one and update `WACRM_API_KEY`. Revoking takes effect on
      the key's next request.

## Troubleshooting

| Problem                                           | Check                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `201` returned but the customer got nothing       | Look at the message status in the wacrm Inbox. The number may not be on WhatsApp, or Meta may have rejected it after accepting. |
| Message sent to the wrong country                 | The phone was sent without a country code. Use `toE164()` before sending. |
| `400 invalid_template_params`                     | A variable is missing, misspelled, empty, or not a string or number. The message names the variable and lists the expected ones. Nothing was sent or charged. |
| `meta_error` mentioning parameters                | The template on Meta differs from the copy in wacrm. Run **Settings → Templates → Sync from Meta**. |
| `meta_error` mentioning the template              | Wrong `template.name` or `template.language`, or the template isn't approved yet. |
| Works with curl but not from the server           | The server isn't reading `.env`, or the key has extra spaces or newlines. |
