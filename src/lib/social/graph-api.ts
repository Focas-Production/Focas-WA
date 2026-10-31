/**
 * Graph API helpers for the Instagram Direct + Messenger channels.
 *
 * Both channels run on the Messenger Platform: messages are sent with
 * a Facebook **Page** access token to `POST /{page-id}/messages`, and
 * Instagram professional accounts are reached through the Page they
 * are linked to. Same named-params convention as the WhatsApp
 * `meta-api.ts` helpers.
 */

import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'

const GRAPH_API_VERSION = 'v21.0'
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`
const SEND_TIMEOUT_MS = 30_000

export type SocialChannelKind = 'instagram' | 'messenger'

/** A non-2xx Graph response, keeping Meta's code/subcode for routing. */
export class GraphApiError extends Error {
  readonly status: number
  readonly code?: number
  readonly subcode?: number
  constructor(message: string, status: number, code?: number, subcode?: number) {
    super(message)
    this.name = 'GraphApiError'
    this.status = status
    this.code = code
    this.subcode = subcode
  }
}

async function graphRequest<T>(
  path: string,
  init: { method?: 'GET' | 'POST' | 'DELETE'; token: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const response = await fetch(`${GRAPH_API_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${init.token}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? SEND_TIMEOUT_MS),
  })
  const data = (await response.json().catch(() => null)) as
    | (T & { error?: { message?: string; code?: number; error_subcode?: number } })
    | null
  if (!response.ok || data?.error) {
    throw new GraphApiError(
      data?.error?.message || `Graph API error: ${response.status}`,
      response.status,
      data?.error?.code,
      data?.error?.error_subcode,
    )
  }
  return data as T
}

// ============================================================
// Login / page discovery
// ============================================================

/**
 * Swap a short-lived user token (from FB.login) for a long-lived one.
 * Page tokens fetched with a long-lived user token never expire, which
 * is what we store.
 */
export async function exchangeForLongLivedUserToken(args: {
  shortLivedToken: string
}): Promise<string> {
  const appId = process.env.META_APP_ID
  const appSecret = process.env.META_APP_SECRET
  if (!appId || !appSecret) {
    throw new Error('META_APP_ID and META_APP_SECRET must be set to connect Facebook Pages.')
  }
  const url =
    `${GRAPH_API_BASE}/oauth/access_token?` +
    new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: args.shortLivedToken,
    }).toString()
  const response = await fetch(url, { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })
  const data = (await response.json().catch(() => null)) as {
    access_token?: string
    error?: { message?: string; code?: number }
  } | null
  if (!response.ok || !data?.access_token) {
    throw new GraphApiError(
      data?.error?.message || `Token exchange failed (${response.status})`,
      response.status,
      data?.error?.code,
    )
  }
  return data.access_token
}

export interface ManagedPage {
  id: string
  name: string
  access_token: string
  picture_url: string | null
  instagram: { id: string; username: string | null; name: string | null; picture_url: string | null } | null
}

const PAGE_FIELDS =
  'id,name,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}'

interface RawPage {
  id: string
  name?: string
  access_token?: string
  picture?: { data?: { url?: string } }
  instagram_business_account?: {
    id: string
    username?: string
    name?: string
    profile_picture_url?: string
  }
}

function toManagedPage(raw: RawPage, fallbackToken?: string): ManagedPage {
  const ig = raw.instagram_business_account
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    access_token: raw.access_token ?? fallbackToken ?? '',
    picture_url: raw.picture?.data?.url ?? null,
    instagram: ig
      ? {
          id: ig.id,
          username: ig.username ?? null,
          name: ig.name ?? null,
          picture_url: ig.profile_picture_url ?? null,
        }
      : null,
  }
}

/** Every Page the user can manage, with its Page token and linked IG account. */
export async function listManagedPages(args: { userAccessToken: string }): Promise<ManagedPage[]> {
  const pages: ManagedPage[] = []
  let path: string | null = `/me/accounts?fields=${encodeURIComponent(PAGE_FIELDS)}&limit=100`
  // Follow paging defensively; most users manage a handful of Pages.
  for (let guard = 0; path && guard < 10; guard++) {
    const res: { data?: RawPage[]; paging?: { next?: string } } = await graphRequest(path, {
      token: args.userAccessToken,
    })
    for (const raw of res.data ?? []) pages.push(toManagedPage(raw))
    const next: string | undefined = res.paging?.next
    path = next ? next.replace(GRAPH_API_BASE, '') : null
  }
  return pages
}

