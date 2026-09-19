// ============================================================
// Campaign engine — the one place WhatsApp campaigns are sent.
//
// "Send now" (kicked from POST /api/broadcasts/launch via after()),
// scheduled campaigns and crash recovery (both from the
// /api/broadcasts/cron tick) all run through runBroadcast(). Nothing
// runs in a browser tab: closing the dashboard never stops a send.
//
// Throughput. Recipients go out over parallel lanes, paced per
// business phone number to 80 % of Meta's throughput cap (80 msg/s by
// default, a fixed 20 msg/s for coexistence numbers also used in the
// WhatsApp Business app), further capped by BROADCAST_MAX_MPS
// (default 40). 2,500 recipients take ~1 min on a normal number and
// ~3 min on a coexistence number. Campaigns running at the same time
// on one number share its pacer, so their combined rate stays under
// the cap.
//
// Inbox. Every sent message is also copied into the contact's inbox
// thread (created if missing), so agents see what went out when the
// customer replies.
//
// Failures. Throttles (130429, HTTP 429) and Meta outages (5xx,
// 131000, 133004, network errors) are retried with backoff;
// per-recipient errors (not on WhatsApp, 131049 marketing limit, …)
// fail that recipient only. Account-wide errors (expired token,
// payment issue, template paused/deleted) stop the campaign at once,
// as does a run of 25 failures with nothing sent — instead of
// burning through the whole audience with the same error.
//
// Crash safety. The broadcasts row carries a lease (locked_until)
// renewed every 5 s. If the process dies, the lease lapses and the
// next cron tick resumes from the unsent recipients. Each recipient
// is claimed (attempted_at) right before its Meta call; a resumed
// run fails — rather than re-sends — the few that were mid-flight
// when the process died, so nobody gets the campaign twice. On
// SIGTERM (deploys) the engine stops taking new recipients, lets
// in-flight sends finish and hands the lease back for an immediate
// resume.
//
// Single-instance assumption: pacing is in-process (like
// src/lib/rate-limit.ts). Running several app instances multiplies
// the send rate; per-recipient claims still prevent double sends.
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { selectByChunks } from '@/lib/supabase/select-all'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { findOrCreateConversationRow } from '@/lib/whatsapp/resolve-conversation'
import { renderTemplateBody } from '@/lib/whatsapp/template-render'
import {
  sendTemplateMessage,
  getPhoneSendingProfile,
  MetaApiError,
  type PhoneSendingProfile,
} from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import {
  resolveVariables,
  fetchCustomValueIndex,
  type VariableMapping,
} from '@/lib/whatsapp/variable-resolution'
import {
  getTemplateCharge,
  chargeTemplateSend,
  hasBroadcastDebit,
  settleBroadcastCharge,
  WalletError,
} from '@/lib/wallet/wallet'
import type { Contact, MessageTemplate } from '@/types'

const LEASE_MS = 90_000
const HEARTBEAT_MS = 5_000
/** A campaign whose process died longer ago than this is not resumed. */
const MAX_RESUME_AGE_MS = 60 * 60_000
const PAGE_SIZE = 500
const MAX_SEND_ATTEMPTS = 4
const THROTTLE_PAUSE_MS = 2_000
const BREAKER_THRESHOLD = 25
const DEFAULT_MAX_MPS = 40
/** Fraction of Meta's per-number cap we target — headroom for inbound + inbox traffic. */
const META_CAP_HEADROOM = 0.8

const INTERRUPTED_MESSAGE =
  'Interrupted mid-send — delivery unknown, not retried to avoid a duplicate'
const ABANDONED_MESSAGE = 'Interrupted — campaign was not resumed within 1 hour'
const CANCELLED_MESSAGE = 'Cancelled'

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ------------------------------------------------------------
// Meta error classification
// ------------------------------------------------------------

export type SendErrorKind =
  | 'throttled' // back off, then retry
  | 'transient' // Meta/network hiccup, retry
  | 'recipient_not_allowed' // sandbox allow-list — try the next phone variant
  | 'fatal' // account/template-wide — stop the campaign
  | 'permanent' // this recipient only

