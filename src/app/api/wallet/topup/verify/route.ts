import { NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { creditWallet } from '@/lib/wallet/wallet'
import { resolveWalletCaller } from '@/lib/wallet/auth'

/**
 * POST /api/wallet/topup/verify — Razorpay Checkout success handler.
 *
 * Verifies the payment signature (HMAC-SHA256 of "order_id|payment_id"
 * with the key secret — Razorpay's documented scheme), then credits
 * the wallet exactly once:
 *   - the order row must belong to the caller's account,
 *   - the credit is keyed by payment id (unique per reference), so a
 *     double-submit or replay can't double-credit,
 *   - an already-'paid' order short-circuits to success (the user
 *     refreshed the success callback — money is already in).
 */
export async function POST(request: Request) {
  const { caller, error } = await resolveWalletCaller()
  if (error) return error

  const keySecret = process.env.RAZORPAY_KEY_SECRET
  if (!keySecret) {
    return NextResponse.json({ error: 'Razorpay is not configured.' }, { status: 400 })
  }

  const body = await request.json().catch(() => null)
  const orderId = String(body?.razorpay_order_id ?? '')
  const paymentId = String(body?.razorpay_payment_id ?? '')
  const signature = String(body?.razorpay_signature ?? '')
  if (!orderId || !paymentId || !signature) {
    return NextResponse.json({ error: 'Missing payment details.' }, { status: 400 })
  }

  const expected = createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Payment verification failed.' }, { status: 400 })
  }

  const db = supabaseAdmin()
  const { data: order } = await db
    .from('wallet_topup_orders')
    .select('*')
    .eq('provider_order_id', orderId)
    .eq('account_id', caller.accountId)
    .maybeSingle()
  if (!order) {
    return NextResponse.json({ error: 'Payment order not found.' }, { status: 404 })
  }
  if (order.status === 'paid') {
    return NextResponse.json({ success: true, already_credited: true })
  }

  const newBalance = await creditWallet({
    accountId: caller.accountId,
    amountPaise: Number(order.amount_paise),
    category: 'topup_razorpay',
    description: `Wallet top-up via Razorpay (${paymentId})`,
    reference: paymentId,
    createdBy: caller.userId,
  })

  await db
    .from('wallet_topup_orders')
    .update({
      status: 'paid',
      provider_payment_id: paymentId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', order.id)

  return NextResponse.json({ success: true, balance_paise: newBalance })
}
