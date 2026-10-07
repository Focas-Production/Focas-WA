import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { requestCoexistenceSync } from '@/lib/whatsapp/coexistence-sync'

/**
 * POST /api/whatsapp/history-sync
 *
 * Coexistence only — asks Meta to replay the WhatsApp Business app's
 * contacts and chat history for the account's connected number. The
 * webhook's `smb_app_state_sync` / `history` handlers import what
 * arrives.
 *
 * Embedded Signup already requests this right after onboarding; this
 * route is the manual retry (or the first request for numbers
 * connected before that existed). Meta only accepts it within 24h of
 * onboarding and once per sync type — later calls return Meta's error,
 * surfaced verbatim in `errors`.
 *
 * 200: { requested: string[], errors: string[] }
 */
export async function POST() {
  try {
    const ctx = await requireRole('admin')

    const { data: config, error } = await ctx.supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error) {
      console.error('[history-sync] config lookup failed:', error)
      return NextResponse.json(
        { error: 'Failed to load WhatsApp configuration' },
        { status: 500 },
      )
    }
    if (!config?.phone_number_id || !config.access_token) {
      return NextResponse.json(
        { error: 'No WhatsApp number is connected yet.' },
        { status: 400 },
      )
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      return NextResponse.json(
        { error: 'Stored access token can\'t be decrypted. Reconnect the number.' },
        { status: 400 },
      )
    }

    const result = await requestCoexistenceSync({
      phoneNumberId: config.phone_number_id,
      accessToken,
    })
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
