import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveWalletCaller, requireRole } from '@/lib/wallet/auth'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

// Sane bounds for a single online top-up: ₹100 – ₹5,00,000.
const MIN_TOPUP_PAISE = 100 * 100
const MAX_TOPUP_PAISE = 500000 * 100

/**
 * POST /api/wallet/topup — create a Razorpay order for a wallet
 * top-up. The client opens Razorpay Checkout with the returned order
 * id; /api/wallet/topup/verify then confirms the signature and
 * credits the wallet. The `wallet_topup_orders` row created here is
 * the idempotency anchor: verify only credits an order it can flip
 * from 'created' to 'paid'.
 */
export async function POST(request: Request) {
  const { caller, error } = await resolveWalletCaller()
  if (error) return error
  const roleErr = requireRole(caller, ['owner', 'admin'])
  if (roleErr) return roleErr

  const limit = checkRateLimit(`wallet-topup:${caller.userId}`, RATE_LIMITS.broadcast)
  if (!limit.success) return rateLimitResponse(limit)

  const keyId = process.env.RAZORPAY_KEY_ID
  const keySecret = process.env.RAZORPAY_KEY_SECRET
  if (!keyId || !keySecret) {
    return NextResponse.json(
      {
        error:
          'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (and NEXT_PUBLIC_RAZORPAY_KEY_ID) in the environment, or use manual credit.',
      },
      { status: 400 },
    )
  }

  const body = await request.json().catch(() => null)
  const amountPaise = Math.round(Number(body?.amount_paise))
  if (!Number.isFinite(amountPaise) || amountPaise < MIN_TOPUP_PAISE || amountPaise > MAX_TOPUP_PAISE) {
    return NextResponse.json(
      { error: `Top-up amount must be between ₹${MIN_TOPUP_PAISE / 100} and ₹${MAX_TOPUP_PAISE / 100}.` },
      { status: 400 },
    )
  }

  // Create the Razorpay order (REST, basic auth — no SDK dependency).
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:
        'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: 'INR',
      notes: { purpose: 'wacrm_wallet_topup', account_id: caller.accountId },
    }),
  })
  const order = await res.json().catch(() => null)
  if (!res.ok || !order?.id) {
    console.error('[wallet] razorpay order create failed:', order)
    return NextResponse.json(
      { error: 'Failed to create payment order. Try again.' },
      { status: 502 },
    )
  }

  const { error: insertErr } = await supabaseAdmin()
    .from('wallet_topup_orders')
    .insert({
      account_id: caller.accountId,
      provider: 'razorpay',
      provider_order_id: order.id,
      amount_paise: amountPaise,
      currency: 'INR',
      status: 'created',
      created_by: caller.userId,
    })
  if (insertErr) {
    console.error('[wallet] topup order insert failed:', insertErr.message)
    return NextResponse.json(
      { error: 'Failed to record payment order. Try again.' },
      { status: 500 },
    )
  }

  return NextResponse.json({
    order_id: order.id,
    amount_paise: amountPaise,
    currency: 'INR',
    key_id: keyId,
  })
}
