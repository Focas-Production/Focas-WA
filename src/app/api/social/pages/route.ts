// ============================================================
// POST /api/social/pages — list the Facebook Pages a user can connect
//
// Step 1 of "Continue with Facebook" in Settings → Instagram &
// Messenger. The browser runs FB.login() and posts the short-lived
// user token here; we swap it for a long-lived one, list the Pages it
// manages (with any linked Instagram professional account), and hand
// back an encrypted `session` the client passes to
// POST /api/social/channels to finish connecting. The raw tokens never
// reach the browser.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import {
  exchangeForLongLivedUserToken,
  listManagedPages,
} from '@/lib/social/graph-api';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(`admin:socialPages:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      user_access_token?: unknown;
    } | null;
    const shortLived =
      typeof body?.user_access_token === 'string' ? body.user_access_token.trim() : '';
    if (!shortLived) {
      return NextResponse.json({ error: 'user_access_token is required' }, { status: 400 });
    }

    let userToken: string;
    let pages;
    try {
      userToken = await exchangeForLongLivedUserToken({ shortLivedToken: shortLived });
      pages = await listManagedPages({ userAccessToken: userToken });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error';
      return NextResponse.json({ error: `Meta API error: ${message}` }, { status: 400 });
    }

    const { data: rows } = await ctx.supabase
      .from('social_channels')
      .select('channel, external_id')
      .eq('account_id', ctx.accountId);
    const connected = new Set(
      (rows ?? []).map((r: { channel: string; external_id: string }) => `${r.channel}:${r.external_id}`),
    );

    return NextResponse.json({
      session: encrypt(userToken),
      pages: pages.map((p) => ({
        id: p.id,
        name: p.name,
        picture_url: p.picture_url,
        instagram: p.instagram,
        connected: {
          messenger: connected.has(`messenger:${p.id}`),
          instagram: p.instagram ? connected.has(`instagram:${p.instagram.id}`) : false,
        },
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
