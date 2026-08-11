import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { creditWallet } from '@/lib/wallet/wallet'
import { resolveWalletCaller, requireRole } from '@/lib/wallet/auth'
import {
  CREDIT_OTP_MAX_ATTEMPTS,
  MANUAL_CREDIT_MIN_PAISE,
  MANUAL_CREDIT_MAX_PAISE,
  getApproverConfig,
  parseAmountPaise,
  hashApprovalCode,
} from '@/lib/wallet/credit-otp'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * POST /api/wallet/manual-credit — owner-only wallet load for money
 * received outside the gateway (bank transfer, cash, adjustment).
 *
 * Two modes, decided by the WALLET_APPROVER_PHONE environment
 * variable (see credit-otp.ts) — env, not a DB row, so the gate can
 * never fail open on a database hiccup and can only be re-pointed
 * by someone with server access:
 *
 *   UNGATED (env unset): body { amount_paise, note? } — credits
 *   directly.
 *
 *   GATED: body { request_id, approval_code } — redeems a request
 *   created by /api/wallet/manual-credit/request. The amount and
 *   note come from the STORED request row (never the client), so
 *   the code the approver saw can only release the amount they saw.
 *   Codes are hashed, expire after 5 minutes, die after 5 wrong
 *   attempts (atomic guarded increment — parallel guesses fail
 *   closed), and are single-use via a guarded used_at claim that is
 *   ROLLED BACK if the wallet credit itself fails, so a transient
 *   error never burns a valid approval.
 */
export async function POST(request: Request) {
  const { caller, error } = await resolveWalletCaller()
  if (error) return error
  const roleErr = requireRole(caller, ['owner'])
  if (roleErr) return roleErr

  const limit = checkRateLimit(`wallet-credit:${caller.userId}`, RATE_LIMITS.broadcast)
  if (!limit.success) return rateLimitResponse(limit)

  const body = await request.json().catch(() => null)
  const db = supabaseAdmin()
  const approver = getApproverConfig()

  // ── Ungated legacy path ──────────────────────────────────────
  if (!approver.configured) {
    const parsed = parseAmountPaise(body?.amount_paise)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 200) : ''
    const newBalance = await creditWallet({
      accountId: caller.accountId,
      amountPaise: parsed.amountPaise,
      category: 'topup_manual',
      description: note ? `Manual credit: ${note}` : 'Manual credit',
      createdBy: caller.userId,
    })
    return NextResponse.json({ success: true, balance_paise: newBalance })
  }

  // ── Gated path: redeem an approval request ───────────────────
  const requestId = String(body?.request_id ?? '')
  // The approver sees "Request ID: WCR-123456" — accept a pasted
  // "WCR-123456" as well as the bare digits.
  const code = String(body?.approval_code ?? '').replace(/\D+/g, '')
  if (!requestId || !/^\d{6}$/.test(code)) {
    return NextResponse.json(
      { error: 'Provide request_id and the 6-digit approval code.' },
      { status: 400 },
    )
  }

  const { data: otp, error: otpErr } = await db
    .from('wallet_credit_otps')
    .select('id, amount_paise, note, code_hash, expires_at, used_at, attempts')
    .eq('id', requestId)
    .eq('account_id', caller.accountId)
    .maybeSingle()
  if (otpErr) {
    return NextResponse.json(
      { error: 'Could not load the approval request. Try again.' },
      { status: 503 },
    )
  }
  if (!otp) {
    return NextResponse.json({ error: 'Approval request not found.' }, { status: 404 })
  }
  if (otp.used_at) {
    return NextResponse.json({ error: 'This approval was already used.' }, { status: 403 })
  }
  if (new Date(otp.expires_at).getTime() < Date.now()) {
    return NextResponse.json(
      { error: 'The approval code expired. Request a new one.' },
      { status: 403 },
    )
  }
  if (otp.attempts >= CREDIT_OTP_MAX_ATTEMPTS) {
    return NextResponse.json(
      { error: 'Too many wrong attempts. Request a new approval code.' },
      { status: 403 },
    )
  }

  // Belt-and-braces: the row was bounds-checked at creation, but a
  // row written under older bounds (or by anything else) must still
  // not credit outside today's limits.
  const amountPaise = Number(otp.amount_paise)
  if (
    !Number.isFinite(amountPaise) ||
    amountPaise < MANUAL_CREDIT_MIN_PAISE ||
    amountPaise > MANUAL_CREDIT_MAX_PAISE
  ) {
    return NextResponse.json(
      { error: 'Approval request amount is out of bounds. Create a new request.' },
      { status: 400 },
    )
  }

  const expected = Buffer.from(otp.code_hash)
  const supplied = Buffer.from(hashApprovalCode(requestId, code))
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    // Atomic, guarded increment: only the request that read this
    // attempts value may bump it. Parallel wrong guesses lose the
    // guard and are rejected outright, so the cap holds under
    // concurrency instead of losing updates.
    const { data: bumped } = await db
      .from('wallet_credit_otps')
      .update({ attempts: otp.attempts + 1 })
      .eq('id', requestId)
      .eq('attempts', otp.attempts)
      .select('attempts')
      .maybeSingle()
    if (!bumped) {
      return NextResponse.json(
        { error: 'Too many attempts at once. Request a new approval code.' },
        { status: 403 },
      )
    }
    const left = CREDIT_OTP_MAX_ATTEMPTS - bumped.attempts
    return NextResponse.json(
      {
        error:
          left > 0
            ? `Wrong approval code. ${left} attempt${left === 1 ? '' : 's'} left.`
            : 'Wrong approval code. Request a new approval code.',
      },
      { status: 403 },
    )
  }

  // Single-use claim — only one redeem wins.
  const { data: claimed } = await db
    .from('wallet_credit_otps')
    .update({ used_at: new Date().toISOString() })
    .eq('id', requestId)
    .is('used_at', null)
    .select('id')
    .maybeSingle()
  if (!claimed) {
    return NextResponse.json({ error: 'This approval was already used.' }, { status: 403 })
  }

  const note = (otp.note ?? '').trim()
  const baseDescription = `Manual credit (approved via WhatsApp OTP to ${approver.name})`
  let newBalance: number
  try {
    newBalance = await creditWallet({
      accountId: caller.accountId,
      amountPaise,
      category: 'topup_manual',
      description: note ? `${baseDescription}: ${note}` : baseDescription,
      reference: `credit-otp:${requestId}`,
      createdBy: caller.userId,
    })
  } catch (err) {
    // Release the claim so the approver's code stays redeemable — a
    // transient credit failure must not burn the approval. (Credits
    // carry no unique reference index, so the claim itself is the
    // only single-use guard; restoring it is safe.)
    await db
      .from('wallet_credit_otps')
      .update({ used_at: null })
      .eq('id', requestId)
    console.error('[wallet] manual credit failed after claim:', err)
    return NextResponse.json(
      { error: 'Wallet credit failed. The approval code is still valid — try again.' },
      { status: 500 },
    )
  }

  return NextResponse.json({ success: true, balance_paise: newBalance })
}
