# Instagram Direct & Facebook Messenger

Instagram DMs and Messenger chats show up in the same inbox as WhatsApp.
Each conversation has a channel, shown by the small badge on the avatar,
and the inbox can be filtered by channel. Replies, media, flows,
automations and the AI auto-reply all work on these channels too.

## What works

| Feature | WhatsApp | Instagram / Messenger |
| --- | --- | --- |
| Text, images, video, audio, files | ✅ | ✅ (captions go out as a second message) |
| Interactive buttons / lists | ✅ | ✅ shown as **quick replies** (up to 13, titles cut to 20 chars) |
| Flows, automations, AI auto-reply | ✅ | ✅ |
| Templates / broadcasts | ✅ | ❌ (WhatsApp only, so template steps fail with a clear error) |
| Delivered / read ticks | ✅ | ✅ |
| Customer reactions, unsend, story replies, story mentions | ✅ | ✅ (received) |
| Sending reactions | ✅ | ❌ |
| Replies sent from the Instagram app / Page inbox | n/a | ✅ copied into the thread |

**Reply window:** Meta allows replies within **24 hours** of the
customer's last message. After that, the server tries again with the
`HUMAN_AGENT` tag, which allows replies for up to **7 days**, but only if
your app has been approved for Human Agent. Once 7 days have passed, the
composer is locked until the customer writes again.

A person who only messages on Instagram or Messenger becomes a contact
without a phone number. WhatsApp broadcasts skip these contacts.

## Setup

1. **Run the migration** `supabase/migrations/051_social_channels.sql`.
2. **Environment** (same Meta app as WhatsApp):
   - `META_APP_ID`, `META_APP_SECRET` (already used for WhatsApp)
   - `NEXT_PUBLIC_META_APP_ID` (needed for the *Continue with Facebook* button)
   - `META_SOCIAL_VERIFY_TOKEN`: any random string
   - optional `NEXT_PUBLIC_META_SOCIAL_CONFIG_ID`: a Facebook Login for Business configuration id
3. **Meta app** (developers.facebook.com):
   - Add the **Messenger** and **Instagram** products.
   - Messenger → Webhooks → **Page** object: callback
     `https://<your-domain>/api/social/webhook`, verify token =
     `META_SOCIAL_VERIFY_TOKEN`. Subscribe to `messages`,
     `messaging_postbacks`, `message_deliveries`, `message_reads`,
     `message_echoes`, `message_reactions`.
   - Instagram → Webhooks → **Instagram** object: same URL and token.
     Subscribe to `messages`, `messaging_postbacks`, `messaging_seen`,
     `message_reactions`.
   - Permissions: `pages_show_list`, `pages_messaging`,
     `pages_manage_metadata`, `pages_read_engagement`, `instagram_basic`,
     `instagram_manage_messages`, `business_management`. While the app is
     in development mode, only app admins and testers can connect. Get
     **Advanced Access** through App Review before going live.
   - On the Instagram account: it must be a **professional** account
     (Business or Creator), linked to the Facebook Page, with
     *Allow access to messages* turned on (Instagram app → Settings →
     Messages and story replies → Message controls → Connected tools).
4. **Connect** in *Settings → Instagram & Messenger*: click
   **Continue with Facebook**, pick the Page(s), and tick Messenger and/or
   Instagram. Or paste a Page access token under *Connect with a Page
   access token instead* (a non-expiring System User token works well).
   Connecting also subscribes the Page to the app's webhooks.

## How it works

- `social_channels` holds one row per connected Page (Messenger) or
  Instagram account. Its Page access token is encrypted with
  `ENCRYPTION_KEY`. Instagram messages are sent through the linked Page
  (`POST /{page-id}/messages`).
- `conversations.channel` is `whatsapp`, `instagram` or `messenger`. A
  contact gets one thread per channel.
- Contacts are matched on `messenger_psid` / `instagram_igsid`. These
  IDs are page-scoped, so the same person messaging two different Pages
  becomes two contacts.
- Inbound media and profile pictures are copied into the `chat-media`
  bucket, because Meta's CDN links expire.
- The webhook payloads for `message.received` / `message.sent` include a
  `channel` field. For Instagram and Messenger, `phone` is `null` and
  `channel_user_id` carries the PSID / IGSID.