/** Resolve a single Page from a Page access token (manual setup path). */
export async function getPageFromPageToken(args: {
  pageAccessToken: string
  pageId?: string
}): Promise<ManagedPage> {
  const target = args.pageId?.trim() || 'me'
  const raw = await graphRequest<RawPage>(
    `/${encodeURIComponent(target)}?fields=${encodeURIComponent(
      'id,name,picture{url},instagram_business_account{id,username,name,profile_picture_url}',
    )}`,
    { token: args.pageAccessToken },
  )
  return toManagedPage(raw, args.pageAccessToken)
}

const PAGE_WEBHOOK_FIELDS = [
  'messages',
  'messaging_postbacks',
  'message_deliveries',
  'message_reads',
  'message_echoes',
  'message_reactions',
]

/**
 * Subscribe this app to the Page's webhooks. Required for Messenger
 * events, and for Instagram DMs on the linked account (Instagram's own
 * fields are subscribed once at the app level in the Meta dashboard).
 */
export async function subscribePageToApp(args: { pageId: string; pageAccessToken: string }) {
  await graphRequest(
    `/${encodeURIComponent(args.pageId)}/subscribed_apps?subscribed_fields=${PAGE_WEBHOOK_FIELDS.join(',')}`,
    { method: 'POST', token: args.pageAccessToken },
  )
}

export async function unsubscribePageFromApp(args: { pageId: string; pageAccessToken: string }) {
  await graphRequest(`/${encodeURIComponent(args.pageId)}/subscribed_apps`, {
    method: 'DELETE',
    token: args.pageAccessToken,
  })
}

// ============================================================
// Profiles
// ============================================================

export interface SocialProfile {
  name: string | null
  username: string | null
  pictureUrl: string | null
}

/**
 * Name from the Page's conversation with this person. The User Profile
 * API needs the "Business Asset User Profile Access" feature (App
 * Review), but conversation participants only need pages_messaging —
 * so this still finds a name when the profile lookup is refused.
 */