const THROTTLE_CODES = new Set([4, 613, 80007, 130429, 131056])
const TRANSIENT_CODES = new Set([1, 2, 131000, 131016, 131057, 133004])
const FATAL_CODES = new Set([
  10, // permission denied
  190, // access token expired / invalid
  200, // missing permission
  131005, // access denied
  131031, // business account locked
  131042, // payment method issue
  132001, // template doesn't exist in this language
  132015, // template paused for low quality
  132016, // template disabled
  133010, // phone number not registered
])

export function classifySendError(err: unknown): SendErrorKind {
  if (err instanceof MetaApiError) {
    if (err.code === 131030 || isRecipientNotAllowedError(err.message)) {
      return 'recipient_not_allowed'
    }
    if (err.status === 429 || (err.code !== undefined && THROTTLE_CODES.has(err.code))) {
      return 'throttled'
    }
    if (err.code !== undefined && FATAL_CODES.has(err.code)) return 'fatal'
    if (err.status >= 500 || (err.code !== undefined && TRANSIENT_CODES.has(err.code))) {
      return 'transient'
    }
    return 'permanent'
  }
  // fetch() rejects with a TypeError when the request never got a
  // response (DNS, reset, refused). A timeout (AbortSignal) is NOT
  // retried: Meta may have accepted the message before we gave up.
  if (err instanceof TypeError && /fetch failed|network|socket/i.test(err.message)) {
    return 'transient'
  }
  return 'permanent'
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return 'Timed out waiting for Meta — delivery unknown'
  }
  return err instanceof Error ? err.message : 'Unknown error'
}

/** Exponential backoff with jitter: ~1 s, 2 s, 4 s … capped at 30 s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250)
}

// ------------------------------------------------------------
// Pacing
// ------------------------------------------------------------

/**
 * Hands out evenly spaced send slots — `take()` resolves at the
 * caller's slot. `pause()` pushes every later slot back (on a Meta
 * throttle signal).
 */
export class Pacer {
  private intervalMs: number
  private nextSlot = 0

  constructor(messagesPerSecond: number) {
    this.intervalMs = 1000 / messagesPerSecond
  }

  setRate(messagesPerSecond: number) {
    this.intervalMs = 1000 / messagesPerSecond
  }

  async take(): Promise<void> {
    const now = Date.now()
    const slot = Math.max(now, this.nextSlot)
    this.nextSlot = slot + this.intervalMs
    if (slot > now) await sleep(slot - now)
  }

  pause(ms: number) {
    this.nextSlot = Math.max(this.nextSlot, Date.now() + ms)
  }
}

/** One pacer per business phone number, shared by concurrent campaigns. */
const pacers = new Map<string, Pacer>()

function pacerFor(phoneNumberId: string, messagesPerSecond: number): Pacer {
  let pacer = pacers.get(phoneNumberId)
  if (!pacer) {
    pacer = new Pacer(messagesPerSecond)
    pacers.set(phoneNumberId, pacer)
  } else {
    pacer.setRate(messagesPerSecond)
  }
  return pacer
}

/**
 * Messages/second for this number: BROADCAST_MAX_MPS (default 40),
 * never above 80 % of Meta's cap — 20 for coexistence numbers (and
 * when the number couldn't be looked up), 1,000 for upgraded
 * high-throughput numbers, 80 otherwise.
 */
export function targetMessagesPerSecond(
  profile: PhoneSendingProfile | null,
  configured = Number(process.env.BROADCAST_MAX_MPS),
): number {
  const metaCap =
    !profile || profile.isCoexistence ? 20 : profile.throughputLevel === 'HIGH' ? 1000 : 80
  const wanted = configured > 0 ? configured : DEFAULT_MAX_MPS
  return Math.max(1, Math.min(wanted, Math.floor(metaCap * META_CAP_HEADROOM)))
}

/**
 * Run `worker` over `items` on `concurrency` lanes. Stops handing out
 * items once `shouldStop()` is true; a worker that throws stops the
 * pool too. Always waits for in-flight workers before returning, so
 * nothing keeps sending after the caller moves on, then rethrows the
 * first error.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  let next = 0
  let failure: { error: unknown } | null = null
  const lane = async () => {
    while (!failure && !shouldStop() && next < items.length) {
      const item = items[next++]
      try {
        await worker(item)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, lane),
  )
  if (failure) throw (failure as { error: unknown }).error
}

// ------------------------------------------------------------
// Graceful shutdown
// ------------------------------------------------------------

let shuttingDown = false
let watchingSignals = false

/**
 * Stop taking new recipients on SIGTERM/SIGINT. Only piggybacks on a
 * signal the host already handles (Next's server does, and waits for
 * after() work before exiting) — being a signal's FIRST listener would
 * cancel Node's default exit-on-signal.
 */
