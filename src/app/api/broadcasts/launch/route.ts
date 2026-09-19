import { NextResponse, after } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { launchBroadcast, LaunchError, type AudienceConfig } from '@/lib/whatsapp/broadcast-launch'
import { runBroadcast, getAccountSendingProfile } from '@/lib/whatsapp/broadcast-engine'
import type { VariableMapping } from '@/lib/whatsapp/variable-resolution'

/**
 * POST /api/broadcasts/launch — create a campaign from the wizard and
 * start it. One request for any audience size: the audience is
 * resolved, recipients written and the wallet charged here, then the
 * server-side engine sends it (after the response for "Send now", on
 * the cron tick for a scheduled time). The browser can close.
 *
 * Body: { name, template_name, template_language, audience,
 *         variables, header_media_url?, scheduled_at?, draft_id? }
 *
 * 201: { broadcast_id, total_recipients, scheduled_at, scheduled,
 *        messaging_limit? }  — messaging_limit is set when the audience
 *        exceeds the number's 24 h unique-user limit (advisory).
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')

    // One call per campaign, so this is a true launch budget.
    const limit = checkRateLimit(`broadcast:${ctx.userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || !body.audience) {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
    }

    const result = await launchBroadcast(ctx.supabase, ctx, {
      name: String(body.name ?? ''),
      templateName: String(body.template_name ?? ''),
      templateLanguage: String(body.template_language || 'en_US'),
      audience: body.audience as AudienceConfig,
      variables: (body.variables ?? {}) as Record<string, VariableMapping>,
      headerMediaUrl: typeof body.header_media_url === 'string' ? body.header_media_url : null,
      scheduledAt: typeof body.scheduled_at === 'string' ? body.scheduled_at : null,
      draftId: typeof body.draft_id === 'string' ? body.draft_id : null,
    })

    if (!result.isScheduled) {
      after(() => runBroadcast(result.broadcastId))
    }

    // Advisory: Meta fails sends past the portfolio's 24 h limit on
    // unique users (other traffic counts too, so this can't be exact).
    const profile = await getAccountSendingProfile(ctx.accountId)
    const overLimit =
      profile?.messagingLimit != null &&
      Number.isFinite(profile.messagingLimit) &&
      result.totalRecipients > profile.messagingLimit

    return NextResponse.json(
      {
        broadcast_id: result.broadcastId,
        total_recipients: result.totalRecipients,
        scheduled_at: result.scheduledAt,
        scheduled: result.isScheduled,
        ...(overLimit ? { messaging_limit: profile!.messagingLimit } : {}),
      },
      { status: 201 },
    )
  } catch (err) {
    if (err instanceof LaunchError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
