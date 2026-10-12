import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { getPhoneAccountStatus } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * GET /api/whatsapp/account-status — live messaging-limit tier and
 * quality rating of the account's connected number, read from Meta on
 * every call (nothing is stored).
 *
 * 200: { connected: true, display_phone_number, verified_name,
 *        quality_rating, name_status, status, throughput_level,
 *        is_coexistence, messaging_limit_tier, messaging_limit,
 *        messaging_limit_unlimited, fetched_at }
 *    | { connected: false, reason: 'not_configured' | 'token_corrupted'
 *        | 'meta_api_error', error? }
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    const { data: config } = await ctx.supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!config?.phone_number_id || !config.access_token) {
      return NextResponse.json({ connected: false, reason: 'not_configured' })
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      return NextResponse.json({ connected: false, reason: 'token_corrupted' })
    }

    try {
      const s = await getPhoneAccountStatus({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
      const unlimited = s.messagingLimit === Infinity
      return NextResponse.json({
        connected: true,
        display_phone_number: s.displayPhoneNumber,
        verified_name: s.verifiedName,
        quality_rating: s.qualityRating,
        name_status: s.nameStatus,
        status: s.status,
        throughput_level: s.throughputLevel,
        is_coexistence: s.isCoexistence,
        messaging_limit_tier: s.messagingLimitTier,
        messaging_limit: unlimited ? null : s.messagingLimit,
        messaging_limit_unlimited: unlimited,
        fetched_at: new Date().toISOString(),
      })
    } catch (err) {
      return NextResponse.json({
        connected: false,
        reason: 'meta_api_error',
        error: err instanceof Error ? err.message : 'Meta API error',
      })
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
