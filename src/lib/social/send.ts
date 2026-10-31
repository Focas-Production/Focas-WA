// ============================================================
// Outbound Instagram / Messenger sends.
//
// Every sender in the app (dashboard send core, Flows, automations,
// AI auto-reply) starts from a conversation id. `resolveSocialTarget`
// tells them whether that conversation lives on Instagram/Messenger
// and, if so, hands back everything needed to reach the person: the
// Page to send through, its decrypted token, and the PSID / IGSID.
// WhatsApp conversations resolve to `null` and callers fall through
// to their existing WhatsApp path unchanged.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { interactivePayloadPreviewText } from '@/lib/whatsapp/interactive'
import {
  sendSocialMessage,
  type SocialChannelKind,
  type SocialOutboundMessage,
} from './graph-api'

export interface SocialTarget {
  channel: SocialChannelKind
  conversationId: string
  contactId: string
  /** PSID (Messenger) or IGSID (Instagram). */
  recipientId: string
  socialChannelId: string
  pageId: string
  pageAccessToken: string
}

/** Thrown when a social conversation can't be sent to. */
export class SocialSendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SocialSendError'
  }
}

export function isSocialChannel(channel: unknown): channel is SocialChannelKind {
  return channel === 'instagram' || channel === 'messenger'
}

export const SOCIAL_CHANNEL_LABEL: Record<SocialChannelKind, string> = {
  instagram: 'Instagram',
  messenger: 'Messenger',
}

/**
 * Resolve a conversation to its Instagram/Messenger send target, or
 * `null` when it's a WhatsApp conversation. Account-scoped; throws
 * `SocialSendError` when the conversation is social but its channel
 * has been disconnected or the contact has no channel id.
 */
export async function resolveSocialTarget(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<SocialTarget | null> {
  const { data: conv } = await db
    .from('conversations')
    .select('id, channel, social_channel_id, contact:contacts(id, messenger_psid, instagram_igsid)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (!conv || !isSocialChannel(conv.channel)) return null
  const channel = conv.channel

  const contact = (Array.isArray(conv.contact) ? conv.contact[0] : conv.contact) as
    | { id: string; messenger_psid: string | null; instagram_igsid: string | null }
    | null
  const recipientId =
    channel === 'instagram' ? contact?.instagram_igsid : contact?.messenger_psid
  if (!contact || !recipientId) {
    throw new SocialSendError(
      `This contact has no ${SOCIAL_CHANNEL_LABEL[channel]} id to reply to.`,
    )
  }

  // Prefer the exact Page/IG account the thread came in on; fall back
  // to the account's (single) channel of that kind if it was re-connected.
  let query = db
    .from('social_channels')
    .select('id, page_id, page_access_token, status')
    .eq('account_id', accountId)
    .eq('channel', channel)
  query = conv.social_channel_id ? query.eq('id', conv.social_channel_id) : query
  const { data: rows } = await query.order('created_at', { ascending: true }).limit(1)
  const row = rows?.[0]

  if (!row || row.status !== 'connected') {
    throw new SocialSendError(
      `${SOCIAL_CHANNEL_LABEL[channel]} is not connected. Reconnect it in Settings → Instagram & Messenger.`,
    )
  }

  return {
    channel,
    conversationId: conv.id,
    contactId: contact.id,
    recipientId,
    socialChannelId: row.id,
    pageId: row.page_id,
    pageAccessToken: decrypt(row.page_access_token),
  }
}

/**
 * Deliver one outbound message. Media captions aren't supported by
 * either channel, so a caption goes out as a follow-up text message;
 * the returned id is the media message's.
 */
export async function deliverSocialMessage(
  target: SocialTarget,
  message: SocialOutboundMessage,
  caption?: string | null,
): Promise<string> {
  const { messageId } = await sendSocialMessage({
    pageId: target.pageId,
    pageAccessToken: target.pageAccessToken,
    recipientId: target.recipientId,
    message,
  })
  if (message.kind === 'media' && caption?.trim()) {
    await sendSocialMessage({
      pageId: target.pageId,
      pageAccessToken: target.pageAccessToken,
      recipientId: target.recipientId,
      message: { kind: 'text', text: caption.trim() },
    })
  }
  return messageId
}

/**
 * Engine-side send for Flows / automations / AI auto-reply: deliver,
 * persist the bot message, bump the conversation preview, and emit
 * `message.sent`. Mirrors what the WhatsApp engine senders do after
 * their Meta call. Returns the Meta message id under the same key the
 * engines already use.
 */
export async function engineSendSocial(
  db: SupabaseClient,
  accountId: string,
  target: SocialTarget,
  message: SocialOutboundMessage,
  opts: { caption?: string | null; aiGenerated?: boolean } = {},
): Promise<{ whatsapp_message_id: string }> {
  const messageId = await deliverSocialMessage(target, message, opts.caption)

  const contentType =
    message.kind === 'media' ? message.mediaKind : message.kind === 'interactive' ? 'interactive' : 'text'
  const contentText =
    message.kind === 'text'
      ? message.text
      : message.kind === 'interactive'
        ? message.payload.body
        : (opts.caption ?? null)
  const preview =
    message.kind === 'interactive'
      ? interactivePayloadPreviewText(message.payload)
      : contentText?.trim() || `[${contentType}]`

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: target.conversationId,
    sender_type: 'bot',
    content_type: contentType,
    content_text: contentText,
    media_url: message.kind === 'media' ? message.url : null,
    interactive_payload: message.kind === 'interactive' ? message.payload : null,
    message_id: messageId,
    status: 'sent',
    ai_generated: opts.aiGenerated ?? false,
  })
  if (msgErr) {
    throw new Error(`sent to ${SOCIAL_CHANNEL_LABEL[target.channel]} but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', target.conversationId)

  await dispatchWebhookEvent(db, accountId, 'message.sent', {
    conversation_id: target.conversationId,
    contact_id: target.contactId,
    channel: target.channel,
    whatsapp_message_id: messageId,
    content_type: contentType,
    text: contentText,
    media_url: message.kind === 'media' ? message.url : null,
    sender_type: 'bot',
  })

  return { whatsapp_message_id: messageId }
}
