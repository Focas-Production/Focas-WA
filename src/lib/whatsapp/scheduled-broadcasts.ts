// ============================================================
// Scheduled-broadcast runner — fully server-side delivery.
//
// The wizard materializes a scheduled broadcast completely at
// schedule time: audience resolved into broadcast_recipients
// (status 'pending'), wallet prepaid as one campaign debit,
// variables + header media persisted on the row. This module is the
// other half: the cron route calls processDueScheduledBroadcasts(),
// which claims due rows (atomic status flip scheduled → sending, so
// overlapping cron ticks can't double-send) and fans each one out
// through Meta — no browser involved.
//
// Mirrors the pacing of the dashboard sender: batches of 10 with a
// 1 s pause, per-recipient phone-variant retry, per-recipient row
// stamping (the DB trigger keeps aggregate counts), wallet settle
// for never-sent recipients, terminal status at the end.
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
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

const SEND_BATCH_SIZE = 10
const SEND_BATCH_DELAY_MS = 1000

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface DueBroadcast {
  id: string
  account_id: string
  name: string
  template_name: string
  template_language: string
  template_variables: Record<string, VariableMapping> | null
  header_media_url: string | null
}

/**
 * Claim and deliver up to `limit` due scheduled broadcasts. Returns
 * how many were processed. Called by /api/broadcasts/cron.
 */
export async function processDueScheduledBroadcasts(limit = 5): Promise<number> {
  const db = supabaseAdmin()
  const { data: due, error } = await db
    .from('broadcasts')
    .select('id, account_id, name, template_name, template_language, template_variables, header_media_url')
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(limit)
  if (error) {
    console.error('[scheduled-broadcasts] due-scan failed:', error.message)
    return 0
  }
  if (!due || due.length === 0) return 0

  let processed = 0
  for (const row of due) {
    // Atomic claim — only one cron tick wins the scheduled → sending
    // flip; the loser skips the row.
    const { data: claim } = await db
      .from('broadcasts')
      .update({ status: 'sending', updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'scheduled')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    try {
      await deliverScheduledBroadcast(row as DueBroadcast)
    } catch (err) {
      console.error(`[scheduled-broadcasts] delivery of ${row.id} crashed:`, err)
      await db
        .from('broadcasts')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', row.id)
    }
    processed++
  }
  return processed
}

async function deliverScheduledBroadcast(broadcast: DueBroadcast): Promise<void> {
  const db = supabaseAdmin()

  async function failAll(reason: string): Promise<void> {
    await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: reason })
      .eq('broadcast_id', broadcast.id)
      .eq('status', 'pending')
    await db
      .from('broadcasts')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', broadcast.id)
  }

  const { data: config } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', broadcast.account_id)
    .maybeSingle()
  if (!config) {
    await failAll('WhatsApp not configured')
    return
  }
  const accessToken = decrypt(config.access_token)

  const { data: rawTemplateRow } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', broadcast.account_id)
    .eq('name', broadcast.template_name)
    .eq('language', broadcast.template_language)
    .maybeSingle()
  if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
    await failAll('Template row is malformed locally — run "Sync from Meta" in Settings.')
    return
  }
  const templateRow = (rawTemplateRow as MessageTemplate | null) ?? null

  const { data: recipientRows } = await db
    .from('broadcast_recipients')
    .select('id, status, contact:contacts(*)')
    .eq('broadcast_id', broadcast.id)
    .eq('status', 'pending')
  // The embedded contact is a to-one join; without generated DB types
  // supabase-js can't know that, so re-shape through unknown once.
  const recipients = (recipientRows ?? []) as unknown as Array<{
    id: string
    status: string
    contact: Contact | null
  }>
  if (recipients.length === 0) {
    await db
      .from('broadcasts')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', broadcast.id)
    return
  }

  // Wallet: the wizard prepays at schedule time; charge here only as
  // a fallback for rows scheduled before that flow existed. A dry
  // wallet fails the whole campaign — no partial sends.
  const prepaid = await hasBroadcastDebit(broadcast.account_id, broadcast.id)
  if (!prepaid) {
    const { category, pricePaise } = await getTemplateCharge(
      broadcast.account_id,
      broadcast.template_name,
      broadcast.template_language,
    )
    try {
      await chargeTemplateSend({
        accountId: broadcast.account_id,
        reference: `broadcast:${broadcast.id}`,
        category,
        pricePaise,
        quantity: recipients.length,
        description: `Broadcast "${broadcast.name}" — ${recipients.length} × Template "${broadcast.template_name}"`,
      })
    } catch (err) {
      const message =
        err instanceof WalletError && err.code === 'insufficient_balance'
          ? 'Insufficient wallet balance'
          : 'Wallet charge failed'
      await failAll(message)
      return
    }
  }

  const contactIds = recipients
    .map((r) => r.contact?.id)
    .filter((id): id is string => Boolean(id))
  const customValueIndex = await fetchCustomValueIndex(db, contactIds)

  const variables = broadcast.template_variables ?? {}
  const headerType = templateRow?.header_type
  const isMediaHeader =
    headerType === 'image' || headerType === 'video' || headerType === 'document'
  const headerMediaUrl = broadcast.header_media_url?.trim()
  const messageParams =
    isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined

  let sentCount = 0
  for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
    const batch = recipients.slice(i, i + SEND_BATCH_SIZE)

    for (const recipient of batch) {
      const contact = recipient.contact
      const sanitized = sanitizePhoneForMeta(contact?.phone ?? '')
      if (!contact || !isValidE164(sanitized)) {
        await db
          .from('broadcast_recipients')
          .update({ status: 'failed', error_message: 'Invalid phone number' })
          .eq('id', recipient.id)
        continue
      }

      const params = resolveVariables(
        variables,
        contact,
        customValueIndex.get(contact.id),
      )

      let sentMessageId: string | null = null
      let lastError: string | null = null
      for (const variant of phoneVariants(sanitized)) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: broadcast.template_name,
            language: broadcast.template_language,
            template: templateRow ?? undefined,
            params,
            messageParams,
          })
          sentMessageId = result.messageId
          lastError = null
          break
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error'
          lastError = message
          if (!isRecipientNotAllowedError(message)) break
        }
      }

      if (sentMessageId) {
        sentCount++
        await db
          .from('broadcast_recipients')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            whatsapp_message_id: sentMessageId,
            error_message: null,
          })
          .eq('id', recipient.id)
      } else {
        await db
          .from('broadcast_recipients')
          .update({
            status: 'failed',
            error_message: lastError || 'Unknown error',
          })
          .eq('id', recipient.id)
      }
    }

    if (i + SEND_BATCH_SIZE < recipients.length) {
      await sleep(SEND_BATCH_DELAY_MS)
    }
  }

  // One aggregate refund row for recipients that never reached Meta.
  await settleBroadcastCharge(broadcast.account_id, broadcast.id)

  await db
    .from('broadcasts')
    .update({
      status: sentCount > 0 ? 'sent' : 'failed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcast.id)
}
