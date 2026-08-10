import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { processDueScheduledBroadcasts } from '@/lib/whatsapp/scheduled-broadcasts'

/**
 * Deliver due scheduled broadcasts. Hit on a schedule (external
 * pinger / VPS crontab, e.g. every minute) — same auth as the
 * automations cron: shared secret via the `x-cron-secret` header,
 * matched against AUTOMATION_CRON_SECRET.
 *
 *   * * * * * curl -s -H "x-cron-secret: $SECRET" \
 *       https://wa.focasedu.online/api/broadcasts/cron
 *
 * The claim step inside processDueScheduledBroadcasts (atomic
 * scheduled → sending flip) makes overlapping invocations safe.
 * A big campaign can outlive one invocation's send loop, so we cap
 * at a few broadcasts per tick and let the next tick pick up the
 * rest.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const processed = await processDueScheduledBroadcasts(3)
  return NextResponse.json({ processed })
}

// The send loop paces itself (1 s per 10 recipients) — a 1 000-
// recipient campaign runs ~2 minutes. Opt out of the default route
// timeout so the fan-out isn't cut off mid-send.
export const maxDuration = 300