function watchForShutdown() {
  if (watchingSignals || typeof process?.listenerCount !== 'function') return
  watchingSignals = true
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    if (process.listenerCount(signal) > 0) {
      process.once(signal, () => {
        shuttingDown = true
      })
    }
  }
}

// ------------------------------------------------------------
// Claiming + queue
// ------------------------------------------------------------

const BROADCAST_COLUMNS =
  'id, account_id, name, template_name, template_language, template_variables, header_media_url'

interface ClaimedBroadcast {
  id: string
  account_id: string
  name: string
  template_name: string
  template_language: string
  template_variables: Record<string, VariableMapping> | null
  header_media_url: string | null
}

function leaseUntil(): string {
  return new Date(Date.now() + LEASE_MS).toISOString()
}

/**
 * Atomically take a campaign: a due 'scheduled' row flips to
 * 'sending', or a 'sending' row whose lease lapsed (its process died)
 * gets a fresh lease. Postgres re-checks the WHERE under the row lock,
 * so two claimers can never both win. Rows 'sending' from before
 * migration 044 have no lease and are never picked up.
 */
async function claimBroadcast(
  id: string,
): Promise<{ row: ClaimedBroadcast; resumed: boolean } | null> {
  const db = supabaseAdmin()
  const nowIso = new Date().toISOString()

  const { data: fresh } = await db
    .from('broadcasts')
    .update({ status: 'sending', locked_until: leaseUntil() })
    .eq('id', id)
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso)
    .select(BROADCAST_COLUMNS)
    .maybeSingle()
  if (fresh) return { row: fresh as ClaimedBroadcast, resumed: false }

  const { data: stale } = await db
    .from('broadcasts')
    .update({ locked_until: leaseUntil() })
    .eq('id', id)
    .eq('status', 'sending')
    .lt('locked_until', nowIso)
    .select(BROADCAST_COLUMNS)
    .maybeSingle()
  if (stale) return { row: stale as ClaimedBroadcast, resumed: true }

  return null
}

export interface BroadcastQueue {
  /** Due scheduled campaigns + recently interrupted ones to resume. */
  run: string[]
  /**
   * Campaigns to close without sending: interrupted longer than
   * MAX_RESUME_AGE_MS ago ('sending'), or stopped by the user while
   * their process died before it could settle ('cancelled').
   */
  close: { id: string; status: 'sending' | 'cancelled' }[]
}

/** What the cron tick should do. Cheap; the claims happen in runQueue. */
export async function scanBroadcastQueue(): Promise<BroadcastQueue> {
  const db = supabaseAdmin()
  const now = Date.now()
  const nowIso = new Date(now).toISOString()

  const [{ data: due }, { data: stale }] = await Promise.all([
    db
      .from('broadcasts')
      .select('id')
      .eq('status', 'scheduled')
      .lte('scheduled_at', nowIso)
      .order('scheduled_at', { ascending: true })
      .limit(20),
    // A lapsed lease: the process running it is gone. (Leases are
    // cleared when a campaign closes, so finished rows never match.)
    db
      .from('broadcasts')
      .select('id, status, locked_until')
      .in('status', ['sending', 'cancelled'])
      .lt('locked_until', nowIso)
      .limit(20),
  ])

  const resumable: string[] = []
  const close: BroadcastQueue['close'] = []
  for (const row of stale ?? []) {
    const id = row.id as string
    const lapsedAt = new Date(row.locked_until as string).getTime()
    if (row.status === 'cancelled') close.push({ id, status: 'cancelled' })
    else if (now - lapsedAt > MAX_RESUME_AGE_MS) close.push({ id, status: 'sending' })
    else resumable.push(id)
  }
  return { run: [...(due ?? []).map((r) => r.id as string), ...resumable], close }
}

export async function runQueue(queue: BroadcastQueue): Promise<void> {
  for (const { id, status } of queue.close) {
    await closeBroadcast(id, status).catch((err) =>
      console.error(`[broadcast-engine] closing ${id} failed:`, err),
    )
  }
  await Promise.all(queue.run.map((id) => runBroadcast(id)))
}

