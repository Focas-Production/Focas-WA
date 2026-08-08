import { NextResponse } from 'next/server'
import { creditWallet } from '@/lib/wallet/wallet'
import { resolveWalletCaller, requireRole } from '@/lib/wallet/auth'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

// Manual loads mirror the online top-up bounds.
const MIN_PAISE = 100
const MAX_PAISE = 500000 * 100

/**
 * POST /api/wallet/manual-credit — owner-only wallet load for money
 * received outside the gateway (bank transfer, cash, adjustment).
 * Body: { amount_paise: number, note?: string }.
 */
export async function POST(request: Request) {
  const { caller, error } = await resolveWalletCaller()
  if (error) return error
  const roleErr = requireRole(caller, ['owner'])
  if (roleErr) return roleErr

  const limit = checkRateLimit(`wallet-credit:${caller.userId}`, RATE_LIMITS.broadcast)
  if (!limit.success) return rateLimitResponse(limit)

  const body = await request.json().catch(() => null)
  const amountPaise = Math.round(Number(body?.amount_paise))
  if (!Number.isFinite(amountPaise) || amountPaise < MIN_PAISE || amountPaise > MAX_PAISE) {
    return NextResponse.json(
      { error: `Amount must be between ₹${MIN_PAISE / 100} and ₹${MAX_PAISE / 100}.` },
      { status: 400 },
    )
  }
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 200) : ''

  const newBalance = await creditWallet({
    accountId: caller.accountId,
    amountPaise,
    category: 'topup_manual',
    description: note ? `Manual credit: ${note}` : 'Manual credit',
    createdBy: caller.userId,
  })

  return NextResponse.json({ success: true, balance_paise: newBalance })
}
