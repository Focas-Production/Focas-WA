import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { settleBroadcastCharge } from '@/lib/wallet/wallet'

/**
 * POST /api/broadcasts/[id]/cancel — stop a scheduled or sending
 * campaign.
 *
 * Flips the row to 'cancelled' and fails every recipient the engine
 * hasn't claimed yet. The engine claims each recipient conditionally
 * (still pending, unclaimed) right before its Meta call, so once this
 * returns no further message goes out; the few already in flight
 * finish and are recorded normally.
 *
 * Wallet: if an engine is running it settles when it winds down
 * (within one heartbeat, ~5 s), after its in-flight sends land — the
 * refund must count those. Otherwise (scheduled, or its process died)
 * this settles now. Settle is idempotent per campaign.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params

    // RLS-scoped flip: proves the caller's account owns the campaign.
    const { data: cancelled, error } = await ctx.supabase
      .from('broadcasts')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .in('status', ['scheduled', 'sending'])
      .select('id, locked_until')
      .maybeSingle()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!cancelled) {
      return NextResponse.json(
        { error: 'This broadcast is not scheduled or sending.' },
        { status: 409 },
      )
    }

    const db = supabaseAdmin()
    await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: 'Cancelled' })
      .eq('broadcast_id', id)
      .eq('status', 'pending')
      .is('attempted_at', null)

    const engineRunning =
      cancelled.locked_until != null &&
      new Date(cancelled.locked_until as string).getTime() > Date.now()
    if (!engineRunning) {
      await settleBroadcastCharge(ctx.accountId, id)
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