/** Campaigns this process is currently sending. */
const activeRuns = new Set<string>()

/**
 * Claim and deliver one campaign. Never throws: a crash mid-run is
 * logged and left to the lease — the campaign resumes on a later
 * cron tick.
 */
export async function runBroadcast(id: string): Promise<void> {
  if (activeRuns.has(id)) return
  activeRuns.add(id)
  watchForShutdown()
  try {
    const claim = await claimBroadcast(id)
    if (!claim) return
    await deliver(claim.row, claim.resumed)
  } catch (err) {
    console.error(`[broadcast-engine] campaign ${id} crashed; will resume:`, err)
  } finally {
    activeRuns.delete(id)
  }
}

/**
 * Close a dead campaign without sending: fail what's left, refund it,
 * clear the lease. Claimed under a fresh lease first so two ticks
 * can't both close (and double-settle) it.
 */
async function closeBroadcast(id: string, status: 'sending' | 'cancelled'): Promise<void> {
  const db = supabaseAdmin()
  const lapsedBefore =
    status === 'sending'
      ? new Date(Date.now() - MAX_RESUME_AGE_MS).toISOString()
      : new Date().toISOString()
  const { data } = await db
    .from('broadcasts')
    .update({ locked_until: leaseUntil() })
    .eq('id', id)
    .eq('status', status)
    .lt('locked_until', lapsedBefore)
    .select('id, account_id')
    .maybeSingle()
  if (!data) return
  await failUnsent(id, INTERRUPTED_MESSAGE, true)
  await failUnsent(id, status === 'cancelled' ? CANCELLED_MESSAGE : ABANDONED_MESSAGE, false)
  await finish(id, data.account_id as string)
}

// ------------------------------------------------------------
// Delivery
// ------------------------------------------------------------

type StopReason =
  | { kind: 'cancelled' }
  | { kind: 'lost' } // row no longer ours (deleted / finished elsewhere)
  | { kind: 'shutdown' }
  | { kind: 'fatal'; message: string }

interface RecipientRow {
  id: string
  contact: Contact | null
}

/**
 * Fail recipients that will not be sent. `attempted` picks the
 * mid-send ones (claimed, result never recorded) vs never-claimed.
 */
async function failUnsent(
  broadcastId: string,
  message: string,
  attempted: boolean,
): Promise<void> {
  const query = supabaseAdmin()
    .from('broadcast_recipients')
    .update({ status: 'failed', error_message: message })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending')
  const { error } = attempted
    ? await query.not('attempted_at', 'is', null)
    : await query.is('attempted_at', null)
  if (error) throw new Error(`failing unsent recipients: ${error.message}`)
}

/**
 * Refund never-sent recipients (one ledger row) and set the final
 * status — 'sent' if anything reached Meta. A cancelled campaign keeps
 * its 'cancelled' status.
 */
async function finish(broadcastId: string, accountId: string): Promise<void> {
  const db = supabaseAdmin()
  await settleBroadcastCharge(accountId, broadcastId)

  const { count } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .not('whatsapp_message_id', 'is', null)
  await db
    .from('broadcasts')
    .update({ status: (count ?? 0) > 0 ? 'sent' : 'failed' })
    .eq('id', broadcastId)
    .eq('status', 'sending')
  await db.from('broadcasts').update({ locked_until: null }).eq('id', broadcastId)
}

/**
 * Copies each sent campaign message into the contact's inbox thread
 * (the one conversation per contact, created if missing) so agents see
 * what the customer received — same as a template sent from the
 * composer. sender_type 'bot', like automation sends: it wasn't typed
 * by an agent, and agent-message stats on the dashboard stay honest.
 *
 * Best-effort: the message already reached Meta, so a failed inbox
 * write is logged, never allowed to fail the recipient or the run.
 */
