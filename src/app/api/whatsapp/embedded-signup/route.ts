import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { verifyPhoneNumber, subscribeWabaToApp } from '@/lib/whatsapp/meta-api'
import { encrypt } from '@/lib/whatsapp/encryption'

/**
 * POST /api/whatsapp/embedded-signup
 *
 * Completes Meta Embedded Signup — including **coexistence** onboarding,
 * where the number keeps working in the WhatsApp Business app on the
 * phone while also joining the Cloud API.
 *
 * The client runs FB.login() with the Embedded Signup configuration
 * (see `whatsapp-config.tsx`), which yields:
 *   - an OAuth `code` from the login callback, and
 *   - `phone_number_id` + `waba_id` from the WA_EMBEDDED_SIGNUP
 *     postMessage session-info event.
 *
 * This route then:
 *   1. exchanges the code for a business-integration system-user token
 *      (server-side — needs META_APP_SECRET, never expose it),
 *   2. verifies the phone number with that token,
 *   3. subscribes the WABA to this app so inbound webhooks flow,
 *   4. encrypts + stores everything in `whatsapp_config`.
 *
 * No `/register` call is made: coexistence numbers are registered by
 * the QR-scan onboarding itself, and re-registering with a PIN would
 * risk severing the phone-app link. Standard ES numbers that DO need
 * registration surface through the existing "Not registered" banner,
 * where a PIN can be added via the normal form.
 *
 * Env: META_APP_ID + META_APP_SECRET (both already used elsewhere for
 * webhook signatures / template media).
 */

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const appId = process.env.META_APP_ID
    const appSecret = process.env.META_APP_SECRET
    if (!appId || !appSecret) {
      return NextResponse.json(
        {
          error:
            'META_APP_ID and META_APP_SECRET must be set to use Embedded Signup.',
        },
        { status: 500 },
      )
    }

    const body = await request.json().catch(() => null)
    const code = typeof body?.code === 'string' ? body.code : ''
    const phoneNumberId =
      typeof body?.phone_number_id === 'string' ? body.phone_number_id : ''
    const wabaId = typeof body?.waba_id === 'string' ? body.waba_id : ''

    if (!code || !phoneNumberId || !wabaId) {
      return NextResponse.json(
        { error: 'code, phone_number_id and waba_id are required' },
        { status: 400 },
      )
    }

    // 1. Exchange the ES code for a business-integration system-user
    // token. No redirect_uri — Embedded Signup codes are exchanged
    // directly (the FB.login popup has no redirect of ours).
    const tokenRes = await fetch(
      `${GRAPH_API_BASE}/oauth/access_token?` +
        new URLSearchParams({
          client_id: appId,
          client_secret: appSecret,
          code,
        }).toString(),
    )
    const tokenJson = await tokenRes.json().catch(() => null)
    if (!tokenRes.ok || !tokenJson?.access_token) {
      const message =
        tokenJson?.error?.message || `Token exchange failed (${tokenRes.status})`
      console.error('[embedded-signup] code exchange failed:', message)
      return NextResponse.json(
        { error: `Meta token exchange failed: ${message}` },
        { status: 400 },
      )
    }
    const accessToken = tokenJson.access_token as string

    // 2. Verify the phone number actually resolves with this token —
    // same pre-save validation as the manual config form.
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId,
        accessToken,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[embedded-signup] phone verification failed:', message)
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 400 },
      )
    }

    // Reject if another account on this instance already claimed the
    // number (same single-tenant-per-number rule as the manual form).
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phoneNumberId)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('[embedded-signup] ownership check failed:', claimedError)
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 },
      )
    }
    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance.',
        },
        { status: 409 },
      )
    }

    // 3. Subscribe the WABA to this app so Meta routes its webhooks
    // here. Idempotent; failures are surfaced (unlike the manual form)
    // because for ES onboarding there is no other path to inbound.
    try {
      await subscribeWabaToApp({ wabaId, accessToken })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[embedded-signup] subscribed_apps failed:', message)
      return NextResponse.json(
        { error: `WABA webhook subscription failed: ${message}` },
        { status: 400 },
      )
    }

    // 4. Encrypt + store. Coexistence numbers are registered by the QR
    // onboarding itself, so mark registered_at now (see header note).
    let encryptedAccessToken: string
    try {
      encryptedAccessToken = encrypt(accessToken)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('[embedded-signup] encryption failed:', message)
      return NextResponse.json(
        { error: 'Failed to encrypt token. Check ENCRYPTION_KEY.' },
        { status: 500 },
      )
    }

    const now = new Date().toISOString()
    const baseRow = {
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      access_token: encryptedAccessToken,
      status: 'connected',
      connected_at: now,
      registered_at: now,
      subscribed_apps_at: now,
      last_registration_error: null,
      updated_at: now,
    }

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        .eq('account_id', accountId)
      if (updateError) {
        console.error('[embedded-signup] config update failed:', updateError)
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 },
        )
      }
    } else {
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({ account_id: accountId, user_id: user.id, ...baseRow })
      if (insertError) {
        console.error('[embedded-signup] config insert failed:', insertError)
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 },
        )
      }
    }

    return NextResponse.json({ success: true, phone_info: phoneInfo })
  } catch (error) {
    console.error('[embedded-signup] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
