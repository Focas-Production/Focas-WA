import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { settleBroadcastCharge } from '@/lib/wallet/wallet'

/**
 * POST /api/broadcasts/[id]/cancel — stop a scheduled campaign, or one
 * the campaign engine is sending.
 *
 * Flips the row to 'cancelled' and fails every recipient the engine
 * hasn't claimed yet. The engine claims each recipient conditionally
 * (still pending, unclaimed) right before its Meta call, so once this
 * returns no further message goes out; the few already in flight
 * finish and are recorded normally.
 *
 * Only engine campaigns (they hold a lease, `locked_until`) can be
 * stopped mid-send. Public-API broadcasts and ones started before the
 * engine run in a loop that never checks for a cancel, so "stopping"
 * them would refund messages that still go out — refused with 409.
 *
 * Wallet: a scheduled campaign never sent anything, so it is settled
 * here (and retried by the cron if that fails). A sending one is
 * settled by whoever closes it after in-flight
 * sends land — the engine as it winds down (~5 s), or, if its process
 * died, the cron tick (which first fails the mid-send recipients so
 * the refund counts them). Settling here would miss those, and the
 * refund can only be issued once.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params

    // RLS-scoped read: proves the caller's account owns the campaign.
    const { data: row, error: readErr } = await ctx.supabase
      .from('broadcasts')
      .select('id, status, locked_until')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (readErr) {
      return NextResponse.json({ error: readErr.message }, { status: 500 })
    }
    if (!row) {
      return NextResponse.json({ error: 'Broadcast not found.' }, { status: 404 })
    }

    const scheduled = row.status === 'scheduled'
    const engineSending = row.status === 'sending' && row.locked_until != null
    if (!scheduled && !engineSending) {
      return NextResponse.json(
        {
          error:
            row.status === 'sending'
              ? 'This broadcast was started outside the campaign engine and can’t be stopped mid-send.'
              : 'This broadcast is not scheduled or sending.',
        },
        { status: 409 },
      )
    }

    // Guarded flip: loses cleanly if the state moved since the read
    // (e.g. the engine just claimed a scheduled campaign). A scheduled
    // one also gets an already-lapsed lease: if the settle below
    // fails, the cron's close of lapsed 'cancelled' rows retries it
    // instead of the refund being lost.
    let flip = ctx.supabase
      .from('broadcasts')
      .update(
        scheduled
          ? { status: 'cancelled', locked_until: new Date().toISOString() }
          : { status: 'cancelled' },
      )
      .eq('id', id)
      .eq('status', row.status)
    if (engineSending) flip = flip.not('locked_until', 'is', null)
    const { data: cancelled, error: flipErr } = await flip.select('id').maybeSingle()
    if (flipErr) {
      return NextResponse.json({ error: flipErr.message }, { status: 500 })
    }
    if (!cancelled) {
      return NextResponse.json(
        { error: 'The broadcast changed state just now — refresh and try again.' },
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

    if (scheduled && (await settleBroadcastCharge(ctx.accountId, id))) {
      await db.from('broadcasts').update({ locked_until: null }).eq('id', id)
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
