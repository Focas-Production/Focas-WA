// ============================================================
// Wallet core — server-side only.
//
// Every template message send debits the account's prepaid wallet
// (WATI-style). This module wraps the SECURITY DEFINER Postgres
// functions from migration 037 behind typed helpers; all writes go
// through the service-role client because the RPCs are executable
// by service_role alone (a browser session could otherwise credit
// itself).
//
// Charge granularity (keeps the ledger AND the database small):
//   - SINGLE sends (inbox, automation): one debit per message,
//     provisional reference re-stamped to the wamid on success so
//     the webhook can refund a later delivery failure.
//   - BROADCASTS: ONE debit for the whole campaign
//     (reference `broadcast:<id>`, amount = rate × recipients) taken
//     up front, then ONE aggregate refund at the end of the fan-out
//     for recipients that never reached Meta (wamid IS NULL). A
//     recipient Meta accepted but later reports `failed` is refunded
//     individually by the webhook (reference = wamid — disjoint from
//     the settle set, so the two can never double-refund).
//
// Session (free-form) messages are never charged.
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getMetaRatePaise } from './meta-rates'

export type WalletChargeCategory = 'marketing' | 'utility' | 'authentication'

export class WalletError extends Error {
  readonly code: 'insufficient_balance' | 'wallet_error'
  constructor(code: 'insufficient_balance' | 'wallet_error', message: string) {
    super(message)
    this.name = 'WalletError'
    this.code = code
  }
}

export const INSUFFICIENT_BALANCE_MESSAGE =
  'Insufficient wallet balance. Top up your wallet in Settings → Wallet to continue sending.'

function isInsufficientFunds(err: { message?: string } | null): boolean {
  return !!err?.message?.includes('WALLET_INSUFFICIENT_FUNDS')
}

/**
 * Resolve what one send of this template costs — Meta's actual rate
 * for the template's category (fixed in code, see meta-rates.ts).
 * Category comes from the locally-synced template row; a missing/
 * unknown row falls back to the marketing rate (the most expensive)
 * so an unsynced template can never undercharge.
 */
export async function getTemplateCharge(
  accountId: string,
  templateName: string,
  templateLanguage?: string | null,
): Promise<{ category: WalletChargeCategory; pricePaise: number }> {
  const db = supabaseAdmin()

  let q = db
    .from('message_templates')
    .select('category')
    .eq('account_id', accountId)
    .eq('name', templateName)
  if (templateLanguage) q = q.eq('language', templateLanguage)
  const { data: row } = await q.limit(1).maybeSingle()

  const raw = (row?.category ?? 'Marketing').toString().toLowerCase()
  const category: WalletChargeCategory =
    raw === 'utility' || raw === 'authentication'
      ? (raw as WalletChargeCategory)
      : 'marketing'

  return { category, pricePaise: getMetaRatePaise(category) }
}

/** Current balance in paise (creates the wallet on first touch). */
export async function getWalletBalancePaise(accountId: string): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc('wallet_ensure', {
    p_account_id: accountId,
  })
  if (error) throw new WalletError('wallet_error', error.message)
  return Number(data?.balance_paise ?? 0)
}

/** numeric(14,2) column — keep JS float dust out of the ledger. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Atomically debit template send(s). `quantity` > 1 charges a whole
 * campaign as a single ledger row. Throws
 * WalletError('insufficient_balance') when the wallet can't cover it
 * — callers surface that instead of sending.
 */
export async function chargeTemplateSend(params: {
  accountId: string
  /** Idempotency key — `prep:<uuid>` or `broadcast:<id>`. */
  reference: string
  category: WalletChargeCategory
  pricePaise: number
  description: string
  quantity?: number
  createdBy?: string | null
}): Promise<void> {
  const { error } = await supabaseAdmin().rpc('wallet_charge', {
    p_account_id: params.accountId,
    p_amount_paise: round2(params.pricePaise * (params.quantity ?? 1)),
    p_category: params.category,
    p_description: params.description,
    p_reference_id: params.reference,
    p_created_by: params.createdBy ?? null,
  })
  if (error) {
    if (isInsufficientFunds(error)) {
      throw new WalletError('insufficient_balance', INSUFFICIENT_BALANCE_MESSAGE)
    }
    throw new WalletError('wallet_error', `Wallet charge failed: ${error.message}`)
  }
}

/**
 * Refund a known amount (aggregate campaign settle, or one webhook-
 * reported delivery failure). Idempotent per reference; best-effort —
 * failures are logged, never thrown.
 */
export async function refundWalletAmount(params: {
  accountId: string
  amountPaise: number
  reference: string
  description: string
}): Promise<void> {
  if (params.amountPaise <= 0) return
  try {
    const { error } = await supabaseAdmin().rpc('wallet_credit', {
      p_account_id: params.accountId,
      p_amount_paise: round2(params.amountPaise),
      p_category: 'refund',
      p_description: params.description,
      p_reference_id: params.reference,
      p_created_by: null,
      p_type: 'refund',
    })
    if (error && !error.message.includes('duplicate')) {
      console.error('[wallet] refund failed:', error.message)
    }
  } catch (err) {
    console.error('[wallet] refund failed:', err)
  }
}

/**
 * After Meta accepts the message, move the debit onto the wamid so
 * the webhook's failed-status refund can locate it. Best-effort — a
 * failure here loses only refund-by-webhook granularity, never money.
 */
