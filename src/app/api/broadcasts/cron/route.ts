import { timingSafeEqual } from 'node:crypto'
import { NextResponse, after } from 'next/server'
import { scanBroadcastQueue, runQueue } from '@/lib/whatsapp/broadcast-engine'

/**
 * Campaign queue tick. Hit once a minute (external pinger / VPS
 * crontab) — same auth as the automations cron: shared secret via the
 * `x-cron-secret` header, matched against AUTOMATION_CRON_SECRET.
 *
 *   * * * * * curl -s -H "x-cron-secret: $SECRET" \
 *       https://wa.focasedu.online/api/broadcasts/cron
 *
 * Starts due scheduled campaigns, resumes any whose process died
 * mid-send (lapsed lease), and settles stopped campaigns whose
 * process died before refunding. "Send now" campaigns start immediately
 * without waiting for this tick; the tick is their crash safety net,
 * so keep it running even if you never schedule campaigns.
 *
 * Sending runs after the response (after()), so the pinger never
 * waits on a campaign; the engine's atomic claims make overlapping
 * ticks safe.
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

  try {
    const queue = await scanBroadcastQueue()
    after(() => runQueue(queue))
    return NextResponse.json({ started: queue.run.length, closed: queue.close.length })
  } catch (err) {
    console.error('[broadcasts/cron] queue scan failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'queue scan failed' },
      { status: 500 },
    )
  }
}
