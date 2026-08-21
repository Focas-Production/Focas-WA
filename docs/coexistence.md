# Coexistence & Embedded Signup

Connect a WhatsApp number to wacrm through Meta's guided **Embedded
Signup** flow instead of pasting API credentials by hand — including
**coexistence**, where the number keeps working in the WhatsApp
Business app on a phone while also running on the Cloud API.

> **Status:** ships behind two env vars. With them unset the *Launch
> Embedded Signup* button renders disabled and nothing else changes —
> the manual credentials form is unaffected.
>
> Implements Meta's **Embedded Signup v4** (configuration-driven). The
> older `featureType`-based coexistence flow (v2/v3) is deprecated by
> Meta on **15 October 2026**.

## Why coexistence

Registering a number for the Cloud API normally **takes it away from
the WhatsApp Business app**: staff can no longer chat from the phone.
That is fine for a dedicated API number and painful for a number a
team already uses day to day.

Coexistence removes the trade-off. The number stays live in the app
*and* joins the Cloud API, so:

- staff keep replying from the phone,
- wacrm gets the shared inbox, broadcasts, automations and API,
- recent chat history syncs into the API side during onboarding,
- messages sent from the phone are mirrored into the wacrm inbox
  (see [Message echoes](#message-echoes)).

## What the user sees

**Settings → WhatsApp → Connect with Embedded Signup → Launch Embedded
Signup**. Meta's popup opens and — because the Facebook Login for
Business configuration has *Onboard numbers from the WhatsApp Business
app* enabled — offers both paths:

- **Existing WhatsApp Business app number** (coexistence) — the popup
  shows a QR code, the business scans it from the WhatsApp Business
  app, approves sharing chat history, and the connection is saved.
  The number is registered by the onboarding itself.
- **New number** — Meta OTP-verifies the number in the popup. Because
  a fresh Cloud API number must still be `/register`-ed with a
  two-step PIN, the card has an optional *6-digit PIN* field: fill it
  before launching and wacrm registers the number immediately; leave
  it blank and the number is saved as connected-but-not-registered,
  with the existing "Not registered" banner guiding you to add a PIN
  in the credentials form.

wacrm tells the two apart server-side from Meta's `is_on_biz_app`
flag on the phone number (and the session event name
`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`), so a PIN is never applied
to a coexistence number.

No Phone Number ID, WABA ID or access token is typed anywhere.

Both paths write the same `whatsapp_config` row, so everything
downstream (inbox, templates, broadcasts, flows) is identical
afterwards.

## Setup

### 1. Meta app prerequisites

On the Meta app that owns your webhook:

| Requirement | Where |
| --- | --- |
| Business verification complete | Business Settings → Business info |
| **Advanced Access** for `whatsapp_business_messaging` and `whatsapp_business_management` | App Review → Permissions and features |
| **Facebook Login for Business** product added; *Login with the JavaScript SDK* on and your HTTPS origin in *Allowed Domains for the JavaScript SDK* | App Dashboard → Facebook Login for Business → Settings |
| **WhatsApp use case** attached to the app (without it the configuration wizard only offers the *General* variation) | App Dashboard → Use cases |
| A Configuration of type *WhatsApp Embedded Signup*, token type *Business integration system user access token*, both WhatsApp permissions, and the *Onboard numbers from the WhatsApp Business app* option enabled | App Dashboard → Facebook Login for Business → Configurations |
| Webhook fields `messages` **and** `smb_message_echoes` subscribed | App Dashboard → WhatsApp → Configuration |

Advanced Access is the long pole — it goes through App Review and can
take from a few hours to ~20 days. Until it is granted, the signup
popup will not offer the coexistence option.

### 2. Environment

```bash
# Server-side — used to exchange the signup code for a token.
META_APP_ID=your-meta-app-id
META_APP_SECRET=your-meta-app-secret

# Client-side — enables the button. The config id comes from the
# Facebook Login for Business configuration created above.
NEXT_PUBLIC_META_APP_ID=your-meta-app-id
NEXT_PUBLIC_META_ES_CONFIG_ID=your-fb-login-configuration-id
```

`NEXT_PUBLIC_*` values are inlined at build time — **rebuild and
restart** after setting them, or the button stays disabled.

### 3. Phone-side prerequisites

- WhatsApp Business app **v2.24.17 or newer**.
- The number must **not** be registered with another Cloud API app or
  BSP. A number leaving a BSP has to run on the app alone for roughly
  1–2 months before Meta allows coexistence onboarding.

## How it works

```
Browser                        wacrm server                  Meta
  │  FB.login(config_id,           │                           │
  │    extras: { setup: {} })  ────┼──────────────────────────▶│
  │                                │   QR scan / OTP + consent │
  │  ◀── code + WA_EMBEDDED_SIGNUP session info               │
  │      (phone id, waba id, event FINISH |                    │
  │       FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING)             │
  │                                │                           │
  │  POST /api/whatsapp/           │                           │
  │  embedded-signup ─────────────▶│  code+secret → token ────▶│
  │                                │  verify phone number      │
  │                                │   (+ is_on_biz_app)  ────▶│
  │                                │  subscribe WABA to app ──▶│
  │                                │  /register w/ PIN (new    │
  │                                │    numbers only) ────────▶│
  │                                │  encrypt + store config   │
  │  ◀──────────── { success } ────│                           │
```

Implementation:

- **`src/components/settings/whatsapp-config.tsx`** — loads the
  Facebook JS SDK on demand, launches `FB.login` with the v4
  parameters (`config_id`, `response_type: 'code'`,
  `extras: { setup: {} }` — no `featureType`/`sessionInfoVersion`),
  and listens for
  `WA_EMBEDDED_SIGNUP` `postMessage` events (origin-checked against
  `facebook.com`) to capture `phone_number_id` and `waba_id`.
- **`src/app/api/whatsapp/embedded-signup/route.ts`** — exchanges the
  OAuth `code` for a long-lived business-integration token using
  `META_APP_SECRET` (server-side only), verifies the phone number,
  subscribes the WABA to the app, then stores the credentials
  AES-256-GCM-encrypted in `whatsapp_config`. For a new number it
  also calls `/register` with the user's PIN when one was supplied; a
  registration failure is stored in `last_registration_error` (row
  saved as `disconnected`), and a missing PIN leaves `registered_at`
  null, so the "Not registered" banner and the credentials form can
  finish registration.

For coexistence numbers (`is_on_biz_app: true`) **no `/register` call
is made**. Those numbers are registered by the QR onboarding itself,
and re-registering with a PIN would risk severing the phone-app link.

## Message echoes

With coexistence, a message a staff member sends **from the phone
app** is delivered to the webhook as an `smb_message_echoes` event
rather than an ordinary outbound record. `src/app/api/whatsapp/webhook/route.ts`
mirrors those into the conversation as `agent` messages so the inbox
thread shows both sides of the conversation.

Details worth knowing:

- **Deduped on the Meta message id** — a message sent *through* wacrm
  also echoes back, and must not appear twice.
- **Media is summarised, not re-hosted** — an image echo becomes
  `[image] caption`. Echo media ids are short-lived, and the thread
  mainly needs to show what was said from the phone.
- **`history` and `smb_app_state_sync`** (the initial chat-history and
  contact sync events) are acknowledged and logged but **not
  imported**. Importing historical threads is a possible future
  enhancement.

## Security notes

- `META_APP_SECRET` never reaches the browser; the code exchange is
  server-side.
- `postMessage` handlers verify `event.origin` against Facebook's
  domains before reading session info.
- The same single-tenant rule as the manual form applies: a
  `phone_number_id` already claimed by another account is rejected
  with `409`.
- CSP (`next.config.ts`) allows `connect-src` / `frame-src` to
  Facebook only — required by the SDK's login popup and hidden
  iframes.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Button is greyed out | `NEXT_PUBLIC_META_APP_ID` / `NEXT_PUBLIC_META_ES_CONFIG_ID` unset, or app not rebuilt after setting them |
| Popup opens but offers no "existing WhatsApp Business app number" option | Advanced Access not granted yet, or the Login configuration is not of type *WhatsApp Embedded Signup* |
| "Could not read the onboarded number from the signup flow" | The popup was closed before finishing, or the session-info event never arrived — retry |
| `Meta token exchange failed` | `META_APP_ID` / `META_APP_SECRET` wrong or missing on the server |
| Phone-app messages don't appear in the inbox | `smb_message_echoes` not subscribed in the app's webhook fields |

## Alternative: migrating a number instead

If you don't need the number to keep working in the phone app — or you
can't wait for App Review — add it to a Cloud API WABA directly
(WhatsApp Manager → Phone numbers → **Add phone number**), verify by
SMS, set a two-step PIN, and connect it with the manual credentials
form. This works immediately, keeps the number's quality rating, but
**disconnects it from the WhatsApp Business app permanently**.
