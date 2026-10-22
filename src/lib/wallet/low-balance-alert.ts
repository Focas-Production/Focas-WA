// ============================================================
// Low-balance reminders — email to the workspace owners and a
// WhatsApp template to WALLET_ALERT_PHONES, sent once each time the
// balance drops below the wallet's threshold (₹100 by default).
//
// "Once per crossing" is enforced in the database (migration 050):
// wallet_claim_low_balance_alert() stamps low_balance_alerted_at and
// returns a row only to the single caller that should send; a
// trigger clears the stamp when the balance recovers.
//
// Environment:
//   WALLET_ALERT_PHONES — comma-separated WhatsApp numbers with
//     country code (e.g. 917305504500,919876543210). Unset → no
//     WhatsApp reminder.
//   SMTP_* — see lib/email/smtp.ts. Unset → no email reminder.
//
// The WhatsApp reminder uses the pre-approved UTILITY template
// below, sent from the workspace's own number. Like the approval
// OTP it is deliberately NOT debited from the wallet — the wallet is
// nearly empty by definition. Live body (params in this order):
//
//   Account update for workspace {{1}}: your WhatsApp wallet balance
//   is {{2}}, below the {{3}} alert limit. Template messages will
//   stop sending when the balance runs out. Add money in Settings →
//   Wallet.
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { isEmailConfigured, sendEmail } from '@/lib/email/smtp'
import { formatPaiseINR } from '@/lib/currency'
import type { MessageTemplate } from '@/types'

export const WALLET_LOW_BALANCE_TEMPLATE = 'wallet_low_balance'

/** Valid E.164 numbers from WALLET_ALERT_PHONES; invalid entries are logged and skipped. */
export function getAlertPhones(): string[] {
  return (process.env.WALLET_ALERT_PHONES ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((raw) => {
      const phone = sanitizePhoneForMeta(raw)
      if (isValidE164(phone)) return [phone]
      console.error(`[wallet] WALLET_ALERT_PHONES entry is not a valid number: ${raw}`)
      return []
    })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Send the low-balance reminders if this account just crossed below
 * its threshold. Call after every successful debit. Best-effort:
 * never throws, so a mail/Meta outage can't fail the send that
 * triggered it.
 */
export async function maybeSendLowBalanceAlert(accountId: string): Promise<void> {
  try {
    const db = supabaseAdmin()
    const { data: claimed, error } = await db.rpc('wallet_claim_low_balance_alert', {
      p_account_id: accountId,
    })
    if (error) {
      console.error('[wallet] low-balance claim failed:', error.message)
      return
    }
    const row = Array.isArray(claimed) ? claimed[0] : claimed
    if (!row) return // above threshold, or already alerted this crossing

    await sendLowBalanceAlert(
      accountId,
      Number(row.balance_paise),
      Number(row.threshold_paise),
    )
  } catch (err) {
    console.error('[wallet] low-balance alert failed:', err)
  }
}

/**
 * Send the reminders unconditionally (no claim / dedupe). Split out
 * of maybeSendLowBalanceAlert so the delivery can be exercised on its
 * own. Never throws.
 */
export async function sendLowBalanceAlert(
  accountId: string,
  balancePaise: number,
  thresholdPaise: number,
): Promise<void> {
  try {
    const db = supabaseAdmin()
    const balance = formatPaiseINR(balancePaise)
    const threshold = formatPaiseINR(thresholdPaise)

    const [{ data: account }, { data: owners }] = await Promise.all([
      db.from('accounts').select('name').eq('id', accountId).maybeSingle(),
      db
        .from('profiles')
        .select('email')
        .eq('account_id', accountId)
        .eq('account_role', 'owner'),
    ])
    const workspace = account?.name ?? 'your workspace'

    await Promise.allSettled([
      emailOwners(
        (owners ?? []).map((o) => o.email as string | null).filter((e): e is string => !!e),
        workspace,
        balance,
        threshold,
      ),
      whatsappAlertPhones(accountId, workspace, balance, threshold),
    ])
  } catch (err) {
    console.error('[wallet] low-balance alert failed:', err)
  }
}

async function emailOwners(
  to: string[],
  workspace: string,
  balance: string,
  threshold: string,
): Promise<void> {
  if (!isEmailConfigured() || to.length === 0) return
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '')
  const link = site ? `${site}/settings?tab=wallet` : null
  try {
    await sendEmail({
      to,
      subject: `Low wallet balance: ${balance} left in ${workspace}`,
      text: [
        `Your WhatsApp wallet balance for ${workspace} is ${balance}, below the ${threshold} alert limit.`,
        'Template messages (broadcasts, automations, inbox templates) will stop sending when the balance runs out.',
        link ? `Add money: ${link}` : 'Add money in Settings → Wallet.',
      ].join('\n\n'),
      html: `
        <p>Your WhatsApp wallet balance for <strong>${escapeHtml(workspace)}</strong> is
        <strong>${balance}</strong>, below the ${threshold} alert limit.</p>
        <p>Template messages (broadcasts, automations, inbox templates) will stop sending when the balance runs out.</p>
        <p>${link ? `<a href="${escapeHtml(link)}">Add money to the wallet</a>` : 'Add money in Settings → Wallet.'}</p>
      `,
    })
  } catch (err) {
    console.error('[wallet] low-balance email failed:', err instanceof Error ? err.message : err)
  }
}

async function whatsappAlertPhones(
  accountId: string,
  workspace: string,
  balance: string,
  threshold: string,
): Promise<void> {
  const phones = getAlertPhones()
  if (phones.length === 0) return

  const db = supabaseAdmin()
  const [{ data: config }, { data: rawTemplate }] = await Promise.all([
    db
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle(),
    db
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', WALLET_LOW_BALANCE_TEMPLATE)
      .limit(1)
      .maybeSingle(),
  ])
  if (!config) return
  const templateRow =
    rawTemplate && isMessageTemplate(rawTemplate) ? (rawTemplate as MessageTemplate) : null
  const accessToken = decrypt(config.access_token)

  await Promise.all(
    phones.map(async (to) => {
      try {
        await sendTemplateMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to,
          templateName: WALLET_LOW_BALANCE_TEMPLATE,
          language: templateRow?.language ?? 'en',
          template: templateRow ?? undefined,
          params: [workspace, balance, threshold],
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(
          `[wallet] low-balance WhatsApp to ...${to.slice(-4)} failed:`,
          message.includes('132001')
            ? `template "${WALLET_LOW_BALANCE_TEMPLATE}" is missing or not approved`
            : message,
        )
      }
    }),
  )
}