export async function stampChargeReference(
  provisionalReference: string,
  wamid: string,
): Promise<void> {
  const { error } = await supabaseAdmin().rpc('wallet_stamp_debit_reference', {
    p_old_reference: provisionalReference,
    p_new_reference: wamid,
  })
  if (error) {
    console.error('[wallet] failed to stamp debit reference:', error.message)
  }
}

/**
 * Refund a charged send (Meta rejected it, or a delivery webhook
 * reported `failed`). Looks up the debit by reference and credits
 * the same amount back. Idempotent per reference — a second refund
 * for the same message no-ops. Best-effort: refund failures are
 * logged, never thrown, so they can't break a send loop or webhook.
 */
export async function refundTemplateCharge(
  reference: string,
  reason: string,
): Promise<void> {
  try {
    const db = supabaseAdmin()
    const { data: debit } = await db
      .from('wallet_transactions')
      .select('account_id, amount_paise, description')
      .eq('reference_id', reference)
      .eq('type', 'debit')
      .maybeSingle()
    if (!debit) return // never charged (e.g. free-form message)

    const { error } = await db.rpc('wallet_credit', {
      p_account_id: debit.account_id,
      p_amount_paise: debit.amount_paise,
      p_category: 'refund',
      p_description: `Refund (${reason}): ${debit.description ?? reference}`,
      p_reference_id: reference,
      p_created_by: null,
      p_type: 'refund',
    })
    if (error && !error.message.includes('duplicate')) {
      console.error('[wallet] refund failed:', error.message)
    }
  } catch (err) {
    console.error('[wallet] refund failed:', err)
  }
}

/** Does a campaign-level debit exist for this broadcast? Used by the
 *  batch send route to confirm the campaign was prepaid. */
export async function hasBroadcastDebit(
  accountId: string,
  broadcastId: string,
): Promise<boolean> {
  const { data } = await supabaseAdmin()
    .from('wallet_transactions')
    .select('id')
    .eq('account_id', accountId)
    .eq('type', 'debit')
    .eq('reference_id', `broadcast:${broadcastId}`)
    .limit(1)
    .maybeSingle()
  return Boolean(data)
}

/**
 * Aggregate settle after a campaign's fan-out: refund, in ONE ledger
 * row, every recipient that never reached Meta (status `failed` with
 * no wamid). Recipients Meta accepted but later failed are refunded
 * individually by the webhook (keyed by wamid), so the two sets are
 * disjoint. Idempotent per broadcast — reference `broadcast:<id>`
 * allows a single refund row. Best-effort; never throws.
 */
export async function settleBroadcastCharge(
  accountId: string,
  broadcastId: string,
): Promise<void> {
  try {
    const db = supabaseAdmin()
    const { data: broadcast } = await db
      .from('broadcasts')
      .select('name, template_name, template_language')
      .eq('id', broadcastId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!broadcast) return

    const { count } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', 'failed')
      .is('whatsapp_message_id', null)
    const unsent = count ?? 0
    if (unsent === 0) return

    const { pricePaise } = await getTemplateCharge(
      accountId,
      broadcast.template_name,
      broadcast.template_language,
    )
    await refundWalletAmount({
      accountId,
      amountPaise: pricePaise * unsent,
      reference: `broadcast:${broadcastId}`,
      description: `Refund: ${unsent} unsent in broadcast "${broadcast.name}"`,
    })
  } catch (err) {
    console.error('[wallet] broadcast settle failed:', err)
  }
}

/**
 * Refund one broadcast message the webhook reported as `failed`
 * after Meta had accepted it. Its cost is part of the campaign-level
 * debit, so the refund is priced from the broadcast's template and
 * keyed by wamid (idempotent; disjoint from the aggregate settle,
 * which only covers recipients that never got a wamid).
 */
export async function refundBroadcastMessage(
  broadcastId: string,
  wamid: string,
): Promise<void> {
  try {
    const db = supabaseAdmin()
    const { data: broadcast } = await db
      .from('broadcasts')
      .select('account_id, name, template_name, template_language')
      .eq('id', broadcastId)
      .maybeSingle()
    if (!broadcast) return

    const { pricePaise } = await getTemplateCharge(
      broadcast.account_id,
      broadcast.template_name,
      broadcast.template_language,
    )
    await refundWalletAmount({
      accountId: broadcast.account_id,
      amountPaise: pricePaise,
      reference: wamid,
      description: `Refund (delivery failed): broadcast "${broadcast.name}"`,
    })
  } catch (err) {
    console.error('[wallet] broadcast message refund failed:', err)
  }
}

/**
 * Credit the wallet (top-up or manual load). Idempotent per
 * reference for gateway credits (payment id).
 */
export async function creditWallet(params: {
  accountId: string
  amountPaise: number
  category: 'topup_razorpay' | 'topup_manual' | 'adjustment'
  description: string
  reference?: string | null
  createdBy?: string | null
}): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc('wallet_credit', {
    p_account_id: params.accountId,
    p_amount_paise: params.amountPaise,
    p_category: params.category,
    p_description: params.description,
    p_reference_id: params.reference ?? null,
    p_created_by: params.createdBy ?? null,
    p_type: 'credit',
  })
  if (error) throw new WalletError('wallet_error', error.message)
  return Number(data ?? 0)
}
