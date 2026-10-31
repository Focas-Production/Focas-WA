import { NextResponse, after } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { findMessageIdByWamid } from '@/lib/whatsapp/wamid'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { fetchSocialProfile, type SocialChannelKind } from '@/lib/social/graph-api'
import { rehostSocialMedia } from '@/lib/social/media'
import { SOCIAL_CHANNEL_LABEL } from '@/lib/social/send'

// ============================================================
// Instagram Direct + Facebook Messenger webhook receiver.
//
// Configure in the Meta App Dashboard:
//   - Messenger → Webhooks → "Page" object, and
//   - Instagram → Webhooks → "Instagram" object,
// both with this URL as the callback and META_SOCIAL_VERIFY_TOKEN as
// the verify token. Payloads are HMAC-signed with META_APP_SECRET, the
// same secret the WhatsApp webhook verifies.
//
// Each `entry.id` is the Page id (object "page") or the Instagram
// professional account id (object "instagram"); it maps to exactly one
// `social_channels` row, which fixes the tenant. Events per entry:
//   message (inbound / echo / deleted) · postback · reaction ·
//   delivery · read
// Inbound messages then run the same pipeline as WhatsApp: flows →
// automations → AI auto-reply → message.received webhook.
// ============================================================

export const maxDuration = 60

interface SocialAttachment {
  type: string
  payload?: { url?: string; title?: string; sticker_id?: number }
}

interface SocialMessagingEvent {
  sender: { id: string }
  recipient: { id: string }
  timestamp: number
  message?: {
    mid: string
    text?: string
    attachments?: SocialAttachment[]
    quick_reply?: { payload?: string }
    reply_to?: { mid?: string; story?: { url?: string; id?: string } }
    is_echo?: boolean
    is_deleted?: boolean
    is_unsupported?: boolean
    app_id?: number | string
  }
  postback?: { mid?: string; title?: string; payload?: string }
  reaction?: { mid: string; action: 'react' | 'unreact'; emoji?: string; reaction?: string }
  delivery?: { mids?: string[]; watermark?: number }
  read?: { watermark?: number; mid?: string }
}

interface SocialWebhookBody {
  object?: string
  entry?: Array<{ id: string; time?: number; messaging?: SocialMessagingEvent[] }>
}

interface ChannelRow {
  id: string
  account_id: string
  created_by: string | null
  channel: SocialChannelKind
  external_id: string
  page_id: string
  page_access_token: string
}

// GET — webhook verification handshake.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const challenge = searchParams.get('hub.challenge')
  const verifyToken = searchParams.get('hub.verify_token')
  const expected = process.env.META_SOCIAL_VERIFY_TOKEN

  if (!expected) {
    console.error('[social webhook] META_SOCIAL_VERIFY_TOKEN is not set — cannot verify.')
    return NextResponse.json({ error: 'Verification not configured' }, { status: 403 })
  }
  if (mode === 'subscribe' && challenge && verifyToken === expected) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }
  return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
}

