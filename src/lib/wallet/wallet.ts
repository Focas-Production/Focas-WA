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
// Charge lifecycle (charge-on-send, refund-on-failure):
//   1. debit BEFORE the Meta call, referenced by a provisional key
//      (`prep:<uuid>` or the broadcast-recipient row id) — the
//      atomic debit is what guarantees the balance never goes
//      negative under concurrent sends,
//   2. on Meta success, re-reference the debit to the wamid so the
//      webhook can find it,
//   3. on Meta failure, refund against the provisional key,
//   4. on a later `failed` delivery status, the webhook refunds by
//      wamid (idempotent — replays can't double-refund).
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

/**
 * Atomically debit one template send. Throws
 * WalletError('insufficient_balance') when the wallet can't cover it
 * — callers surface that instead of sending.
 */
export async function chargeTemplateSend(params: {
  accountId: string
  /** Provisional idempotency key — recipient row id or `prep:<uuid>`. */
  reference: string
  category: WalletChargeCategory
  pricePaise: number
  description: string
  createdBy?: string | null
}): Promise<void> {
  const { error } = await supabaseAdmin().rpc('wallet_charge', {
    p_account_id: params.accountId,
    p_amount_paise: params.pricePaise,
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
