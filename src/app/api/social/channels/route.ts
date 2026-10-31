// ============================================================
// /api/social/channels — Settings → Instagram & Messenger
//
//   GET    — this account's connected channels (token-free).
//   POST   — connect a Page's Messenger and/or Instagram (admin+).
//            Either `session` (from POST /api/social/pages, the
//            "Continue with Facebook" path) or `page_access_token`
//            (manual path, e.g. a System User token) + `page_id`.
//   DELETE — disconnect one channel: `?id=<social_channels.id>` (admin+).
//
// Page tokens are stored AES-256-GCM-encrypted and never read back.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import {
  getPageFromPageToken,
  listManagedPages,
  subscribePageToApp,
  unsubscribePageFromApp,
  type ManagedPage,
  type SocialChannelKind,
} from '@/lib/social/graph-api';

const SAFE_COLUMNS =
  'id, channel, external_id, page_id, name, username, picture_url, status, last_error, connected_at, created_at, updated_at';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from('social_channels')
      .select(SAFE_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[GET /api/social/channels] fetch error:', error);
      return NextResponse.json({ error: 'Failed to load channels' }, { status: 500 });
    }
    return NextResponse.json({ channels: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(`admin:socialChannels:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      session?: unknown;
      page_access_token?: unknown;
      page_id?: unknown;
      channels?: unknown;
    } | null;

    const session = typeof body?.session === 'string' ? body.session : '';
    const manualToken =
      typeof body?.page_access_token === 'string' ? body.page_access_token.trim() : '';
    const pageId = typeof body?.page_id === 'string' ? body.page_id.trim() : '';
    const requested = Array.isArray(body?.channels)
      ? (body.channels.filter((c) => c === 'messenger' || c === 'instagram') as SocialChannelKind[])
      : [];

    if (!session && !manualToken) {
      return NextResponse.json(
        { error: 'Either session or page_access_token is required' },
        { status: 400 },
      );
    }
    if (session && !pageId) {
      return NextResponse.json({ error: 'page_id is required' }, { status: 400 });
    }

    // Resolve the Page + its token from Meta.
    let page: ManagedPage;
    try {
      if (session) {
        let userToken: string;
        try {
          userToken = decrypt(session);
        } catch {
          return NextResponse.json(
            { error: 'Facebook session expired — please continue with Facebook again.' },
            { status: 400 },
          );
        }
        const pages = await listManagedPages({ userAccessToken: userToken });
        const match = pages.find((p) => p.id === pageId);
        if (!match?.access_token) {
          return NextResponse.json(
            { error: 'That Page was not found on your Facebook account, or you are not an admin of it.' },
            { status: 404 },
          );
        }
        page = match;
      } else {
        page = await getPageFromPageToken({
          pageAccessToken: manualToken,
          pageId: pageId || undefined,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error';
      return NextResponse.json({ error: `Meta API error: ${message}` }, { status: 400 });
    }

    // Default: everything the Page offers.
    const channels: SocialChannelKind[] =
      requested.length > 0
        ? Array.from(new Set(requested))
        : page.instagram
          ? ['messenger', 'instagram']
          : ['messenger'];

    if (channels.includes('instagram') && !page.instagram) {
      return NextResponse.json(
        {
          error:
            'No Instagram professional account is linked to this Page. Link one in Meta Business Suite → Settings → Instagram, then try again.',
        },
        { status: 400 },
      );
    }

    const targets = channels.map((channel) => ({
      channel,
      external_id: channel === 'instagram' ? page.instagram!.id : page.id,
      name: channel === 'instagram' ? page.instagram!.name || page.name : page.name,
      username: channel === 'instagram' ? page.instagram!.username : null,
      picture_url: channel === 'instagram' ? page.instagram!.picture_url : page.picture_url,
    }));

    // One account per Page / IG account on this instance — checked with
    // the service-role client since RLS hides other accounts' rows.
    for (const t of targets) {
      const { data: claimed } = await supabaseAdmin()
        .from('social_channels')
        .select('account_id')
        .eq('channel', t.channel)
        .eq('external_id', t.external_id)
        .neq('account_id', ctx.accountId)
        .maybeSingle();
      if (claimed) {
        return NextResponse.json(
          { error: `This ${t.channel === 'instagram' ? 'Instagram account' : 'Page'} is already connected to another account on this instance.` },
          { status: 409 },
        );
      }
    }

    // Subscribe the Page so Meta starts delivering webhooks.
    try {
      await subscribePageToApp({ pageId: page.id, pageAccessToken: page.access_token });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `Could not subscribe the Page to webhooks: ${message}` },
        { status: 400 },
      );
    }

    let encryptedToken: string;
    try {
      encryptedToken = encrypt(page.access_token);
    } catch {
      return NextResponse.json(
        { error: 'Failed to encrypt token. Check ENCRYPTION_KEY.' },
        { status: 500 },
      );
    }

    const now = new Date().toISOString();
    const { data: saved, error: saveError } = await ctx.supabase
      .from('social_channels')
      .upsert(
        targets.map((t) => ({
          account_id: ctx.accountId,
          created_by: ctx.userId,
          channel: t.channel,
          external_id: t.external_id,
          page_id: page.id,
          name: t.name,
          username: t.username,
          picture_url: t.picture_url,
          page_access_token: encryptedToken,
          status: 'connected',
          last_error: null,
          connected_at: now,
          updated_at: now,
        })),
        { onConflict: 'channel,external_id' },
      )
      .select(SAFE_COLUMNS);

    if (saveError) {
      console.error('[POST /api/social/channels] save error:', saveError);
      return NextResponse.json({ error: 'Failed to save channel' }, { status: 500 });
    }

    return NextResponse.json({ channels: saved ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const id = new URL(request.url).searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const { data: row } = await ctx.supabase
      .from('social_channels')
      .select('id, page_id, page_access_token')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!row) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }

    const { error } = await ctx.supabase
      .from('social_channels')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId);
    if (error) {
      console.error('[DELETE /api/social/channels] delete error:', error);
      return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
    }

    // Last channel on this Page gone → stop its webhooks. Instagram rides
    // on the same Page subscription, so keep it while either remains.
    const { count } = await ctx.supabase
      .from('social_channels')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ctx.accountId)
      .eq('page_id', row.page_id);
    if ((count ?? 0) === 0) {
      try {
        await unsubscribePageFromApp({
          pageId: row.page_id,
          pageAccessToken: decrypt(row.page_access_token),
        });
      } catch (err) {
        console.warn(
          '[DELETE /api/social/channels] unsubscribe failed (non-fatal):',
          err instanceof Error ? err.message : err,
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