// POST — events. Ack immediately, process in after() (see the WhatsApp
// webhook for why a detached promise is not enough on serverless).
export async function POST(request: Request) {
  const rawBody = await request.text()
  if (!verifyMetaWebhookSignature(rawBody, request.headers.get('x-hub-signature-256'))) {
    console.warn('[social webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: SocialWebhookBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  after(async () => {
    try {
      await processSocialWebhook(body)
    } catch (error) {
      console.error('[social webhook] processing failed:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processSocialWebhook(body: SocialWebhookBody) {
  const channel: SocialChannelKind | null =
    body.object === 'instagram' ? 'instagram' : body.object === 'page' ? 'messenger' : null
  if (!channel || !body.entry) return

  for (const entry of body.entry) {
    if (!entry.messaging?.length) continue

    const { data: row } = await supabaseAdmin()
      .from('social_channels')
      .select('id, account_id, created_by, channel, external_id, page_id, page_access_token')
      .eq('channel', channel)
      .eq('external_id', entry.id)
      .eq('status', 'connected')
      .maybeSingle()
    if (!row) {
      console.warn(`[social webhook] no connected ${channel} channel for id ${entry.id}`)
      continue
    }

    for (const event of entry.messaging) {
      try {
        await processEvent(row as ChannelRow, event)
      } catch (err) {
        console.error('[social webhook] event failed:', err)
      }
    }
  }
}

async function processEvent(row: ChannelRow, event: SocialMessagingEvent) {
  // Echoes: the business replied from the Instagram app / Page inbox.
  // The "customer" is then the recipient, not the sender.
  if (event.message?.is_echo) {
    await handleEcho(row, event)
    return
  }

  const customerId = event.sender?.id
  if (!customerId || customerId === row.external_id) return

  if (event.message || event.postback) {
    await handleInbound(row, customerId, event)
    return
  }
  if (event.reaction) {
    await handleReaction(row, customerId, event.reaction)
    return
  }
  if (event.delivery?.mids?.length) {
    await supabaseAdmin()
      .from('messages')
      .update({ status: 'delivered' })
      .in('message_id', event.delivery.mids)
      .eq('status', 'sent')
    return
  }
  if (event.read) {
    await handleRead(row, customerId, event.read)
  }
}

// ------------------------------------------------------------
// Contacts + conversations
// ------------------------------------------------------------

function idColumn(channel: SocialChannelKind) {
  return channel === 'instagram' ? 'instagram_igsid' : 'messenger_psid'
}

/** The account user inserts are attributed to (NOT NULL user_id FKs). */
async function ownerUserId(row: ChannelRow): Promise<string | null> {
  if (row.created_by) return row.created_by
  const { data } = await supabaseAdmin()
    .from('accounts')
    .select('owner_user_id')
    .eq('id', row.account_id)
    .maybeSingle()
  return (data?.owner_user_id as string | undefined) ?? null
}

async function findContact(row: ChannelRow, customerId: string) {
  const { data } = await supabaseAdmin()
    .from('contacts')
    .select('*')
    .eq('account_id', row.account_id)
    .eq(idColumn(row.channel), customerId)
    .maybeSingle()
  return data
}

/** Placeholder name used when Meta withheld the profile. */
function fallbackContactName(channel: SocialChannelKind) {
  return `${SOCIAL_CHANNEL_LABEL[channel]} user`
}

async function findOrCreateContact(row: ChannelRow, customerId: string, userId: string) {
  const pageToken = decrypt(row.page_access_token)
  const lookupProfile = () =>
    fetchSocialProfile({
      channel: row.channel,
      userId: customerId,
      pageAccessToken: pageToken,
      pageId: row.page_id,
    })

  const existing = await findContact(row, customerId)
  if (existing) {
    // Created while Meta withheld the profile — try again for a real name.
    if (!existing.name || existing.name === fallbackContactName(row.channel)) {
      const retry = await lookupProfile()
      if (retry.name) {
        await supabaseAdmin()
          .from('contacts')
          .update({ name: retry.name, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
        existing.name = retry.name
      }
    }
    return { contact: existing, wasCreated: false }
  }

  const profile = await lookupProfile()
  const avatarUrl = profile.pictureUrl
    ? await rehostSocialMedia(supabaseAdmin(), row.account_id, profile.pictureUrl, `avatar-${customerId}`)
    : null
  const fallbackName = profile.username
    ? `@${profile.username}`
    : fallbackContactName(row.channel)

  const { data: created, error } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: row.account_id,
      user_id: userId,
      // No phone on these channels; '' is excluded from phone dedup (022).
      phone: '',
      name: profile.name || fallbackName,
      avatar_url: avatarUrl,
      [idColumn(row.channel)]: customerId,
      instagram_username: row.channel === 'instagram' ? profile.username : null,
    })
    .select()
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findContact(row, customerId)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[social webhook] contact create failed:', error)
    return null
  }
  return { contact: created, wasCreated: true }
}

async function findConversation(row: ChannelRow, contactId: string) {
  const { data } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', row.account_id)
    .eq('contact_id', contactId)
    .eq('channel', row.channel)
    .order('created_at', { ascending: true })
    .limit(1)
  return data?.[0] ?? null
}

async function findOrCreateConversation(row: ChannelRow, contactId: string, userId: string) {
  const existing = await findConversation(row, contactId)
  if (existing) {
    if (existing.social_channel_id !== row.id) {
      await supabaseAdmin()
        .from('conversations')
        .update({ social_channel_id: row.id })
        .eq('id', existing.id)
    }
    return { conversation: existing, created: false }
  }

  const { data: created, error } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: row.account_id,
      user_id: userId,
      contact_id: contactId,
      channel: row.channel,
      social_channel_id: row.id,
    })
    .select()
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findConversation(row, contactId)
      if (raced) return { conversation: raced, created: false }
    }
    console.error('[social webhook] conversation create failed:', error)
    return null
  }
  return { conversation: created, created: true }
}