function createInboxRecorder(accountId: string, templateName: string, body: string | null) {
  const db = supabaseAdmin()
  const conversations = new Map<string, string>()
  // undefined = not looked up yet; null = lookup failed (then only
  // existing conversations get the copy).
  let auditUserId: string | null | undefined

  return {
    /** Load the existing threads for a page of contacts in bulk. */
    async preload(contactIds: string[]): Promise<void> {
      const missing = contactIds.filter((id) => !conversations.has(id))
      try {
        const rows = await selectByChunks<{ id: string; contact_id: string }>(
          missing,
          (chunk) =>
            db
              .from('conversations')
              .select('id, contact_id')
              .eq('account_id', accountId)
              .in('contact_id', chunk)
              .order('created_at', { ascending: true }),
        )
        for (const row of rows) {
          if (!conversations.has(row.contact_id)) conversations.set(row.contact_id, row.id)
        }
      } catch (err) {
        console.warn('[broadcast-engine] conversation preload failed:', err)
      }
    },

    async record(contactId: string, whatsappMessageId: string, params: string[]): Promise<void> {
      try {
        let conversationId = conversations.get(contactId)
        if (!conversationId) {
          if (auditUserId === undefined) {
            auditUserId = await resolveAuditUserId(db, accountId).catch(() => null)
          }
          if (!auditUserId) return
          conversationId = await findOrCreateConversationRow(db, accountId, contactId, auditUserId)
          conversations.set(contactId, conversationId)
        }

        const text = body ? renderTemplateBody(body, params) : `[template:${templateName}]`
        const { error } = await db.from('messages').insert({
          conversation_id: conversationId,
          sender_type: 'bot',
          content_type: 'template',
          content_text: text,
          template_name: templateName,
          // Lets delivery/read webhooks tick this copy too.
          message_id: whatsappMessageId,
          status: 'sent',
        })
        if (error) throw new Error(error.message)

        const now = new Date().toISOString()
        await db
          .from('conversations')
          .update({ last_message_text: text, last_message_at: now, updated_at: now })
          .eq('id', conversationId)
      } catch (err) {
        console.warn(`[broadcast-engine] inbox copy for contact ${contactId} failed:`, err)
      }
    },
  }
}

/** Write a recipient's result; retried because a lost write means an unknown outcome. */
async function recordResult(
  recipientId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  let lastError = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(patch)
      .eq('id', recipientId)
    if (!error) return
    lastError = error.message
    await sleep(500 * (attempt + 1))
  }
  throw new Error(`recording recipient ${recipientId}: ${lastError}`)
}

