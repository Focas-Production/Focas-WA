import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveWalletCaller } from '@/lib/wallet/auth'
import { META_RATES_PAISE, META_RATE_CARD_EFFECTIVE } from '@/lib/wallet/meta-rates'

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

  return NextResponse.json({
    balance_paise: Number(wallet.balance_paise ?? 0),
    currency: wallet.currency ?? 'INR',
    low_balance_threshold_paise: Number(wallet.low_balance_threshold_paise ?? 0),
    pricing: META_RATES_PAISE,
    rate_card_effective: META_RATE_CARD_EFFECTIVE,
    razorpay_configured: Boolean(
      process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET,
    ),
  })
}