// ------------------------------------------------------------
// Message parsing
// ------------------------------------------------------------

interface ParsedPart {
  contentType: 'text' | 'image' | 'video' | 'audio' | 'document' | 'location' | 'interactive'
  contentText: string | null
  mediaUrl: string | null
}

async function parseAttachments(
  row: ChannelRow,
  mid: string,
  attachments: SocialAttachment[],
): Promise<ParsedPart[]> {
  const parts: ParsedPart[] = []
  for (const [i, att] of attachments.entries()) {
    const url = att.payload?.url ?? null
    const rehost = async () =>
      url ? rehostSocialMedia(supabaseAdmin(), row.account_id, url, `${row.channel}-${mid.slice(-12)}-${i}`) : null

    switch (att.type) {
      case 'image':
      case 'animated_image':
        parts.push({ contentType: 'image', contentText: null, mediaUrl: await rehost() })
        break
      case 'video':
      case 'ig_reel':
      case 'reel':
        parts.push({
          contentType: url ? 'video' : 'text',
          contentText: att.type === 'video' ? null : att.payload?.title || 'Shared a reel',
          mediaUrl: await rehost(),
        })
        break
      case 'audio':
        parts.push({ contentType: 'audio', contentText: null, mediaUrl: await rehost() })
        break
      case 'file':
        parts.push({ contentType: 'document', contentText: att.payload?.title ?? null, mediaUrl: await rehost() })
        break
      case 'story_mention':
        parts.push({ contentType: url ? 'image' : 'text', contentText: 'Mentioned you in their story', mediaUrl: await rehost() })
        break
      case 'share':
      case 'ig_post':
        // Shared posts: keep the link rather than copying the media.
        parts.push({ contentType: 'text', contentText: url ? `Shared a post: ${url}` : 'Shared a post', mediaUrl: null })
        break
      case 'location':
        parts.push({ contentType: 'location', contentText: att.payload?.title || 'Shared a location', mediaUrl: null })
        break
      default:
        parts.push({
          contentType: 'text',
          contentText: url ? `[${att.type}] ${url}` : `[Unsupported attachment: ${att.type}]`,
          mediaUrl: null,
        })
    }
  }
  return parts
}

async function parseEventParts(
  row: ChannelRow,
  event: SocialMessagingEvent,
): Promise<{ mid: string; parts: ParsedPart[]; interactiveReplyId: string | null }> {
  if (event.postback) {
    const mid = event.postback.mid || `postback-${event.sender.id}-${event.timestamp}`
    return {
      mid,
      parts: [{ contentType: 'interactive', contentText: event.postback.title || event.postback.payload || null, mediaUrl: null }],
      interactiveReplyId: event.postback.payload || event.postback.title || null,
    }
  }

  const msg = event.message!
  const quickReply = msg.quick_reply?.payload ?? null
  const parts = msg.attachments?.length ? await parseAttachments(row, msg.mid, msg.attachments) : []

  let text = msg.text ?? null
  if (msg.reply_to?.story) {
    text = text ? `↩ Replied to your story: ${text}` : '↩ Replied to your story'
  }
  if (text) {
    // Text rides on the first part when there are attachments (a
    // caption-like line); otherwise it's its own text/quick-reply part.
    if (parts.length > 0 && !parts[0].contentText) {
      parts[0].contentText = text
    } else if (parts.length === 0) {
      parts.push({ contentType: quickReply ? 'interactive' : 'text', contentText: text, mediaUrl: null })
    } else {
      parts.unshift({ contentType: 'text', contentText: text, mediaUrl: null })
    }
  }
  if (parts.length === 0) {
    parts.push({
      contentType: 'text',
      contentText: msg.is_unsupported ? '[Unsupported message]' : '[Message]',
      mediaUrl: null,
    })
  }
  return { mid: msg.mid, parts, interactiveReplyId: quickReply }
}

