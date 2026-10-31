import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTypingIndicator } from './meta-api'
import { decrypt } from './encryption'
import { resolveSocialTarget } from '@/lib/social/send'
import { sendSocialSenderAction } from '@/lib/social/graph-api'

/**
 * Best-effort "typing…" acknowledgment of an inbound message, for the
 * server-side bot responders (Flows, automations, AI auto-reply).
 *
 * Looks up the account's WhatsApp config, decrypts the token, and sends
 * Meta's read + typing_indicator ack for the given inbound wamid — the
 * customer sees blue ticks and "typing…" for the moments (or seconds)
 * until the bot's reply lands, matching how a native WhatsApp business
 * bot feels.
 *
 * NEVER throws. Typing is cosmetic: a missing config, an aged-out
 * wamid, or a Meta 5xx must not cost the caller its actual reply, so
 * every failure is swallowed with a warn log. Callers should `await` it
 * (not float it) when running inside a webhook `after()` block, where
 * detached promises can be frozen before they deliver — and because the
 * ack must reach Meta BEFORE the reply send dismisses it.
 */
export async function ackInboundWithTyping(
  db: SupabaseClient,
  args: { accountId: string; inboundMessageId: string },
): Promise<void> {
  try {
    // Instagram / Messenger mids aren't wamids — show typing_on through
    // the conversation's Page instead of the WhatsApp number.
    if (!args.inboundMessageId.startsWith('wamid.')) {
      const { data: msg } = await db
        .from('messages')
        .select('conversation_id')
        .eq('message_id', args.inboundMessageId)
        .limit(1)
        .maybeSingle()
      if (!msg) return
      const target = await resolveSocialTarget(db, args.accountId, msg.conversation_id)
      if (!target) return
      await sendSocialSenderAction({
        pageId: target.pageId,
        pageAccessToken: target.pageAccessToken,
        recipientId: target.recipientId,
        action: 'typing_on',
      })
      return
    }

    const { data: config } = await db
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', args.accountId)
      .single()
    if (!config) return

    await sendTypingIndicator({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      messageId: args.inboundMessageId,
    })
  } catch (err) {
    console.warn(
      '[typing-ack] failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
  }
}