async function deliver(broadcast: ClaimedBroadcast, resumed: boolean): Promise<void> {
  const db = supabaseAdmin()
  const broadcastId = broadcast.id
  let stop: StopReason | null = null
  const shouldStop = () => {
    if (!stop && shuttingDown) stop = { kind: 'shutdown' }
    return stop !== null
  }

  // Lease renewal doubles as the cancel check: once the row is no
  // longer 'sending' (Stop button → 'cancelled'), the update matches
  // nothing and the run winds down.
  let crashed = false
  let beating = false
  const heartbeat = setInterval(async () => {
    if (beating || stop) return
    beating = true
    try {
      const { data, error } = await db
        .from('broadcasts')
        .update({ locked_until: leaseUntil() })
        .eq('id', broadcastId)
        .eq('status', 'sending')
        .select('id')
        .maybeSingle()
      if (error || data) return // a failed renewal is retried; the lease has slack
      const { data: row } = await db
        .from('broadcasts')
        .select('status')
        .eq('id', broadcastId)
        .maybeSingle()
      stop ??= row?.status === 'cancelled' ? { kind: 'cancelled' } : { kind: 'lost' }
    } catch (err) {
      console.warn(`[broadcast-engine] lease renewal for ${broadcastId} failed:`, err)
    } finally {
      beating = false
    }
  }, HEARTBEAT_MS)

  try {
    if (resumed) await failUnsent(broadcastId, INTERRUPTED_MESSAGE, true)

    const { data: config } = await db
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', broadcast.account_id)
      .maybeSingle()
    if (!config) {
      stop = { kind: 'fatal', message: 'WhatsApp not configured' }
      return
    }
    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      stop = { kind: 'fatal', message: 'WhatsApp access token could not be decrypted — reconnect WhatsApp in Settings.' }
      return
    }
    const phoneNumberId = config.phone_number_id as string

    const { data: rawTemplateRow } = await db
      .from('message_templates')
      .select('*')
      .eq('account_id', broadcast.account_id)
      .eq('name', broadcast.template_name)
      .eq('language', broadcast.template_language)
      .maybeSingle()
    if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
      stop = {
        kind: 'fatal',
        message: 'Template row is malformed locally — run "Sync from Meta" in Settings.',
      }
      return
    }
    const templateRow = (rawTemplateRow as MessageTemplate | null) ?? null

    // Launches prepay; charge here only for rows queued without a
    // debit (scheduled before the wallet existed).
    if (!(await hasBroadcastDebit(broadcast.account_id, broadcastId))) {
      const { count } = await db
        .from('broadcast_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', broadcastId)
        .eq('status', 'pending')
      const { category, pricePaise } = await getTemplateCharge(
        broadcast.account_id,
        broadcast.template_name,
        broadcast.template_language,
      )
      try {
        await chargeTemplateSend({
          accountId: broadcast.account_id,
          reference: `broadcast:${broadcastId}`,
          category,
          pricePaise,
          quantity: count ?? 0,
          description: `Broadcast "${broadcast.name}" — ${count ?? 0} × Template "${broadcast.template_name}"`,
        })
      } catch (err) {
        stop = {
          kind: 'fatal',
          message:
            err instanceof WalletError && err.code === 'insufficient_balance'
              ? 'Insufficient wallet balance'
              : 'Wallet charge failed',
        }
        return
      }
    }

    let profile: PhoneSendingProfile | null = null
    try {
      profile = await getPhoneSendingProfile({ phoneNumberId, accessToken })
    } catch (err) {
      if (classifySendError(err) === 'fatal') {
        stop = { kind: 'fatal', message: errorText(err) }
        return
      }
      console.warn('[broadcast-engine] throughput lookup failed, pacing conservatively:', err)
    }
    const rate = targetMessagesPerSecond(profile)
    const pacer = pacerFor(phoneNumberId, rate)
    // A lane's round trip is the Meta call plus the recipient + inbox
    // writes (~1–2 s), so run 2× the rate; the pacer holds the rate.
    const concurrency = Math.min(64, Math.max(4, rate * 2))

    const inbox = createInboxRecorder(
      broadcast.account_id,
      broadcast.template_name,
      templateRow?.body_text ?? null,
    )
    const variables = broadcast.template_variables ?? {}
    const headerType = templateRow?.header_type
    const headerMediaUrl = broadcast.header_media_url?.trim()
    const messageParams: SendTimeParams | undefined =
      (headerType === 'image' || headerType === 'video' || headerType === 'document') &&
      headerMediaUrl
        ? { headerMediaUrl }
        : undefined

    let succeeded = 0
    let failed = 0

    const sendTo = async (recipient: RecipientRow, customValues: Map<string, string> | undefined) => {
      // Per-recipient claim: loses to a Stop (row no longer pending)
      // or to another run that already claimed it.
      const { data: claimed, error: claimErr } = await db
        .from('broadcast_recipients')
        .update({ attempted_at: new Date().toISOString() })
        .eq('id', recipient.id)
        .eq('status', 'pending')
        .is('attempted_at', null)
        .select('id')
        .maybeSingle()
      if (claimErr) throw new Error(`claiming recipient ${recipient.id}: ${claimErr.message}`)
      if (!claimed) return

      const contact = recipient.contact
      const phone = sanitizePhoneForMeta(contact?.phone ?? '')
      if (!contact || !isValidE164(phone)) {
        await recordResult(recipient.id, { status: 'failed', error_message: 'Invalid phone number' })
        return
      }

      const params = resolveVariables(variables, contact, customValues)
      let messageId: string | null = null
      let lastError: unknown = null
      let retry = false

      attempts: for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
        retry = false
        for (const variant of phoneVariants(phone)) {
          await pacer.take()
          try {
            const result = await sendTemplateMessage({
              phoneNumberId,
              accessToken,
              to: variant,
              templateName: broadcast.template_name,
              language: broadcast.template_language,
              template: templateRow ?? undefined,
              params,
              messageParams,
            })
            messageId = result.messageId
            break attempts
          } catch (err) {
            lastError = err
            const kind = classifySendError(err)
            if (kind === 'recipient_not_allowed') continue
            if (kind === 'throttled') pacer.pause(THROTTLE_PAUSE_MS)
            retry = kind === 'throttled' || kind === 'transient'
            break
          }
        }
        if (!retry || attempt === MAX_SEND_ATTEMPTS - 1 || shouldStop()) break
        await sleep(backoffMs(attempt))
      }

      if (messageId) {
        succeeded++
        await recordResult(recipient.id, {
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: messageId,
          error_message: null,
        })
        await inbox.record(contact.id, messageId, params)
        void dispatchWebhookEvent(db, broadcast.account_id, 'template.message.sent', {
          whatsapp_message_id: messageId,
          template_name: broadcast.template_name,
          language: broadcast.template_language,
          phone: contact.phone,
          source: 'broadcast',
        })
        return
      }

      if (retry && shouldStop()) {
        // Stopped while backing off from a throttle/outage: Meta never
        // took this message, so release the claim — a resumed run
        // sends it, a cancel fails it as 'Cancelled'.
        await recordResult(recipient.id, { attempted_at: null })
        return
      }

      failed++
      const message = errorText(lastError)
      await recordResult(recipient.id, { status: 'failed', error_message: message })
      void dispatchWebhookEvent(db, broadcast.account_id, 'template.message.failed', {
        template_name: broadcast.template_name,
        phone: contact.phone,
        error: message,
        source: 'broadcast',
      })

      if (classifySendError(lastError) === 'fatal') {
        stop ??= { kind: 'fatal', message }
      } else if (succeeded === 0 && failed >= BREAKER_THRESHOLD) {
        stop ??= {
          kind: 'fatal',
          message: `Stopped: the first ${failed} sends all failed. Last error: ${message}`,
        }
      }
    }

    let lastId: string | null = null
    while (!shouldStop()) {
      let query = db
        .from('broadcast_recipients')
        .select('id, contact:contacts(*)')
        .eq('broadcast_id', broadcastId)
        .eq('status', 'pending')
        .is('attempted_at', null)
        .order('id')
        .limit(PAGE_SIZE)
      if (lastId) query = query.gt('id', lastId)
      const { data, error } = await query
      if (error) throw new Error(`loading recipients: ${error.message}`)
      // contact is a to-one embed; supabase-js can't infer that
      // without generated types.
      const page = (data ?? []) as unknown as RecipientRow[]
      if (page.length === 0) break
      lastId = page[page.length - 1].id

      const contactIds = page
        .map((r) => r.contact?.id)
        .filter((id): id is string => Boolean(id))
      const customValues = await fetchCustomValueIndex(db, contactIds)
      await inbox.preload(contactIds)
      await runPool(
        page,
        concurrency,
        (r) => sendTo(r, r.contact ? customValues.get(r.contact.id) : undefined),
        shouldStop,
      )
    }
  } catch (err) {
    crashed = true
    throw err
  } finally {
    clearInterval(heartbeat)
    // After a crash (usually the database) nothing here can be trusted
    // — leave the lease to lapse and let the cron tick resume or close
    // the campaign once things recover.
    if (!crashed) await wrapUp(broadcast, stop)
  }
}