// ------------------------------------------------------------
// Handlers
// ------------------------------------------------------------

async function handleInbound(row: ChannelRow, customerId: string, event: SocialMessagingEvent) {
  const db = supabaseAdmin()
  const userId = await ownerUserId(row)
  if (!userId) {
    console.error('[social webhook] no owner user for account', row.account_id)
    return
  }

  // Unsend: stamp deleted_at on the original, store nothing new.
  if (event.message?.is_deleted) {
    await db
      .from('messages')
      .update({ deleted_at: new Date().toISOString() })
      .eq('message_id', event.message.mid)
    return
  }

  const contactOutcome = await findOrCreateContact(row, customerId, userId)
  if (!contactOutcome) return
  const contact = contactOutcome.contact

  if (contactOutcome.wasCreated) {
    await dispatchWebhookEvent(db, row.account_id, 'contact.created', {
      contact_id: contact.id,
      phone: contact.phone,
      name: contact.name,
      channel: row.channel,
      source: 'inbound',
    })
  }

  const convResult = await findOrCreateConversation(row, contact.id, userId)
  if (!convResult) return
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(db, row.account_id, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contact.id,
      channel: row.channel,
    })
  }

  const { mid, parts, interactiveReplyId } = await parseEventParts(row, event)

  // Meta redelivery — already stored, don't re-run the bots.
  if (await findMessageIdByWamid(db, mid, conversation.id)) return

  let replyToId: string | null = null
  if (event.message?.reply_to?.mid) {
    replyToId = await findMessageIdByWamid(db, event.message.reply_to.mid, conversation.id)
  }

  const { count: priorCustomerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const createdAt = new Date(event.timestamp || Date.now()).toISOString()
  const { error: msgError } = await db.from('messages').insert(
    parts.map((part, i) => ({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: part.contentType,
      content_text: part.contentText,
      media_url: part.mediaUrl,
      message_id: mid,
      status: 'delivered',
      created_at: createdAt,
      reply_to_message_id: i === 0 ? replyToId : null,
      interactive_reply_id: part.contentType === 'interactive' ? interactiveReplyId : null,
    })),
  )
  if (msgError) {
    console.error('[social webhook] message insert failed:', msgError)
    return
  }

  const last = parts[parts.length - 1]
  const lastText = parts.map((p) => p.contentText).find(Boolean) ?? `[${last.contentType}]`
  await db
    .from('conversations')
    .update({
      last_message_text: lastText,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  // ---- Same bot pipeline as the WhatsApp webhook ----
  const inboundText = parts.map((p) => p.contentText).filter(Boolean).join('\n')

  const flowResult = await dispatchInboundToFlows({
    accountId: row.account_id,
    userId,
    contactId: contact.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: inboundText,
          meta_message_id: mid,
        }
      : { kind: 'text', text: inboundText, meta_message_id: mid },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const triggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    triggers.push('new_message_received', 'keyword_match')
    if (interactiveReplyId) triggers.push('interactive_reply')
  }
  if (contactOutcome.wasCreated) triggers.unshift('new_contact_created')
  if (isFirstInboundMessage) triggers.unshift('first_inbound_message')
  for (const triggerType of triggers) {
    runAutomationsForTrigger({
      accountId: row.account_id,
      triggerType,
      contactId: contact.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: interactiveReplyId ?? undefined,
        inbound_message_id: mid,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId: row.account_id,
      conversationId: conversation.id,
      contactId: contact.id,
      configOwnerUserId: userId,
      inboundMessageId: mid,
    })
  }

  await dispatchWebhookEvent(db, row.account_id, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contact.id,
    channel: row.channel,
    whatsapp_message_id: mid,
    content_type: parts[0].contentType,
    text: inboundText || null,
    phone: contact.phone || null,
    /** PSID / IGSID of the sender. */
    channel_user_id: customerId,
    instagram_username: contact.instagram_username ?? null,
    sender_name: contact.name,
    contact_name: contact.name,
    timestamp: createdAt,
    media_url: parts.find((p) => p.mediaUrl)?.mediaUrl ?? null,
    interactive_reply: interactiveReplyId
      ? { type: event.postback ? 'postback' : 'quick_reply', id: interactiveReplyId, title: inboundText, description: null }
      : null,
    reply_to_whatsapp_message_id: event.message?.reply_to?.mid ?? null,
  })
}

/**
 * Mirror a message the business sent from the Instagram app or the
 * Page inbox. Skips our own sends: Messenger stamps echoes with the
 * sending app's id, and both channels reuse the mid we already stored.
 */
async function handleEcho(row: ChannelRow, event: SocialMessagingEvent) {
  const msg = event.message!
  if (msg.app_id && String(msg.app_id) === process.env.META_APP_ID) return

  const db = supabaseAdmin()
  const alreadyStored = async () => {
    const { data } = await db.from('messages').select('id').eq('message_id', msg.mid).limit(1)
    return (data?.length ?? 0) > 0
  }
  if (await alreadyStored()) return
  // Instagram echoes carry no app_id, and the echo can beat our own
  // insert after a send — give that insert a moment to land first.
  await new Promise((r) => setTimeout(r, 2500))
  if (await alreadyStored()) return

  const customerId = event.recipient?.id
  if (!customerId) return
  const contact = await findContact(row, customerId)
  if (!contact) return // never seen this person inbound — nothing to attach to
  const conversation = await findConversation(row, contact.id)
  if (!conversation) return

  const { parts } = await parseEventParts(row, event)
  await db.from('messages').insert(
    parts.map((part) => ({
      conversation_id: conversation.id,
      sender_type: 'agent',
      content_type: part.contentType === 'interactive' ? 'text' : part.contentType,
      content_text: part.contentText,
      media_url: part.mediaUrl,
      message_id: msg.mid,
      status: 'sent',
      created_at: new Date(event.timestamp || Date.now()).toISOString(),
    })),
  )
  await db
    .from('conversations')
    .update({
      last_message_text: parts.map((p) => p.contentText).find(Boolean) ?? `[${parts[0].contentType}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)
}

async function handleReaction(
  row: ChannelRow,
  customerId: string,
  reaction: NonNullable<SocialMessagingEvent['reaction']>,
) {
  const contact = await findContact(row, customerId)
  if (!contact) return
  const conversation = await findConversation(row, contact.id)
  if (!conversation) return

  const db = supabaseAdmin()
  const targetId = await findMessageIdByWamid(db, reaction.mid, conversation.id)
  if (!targetId) return

  if (reaction.action === 'unreact') {
    await db
      .from('message_reactions')
      .delete()
      .eq('message_id', targetId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contact.id)
    return
  }

  // Instagram sends `reaction: "love"` and sometimes no emoji.
  const emoji = reaction.emoji || (reaction.reaction === 'love' ? '❤️' : '👍')
  const { error } = await db.from('message_reactions').upsert(
    {
      message_id: targetId,
      conversation_id: conversation.id,
      actor_type: 'customer',
      actor_id: contact.id,
      emoji,
    },
    { onConflict: 'message_id,actor_type,actor_id' },
  )
  if (error) console.error('[social webhook] reaction upsert failed:', error.message)
}

/**
 * Read receipts. Messenger sends a watermark (everything before it is
 * read); Instagram sends the mid of the message that was seen.
 */
async function handleRead(
  row: ChannelRow,
  customerId: string,
  read: NonNullable<SocialMessagingEvent['read']>,
) {
  const contact = await findContact(row, customerId)
  if (!contact) return
  const conversation = await findConversation(row, contact.id)
  if (!conversation) return

  const db = supabaseAdmin()
  let upTo: string | null = read.watermark ? new Date(read.watermark).toISOString() : null
  if (!upTo && read.mid) {
    const { data } = await db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversation.id)
      .eq('message_id', read.mid)
      .limit(1)
    upTo = data?.[0]?.created_at ?? null
  }
  if (!upTo) return

  await db
    .from('messages')
    .update({ status: 'read' })
    .eq('conversation_id', conversation.id)
    .in('sender_type', ['agent', 'bot'])
    .in('status', ['sent', 'delivered'])
    .lte('created_at', upTo)
}