async function fetchNameFromConversation(args: {
  channel: SocialChannelKind
  userId: string
  pageId: string
  pageAccessToken: string
}): Promise<string | null> {
  try {
    const res = await graphRequest<{
      data?: Array<{ participants?: { data?: Array<{ id?: string; name?: string; username?: string }> } }>
    }>(
      `/${encodeURIComponent(args.pageId)}/conversations?platform=${args.channel}` +
        `&user_id=${encodeURIComponent(args.userId)}&fields=participants`,
      { token: args.pageAccessToken, timeoutMs: 10_000 },
    )
    const person = res.data?.[0]?.participants?.data?.find((p) => p.id === args.userId)
    return person?.name || person?.username || null
  } catch (err) {
    console.warn(
      `[social] conversation name lookup failed for ${args.channel} user:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/**
 * Best-effort profile lookup for a PSID / IGSID. Returns nulls when
 * Meta withholds the profile (permissions, privacy) — never throws.
 */
export async function fetchSocialProfile(args: {
  channel: SocialChannelKind
  userId: string
  pageAccessToken: string
  /** Enables the conversation-participants fallback for the name. */
  pageId?: string
}): Promise<SocialProfile> {
  const fields =
    args.channel === 'instagram' ? 'name,username,profile_pic' : 'first_name,last_name,profile_pic'
  try {
    const p = await graphRequest<{
      name?: string
      username?: string
      first_name?: string
      last_name?: string
      profile_pic?: string
    }>(`/${encodeURIComponent(args.userId)}?fields=${fields}`, {
      token: args.pageAccessToken,
      timeoutMs: 10_000,
    })
    const fullName =
      p.name || [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || null
    return {
      name: fullName,
      username: p.username ?? null,
      pictureUrl: p.profile_pic ?? null,
    }
  } catch (err) {
    const name = args.pageId
      ? await fetchNameFromConversation({ ...args, pageId: args.pageId })
      : null
    if (!name) {
      console.warn(
        `[social] profile lookup failed for ${args.channel} user:`,
        err instanceof Error ? err.message : err,
      )
    }
    return { name, username: null, pictureUrl: null }
  }
}

// ============================================================
// Sending
// ============================================================

export type SocialAttachmentKind = 'image' | 'video' | 'audio' | 'document'

export type SocialOutboundMessage =
  | { kind: 'text'; text: string }
  | { kind: 'media'; mediaKind: SocialAttachmentKind; url: string }
  | { kind: 'interactive'; payload: InteractiveMessagePayload }

/** Messenger quick replies: ≤ 13 options, titles ≤ 20 chars. */
const MAX_QUICK_REPLIES = 13
const QUICK_REPLY_TITLE_MAX = 20

/**
 * Render a WhatsApp-style interactive payload for Messenger/Instagram.
 * Both channels support quick replies, which carry a stable payload
 * back on tap — the same contract the Flows engine relies on for
 * WhatsApp button / list ids. Header + footer fold into the text.
 */
export function interactiveToQuickReplies(payload: InteractiveMessagePayload) {
  const options =
    payload.kind === 'buttons'
      ? payload.buttons.map((b) => ({ id: b.id, title: b.title }))
      : payload.sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, title: r.title })))
  const text = [payload.header, payload.body, payload.footer]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('\n\n')
  return {
    text,
    quick_replies: options.slice(0, MAX_QUICK_REPLIES).map((o) => ({
      content_type: 'text' as const,
      title: o.title.slice(0, QUICK_REPLY_TITLE_MAX),
      payload: o.id,
    })),
  }
}

function toGraphMessage(message: SocialOutboundMessage) {
  switch (message.kind) {
    case 'text':
      return { text: message.text }
    case 'media':
      return {
        attachment: {
          type: message.mediaKind === 'document' ? 'file' : message.mediaKind,
          payload: { url: message.url, is_reusable: false },
        },
      }
    case 'interactive':
      return interactiveToQuickReplies(message.payload)
  }
}

/**
 * Meta's "outside the allowed messaging window" errors. Messenger
 * reports code 10 / subcode 2018278; Instagram code 10 / 2534022.
 */
export function isOutsideWindowError(err: unknown): boolean {
  if (!(err instanceof GraphApiError)) return false
  return err.code === 10 || err.subcode === 2018278 || err.subcode === 2534022
}

/**
 * Send one message to a PSID / IGSID. Tries a standard RESPONSE first
 * (inside the 24h window); if Meta says the window closed, retries once
 * with the HUMAN_AGENT tag, which extends agent replies to 7 days for
 * apps approved for the Human Agent permission.
 */
export async function sendSocialMessage(args: {
  pageId: string
  pageAccessToken: string
  recipientId: string
  message: SocialOutboundMessage
}): Promise<{ messageId: string }> {
  const base = {
    recipient: { id: args.recipientId },
    message: toGraphMessage(args.message),
  }
  const send = (extra: Record<string, unknown>) =>
    graphRequest<{ message_id?: string }>(`/${encodeURIComponent(args.pageId)}/messages`, {
      method: 'POST',
      token: args.pageAccessToken,
      body: { ...base, ...extra },
    })

  let res: { message_id?: string }
  try {
    res = await send({ messaging_type: 'RESPONSE' })
  } catch (err) {
    if (!isOutsideWindowError(err)) throw err
    res = await send({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' })
  }
  if (!res.message_id) {
    throw new GraphApiError('Meta did not return a message id', 502)
  }
  return { messageId: res.message_id }
}

/** typing_on / mark_seen. Cosmetic — callers swallow failures. */
export async function sendSocialSenderAction(args: {
  pageId: string
  pageAccessToken: string
  recipientId: string
  action: 'typing_on' | 'typing_off' | 'mark_seen'
}) {
  await graphRequest(`/${encodeURIComponent(args.pageId)}/messages`, {
    method: 'POST',
    token: args.pageAccessToken,
    body: { recipient: { id: args.recipientId }, sender_action: args.action },
    timeoutMs: 10_000,
  })
}