/** Settle a run according to why it ended. */
async function wrapUp(broadcast: ClaimedBroadcast, stop: StopReason | null): Promise<void> {
  const db = supabaseAdmin()
  if (stop?.kind === 'lost') return
  if (stop?.kind === 'shutdown') {
    // Hand the lease back so the next process resumes on its first
    // cron tick instead of waiting for it to lapse.
    await db
      .from('broadcasts')
      .update({ locked_until: new Date(Date.now() - 1).toISOString() })
      .eq('id', broadcast.id)
      .eq('status', 'sending')
    return
  }
  if (stop?.kind === 'cancelled') {
    await failUnsent(broadcast.id, CANCELLED_MESSAGE, false)
  } else if (stop?.kind === 'fatal') {
    await failUnsent(broadcast.id, stop.message, false)
  } else {
    // Normal completion. Rows still pending were claimed by another
    // run (which will close the campaign) — or the count failed; either
    // way, don't close it from here.
    const { count, error } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcast.id)
      .eq('status', 'pending')
    if (error || (count ?? 0) > 0) return
  }
  await finish(broadcast.id, broadcast.account_id)
}

/** Sending profile for an account's number; null when unknown. */
export async function getAccountSendingProfile(
  accountId: string,
): Promise<PhoneSendingProfile | null> {
  const { data: config } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!config) return null
  try {
    return await getPhoneSendingProfile({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
    })
  } catch {
    return null
  }
}
