import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveWalletCaller } from '@/lib/wallet/auth'
import { META_RATES_PAISE, META_RATE_CARD_EFFECTIVE } from '@/lib/wallet/meta-rates'
import { getApproverConfig } from '@/lib/wallet/credit-otp'

/**
 * GET /api/wallet — balance + Meta rate card for the caller's account.
 *
 * Exists (rather than a pure client-side RLS read) because the first
 * touch must CREATE the wallet row, and only the service-role
 * `wallet_ensure` RPC may write wallet state. Per-message rates are
 * Meta's actual prices, fixed in code — not read from (or writable
 * to) the database. Transaction history is read client-side via RLS.
 */
export async function GET() {
  const { caller, error } = await resolveWalletCaller()
  if (error) return error

  const db = supabaseAdmin()
  const { data: wallet, error: ensureErr } = await db.rpc('wallet_ensure', {
    p_account_id: caller.accountId,
  })
  if (ensureErr || !wallet) {
    console.error('[wallet] ensure failed:', ensureErr?.message)
    return NextResponse.json({ error: 'Failed to load wallet' }, { status: 500 })
  }

  // Approver gate is env-configured (WALLET_APPROVER_PHONE) — see
  // credit-otp.ts. Identity details (name, phone tail) are for the
  // owner-only settings UI; other members only learn whether the
  // gate is on, never who approves.
  const approver = getApproverConfig()
  const isOwner = caller.role === 'owner'

  return NextResponse.json({
    balance_paise: Number(wallet.balance_paise ?? 0),
    currency: wallet.currency ?? 'INR',
    low_balance_threshold_paise: Number(wallet.low_balance_threshold_paise ?? 0),
    pricing: META_RATES_PAISE,
    rate_card_effective: META_RATE_CARD_EFFECTIVE,
    razorpay_configured: Boolean(
      process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET,
    ),
    manual_credit_otp: approver.configured,
    manual_credit_label: isOwner ? approver.name : null,
    manual_credit_phone_hint: isOwner ? (approver.phone?.slice(-4) ?? null) : null,
    manual_credit_phone_valid: !approver.configured || Boolean(approver.phone),
  })
}
