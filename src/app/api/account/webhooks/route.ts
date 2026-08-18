// ============================================================
// /api/account/webhooks
//
//   GET  — list this account's webhook endpoints (secret-free).
//   POST — register a new endpoint.
//
// These are the *dashboard* endpoints behind Settings → Webhooks,
// so they authenticate the normal way (cookie session) and go
// through the RLS client — the same table the public
// `/api/v1/webhooks` routes manage with an API key. Listing is open
// to any member (viewer+); registering is admin+ (an endpoint
// receives message content), enforced by both `requireRole('admin')`
// here and the `webhook_endpoints_insert` RLS policy.
//
// IMPORTANT: the signing secret is returned exactly ONCE, in the
// POST response. We persist only an AES-256-GCM-encrypted copy for
// the delivery signer, and no read path ever decrypts it back out.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  WEBHOOK_PUBLIC_COLUMNS,
  generateWebhookSecret,
  normalizeWebhookUrl,
  serializeWebhookEndpoint,
} from '@/lib/webhooks/endpoints';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function GET() {
  try {
    // Any member can view the roster (RLS allows it); we just need a
    // resolved account context.
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[GET /api/account/webhooks] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load webhooks' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      webhooks: (data ?? []).map((r) =>
        serializeWebhookEndpoint(r as Record<string, unknown>)
      ),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:webhookCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      url?: unknown;
      events?: unknown;
    } | null;

    const url = normalizeWebhookUrl(body?.url);
    if (!url) {
      return NextResponse.json(
        { error: "'url' must be a valid https:// URL" },
        { status: 400 }
      );
    }

    const events = normalizeEvents(body?.events);
    if (!events) {
      return NextResponse.json(
        { error: "'events' must be a non-empty array of known event names" },
        { status: 400 }
      );
    }

    const secret = generateWebhookSecret();

    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .insert({
        account_id: ctx.accountId,
        created_by: ctx.userId,
        url,
        secret: encrypt(secret),
        events,
      })
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .single();

    if (error || !data) {
      console.error('[POST /api/account/webhooks] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to create webhook' },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        webhook: serializeWebhookEndpoint(data as Record<string, unknown>),
        // Plaintext signing secret — shown to the admin exactly once.
        secret,
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
