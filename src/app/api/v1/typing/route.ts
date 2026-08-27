// ============================================================
// POST /api/v1/typing — show "typing…" on a contact's phone.
//
// Public-API counterpart of the dashboard's /api/whatsapp/typing, for
// external bots that reply through POST /api/v1/messages: they can
// light the indicator without holding a Meta access token of their
// own (wacrm's stored config token is used, so bots never break when
// their copied token expires — the failure mode that motivated this
// endpoint).
//
// Auth: API key with the `messages:send` scope (typing is a messaging
// affordance; no separate scope).
//
// Body (one of):
//   { "whatsapp_message_id": "wamid.…" }  // the inbound wamid the bot
//                                          // is replying to (preferred —
//                                          // bots have it from the
//                                          // message.received webhook)
//   { "to": "+14155550123" }               // contact phone; wacrm
//                                          // resolves their latest
//                                          // inbound message
//
// Meta bundles typing with mark-as-read, so this also turns the
// acknowledged message's ticks blue. The indicator auto-dismisses
// after ~25s or when the next message lands.
//
// Cosmetic semantics (mirrors the dashboard route): soft failures —
// unknown contact/message, no inbound yet, 24h window closed, Meta
// rejecting an aged wamid — return 200 with { shown: false, reason }
// so callers can fire-and-forget. Hard failures (auth, bad body) get
// real statuses.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { findExistingContact } from '@/lib/contacts/dedupe';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';

const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');

    const body = (await request.json().catch(() => null)) as {
      whatsapp_message_id?: unknown;
      to?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const wamid =
      typeof body.whatsapp_message_id === 'string'
        ? body.whatsapp_message_id.trim()
        : '';
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!wamid && !to) {
      return fail(
        'bad_request',
        "Provide 'whatsapp_message_id' (an inbound wamid) or 'to' (contact phone)",
        400
      );
    }

    // Resolve the acknowledgment target: an inbound customer message
    // with a Meta wamid, belonging to this account (tenancy — a foreign
    // wamid must not be ack'able through another account's key).
    let target: { message_id: string; created_at: string } | null = null;
    if (wamid) {
      const { data } = await ctx.supabase
        .from('messages')
        .select('message_id, created_at, conversations!inner(account_id)')
        .eq('conversations.account_id', ctx.accountId)
        .eq('message_id', wamid)
        .eq('sender_type', 'customer')
        .maybeSingle();
      if (!data?.message_id) {
        return ok({ shown: false, reason: 'unknown_message' });
      }
      target = data;
    } else {
      const sanitized = sanitizePhoneForMeta(to);
      if (!isValidE164(sanitized)) {
        return fail(
          'bad_request',
          "'to' must be a valid phone number in E.164 format (e.g. +14155550123)",
          400
        );
      }
      const contact = await findExistingContact(
        ctx.supabase,
        ctx.accountId,
        sanitized
      );
      if (!contact) {
        return ok({ shown: false, reason: 'unknown_contact' });
      }
      const { data: conversation } = await ctx.supabase
        .from('conversations')
        .select('id')
        .eq('account_id', ctx.accountId)
        .eq('contact_id', contact.id)
        .maybeSingle();
      if (!conversation) {
        return ok({ shown: false, reason: 'no_inbound' });
      }
      const { data: lastInbound } = await ctx.supabase
        .from('messages')
        .select('message_id, created_at')
        .eq('conversation_id', conversation.id)
        .eq('sender_type', 'customer')
        .not('message_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!lastInbound?.message_id) {
        return ok({ shown: false, reason: 'no_inbound' });
      }
      target = lastInbound;
    }

    // Typing acks are only valid inside the 24h customer-service
    // window; skip the guaranteed-to-fail Meta call outside it.
    const ageMs = Date.now() - new Date(target.created_at).getTime();
    if (ageMs > SESSION_WINDOW_MS) {
      return ok({ shown: false, reason: 'session_expired' });
    }

    const { data: config } = await ctx.supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!config) {
      return fail('bad_request', 'WhatsApp not configured for this account', 400);
    }

    try {
      await sendTypingIndicator({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
        messageId: target.message_id,
      });
    } catch (err) {
      // Expected noise for a cosmetic feature (aged wamid, transient
      // Meta 5xx) — log for diagnosability, report soft-failure.
      console.warn(
        '[v1/typing] Meta rejected typing ack:',
        err instanceof Error ? err.message : err
      );
      return ok({ shown: false, reason: 'meta_rejected' });
    }

    return ok({ shown: true });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
