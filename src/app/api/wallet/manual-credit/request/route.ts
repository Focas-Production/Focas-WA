import { NextResponse } from 'next/server'
import { randomInt, randomUUID } from 'node:crypto'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveWalletCaller, requireRole } from '@/lib/wallet/auth'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import { formatPaiseINR } from '@/lib/currency'
import {
  WALLET_APPROVAL_TEMPLATE,
  CREDIT_OTP_TTL_MS,
  getApproverConfig,
  parseAmountPaise,
  hashApprovalCode,
} from '@/lib/wallet/credit-otp'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import type { MessageTemplate } from '@/types'

/**
 * POST /api/wallet/manual-credit/request — start a manual credit.
 * Body: { amount_paise: number, note?: string }.
 *
 * Creates a single-use approval request (amount locked in) and
 * WhatsApps the approver (WALLET_APPROVER_PHONE) a 6-digit code
 * that names the amount and workspace. /api/wallet/manual-credit
 * then redeems request_id + code. The OTP send is deliberately NOT
 * debited from the wallet: charging it would deadlock the
 * empty-wallet case this flow exists to fix (a ₹0.115 drift from
 * the Meta invoice per approval).
 */
export async function POST(request: Request) {
  const { caller, error } = await resolveWalletCaller()
  if (error) return error
  const roleErr = requireRole(caller, ['owner'])
  if (roleErr) return roleErr

  const limit = checkRateLimit(`wallet-credit-otp:${caller.userId}`, RATE_LIMITS.broadcast)
  if (!limit.success) return rateLimitResponse(limit)

  const body = await request.json().catch(() => null)
  const parsed = parseAmountPaise(body?.amount_paise)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }
  const amountPaise = parsed.amountPaise
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 200) : ''

  const approver = getApproverConfig()
  if (!approver.configured) {
    return NextResponse.json(
      { error: 'No approver is configured (WALLET_APPROVER_PHONE).' },
      { status: 400 },
    )
  }
  if (!approver.phone) {
    return NextResponse.json(
      { error: 'WALLET_APPROVER_PHONE is set but not a valid WhatsApp number (use country code, e.g. 91XXXXXXXXXX).' },
      { status: 500 },
    )
  }

  const db = supabaseAdmin()
  // Independent account-scoped reads — one round-trip, not three.
  // The purge piggybacks here: expired unused requests are dead
  // weight (their codes can never be redeemed), so each new request
  // sweeps the account's stale rows instead of growing forever.
  const [{ data: config }, { data: account }, { data: rawTemplate }] =
    await Promise.all([
      db
        .from('whatsapp_config')
        .select('phone_number_id, access_token')
        .eq('account_id', caller.accountId)
        .maybeSingle(),
      db
        .from('accounts')
        .select('name')
        .eq('id', caller.accountId)
        .maybeSingle(),
      db
        .from('message_templates')
        .select('*')
        .eq('account_id', caller.accountId)
        .eq('name', WALLET_APPROVAL_TEMPLATE)
        .limit(1)
        .maybeSingle(),
      db
        .from('wallet_credit_otps')
        .delete()
        .eq('account_id', caller.accountId)
        .is('used_at', null)
        .lt('expires_at', new Date().toISOString()),
    ])

  if (!config) {
    return NextResponse.json(
      { error: 'WhatsApp is not connected for this workspace.' },
      { status: 400 },
    )
  }
  const workspaceName = account?.name ?? 'workspace'
  const templateRow =
    rawTemplate && isMessageTemplate(rawTemplate)
      ? (rawTemplate as MessageTemplate)
      : null

  const requestId = randomUUID()
  const code = String(randomInt(0, 1000000)).padStart(6, '0')
  const expiresAt = new Date(Date.now() + CREDIT_OTP_TTL_MS)

  const { error: insertErr } = await db.from('wallet_credit_otps').insert({
    id: requestId,
    account_id: caller.accountId,
    amount_paise: amountPaise,
    note: note || null,
    code_hash: hashApprovalCode(requestId, code),
    expires_at: expiresAt.toISOString(),
    created_by: caller.userId,
  })
  if (insertErr) {
    console.error('[wallet] credit otp insert failed:', insertErr.message)
    return NextResponse.json({ error: 'Failed to create approval request.' }, { status: 500 })
  }

  try {
    await sendTemplateMessage({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      to: approver.phone,
      templateName: WALLET_APPROVAL_TEMPLATE,
      language: templateRow?.language ?? 'en',
      template: templateRow ?? undefined,
      params: [formatPaiseINR(amountPaise), workspaceName, code],
    })
  } catch (err) {
    // Dead request — redeeming it is impossible without the code.
    await db.from('wallet_credit_otps').delete().eq('id', requestId)
    const message = err instanceof Error ? err.message : 'Unknown Meta API error'
    console.error('[wallet] approval OTP send failed:', message)
    const templateMissing = message.includes('132001')
    return NextResponse.json(
      {
        error: templateMissing
          ? `The "${WALLET_APPROVAL_TEMPLATE}" template is missing or not approved on this workspace's WhatsApp Business account. Create it (category Utility) and try again.`
          : `Could not send the approval code via WhatsApp: ${message}`,
      },
      { status: 502 },
    )
  }

  return NextResponse.json({ request_id: requestId })
}
