// ============================================================
// PATCH  /api/account/webhooks/[id] — update url / events / is_active
// DELETE /api/account/webhooks/[id] — remove the endpoint
//
// Dashboard (cookie-session) counterpart of /api/v1/webhooks/[id],
// with the same semantics: account-scoped (a foreign id → 404, never
// 403), the signing secret is never returned, and re-enabling a
// disabled endpoint resets its consecutive-failure streak. Admin+,
// enforced here and by the webhook_endpoints RLS policies.
//
// Hard delete (unlike API-key soft revoke): an endpoint is a sink,
// not a credential — there is nothing to keep for audit once the
// deliverer stops POSTing to it.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  WEBHOOK_PUBLIC_COLUMNS,
  normalizeWebhookUrl,
  serializeWebhookEndpoint,
} from '@/lib/webhooks/endpoints';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:webhookUpdate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Request body must be a JSON object' },
        { status: 400 }
      );
    }

    const updates: Record<string, unknown> = {};

    if ('url' in body) {
      const url = normalizeWebhookUrl(body.url);
      if (!url) {
        return NextResponse.json(
          { error: "'url' must be a valid https:// URL" },
          { status: 400 }
        );
      }
      updates.url = url;
    }

    if ('events' in body) {
      const events = normalizeEvents(body.events);
      if (!events) {
        return NextResponse.json(
          { error: "'events' must be a non-empty array of known event names" },
          { status: 400 }
        );
      }
      updates.events = events;
    }

    if ('is_active' in body) {
      if (typeof body.is_active !== 'boolean') {
        return NextResponse.json(
          { error: "'is_active' must be a boolean" },
          { status: 400 }
        );
      }
      updates.is_active = body.is_active;
      // Re-enabling a disabled endpoint clears its failure streak so it
      // isn't instantly re-disabled by a single stale failure.
      if (body.is_active === true) updates.failure_count = 0;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'No updatable fields provided' },
        { status: 400 }
      );
    }

    // Scope the update by account_id so a foreign id touches nothing;
    // the returned row (null when unmatched) drives the 404.
    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .update(updates)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .maybeSingle();

    if (error) {
      console.error('[PATCH /api/account/webhooks/[id]] error:', error);
      return NextResponse.json(
        { error: 'Failed to update webhook' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }

    return NextResponse.json({
      webhook: serializeWebhookEndpoint(data as Record<string, unknown>),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:webhookDelete:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[DELETE /api/account/webhooks/[id]] error:', error);
      return NextResponse.json(
        { error: 'Failed to delete webhook' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
