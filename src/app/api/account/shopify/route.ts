// ============================================================
// /api/account/shopify — Settings → Shopify (dashboard, cookie auth)
//
//   GET    — read this account's Shopify connection (secret-free).
//   PUT    — connect / update (upsert; admin+).
//   DELETE — disconnect (admin+).
//
// The webhook signing secret is stored AES-256-GCM-encrypted and
// never read back out — GET only reports whether one is saved.
// Omitting `webhook_secret` on PUT keeps the stored one, so admins
// can edit mappings without re-entering it.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  normalizeEventTemplates,
  normalizeShopDomain,
} from '@/lib/shopify/events';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

// Everything except the encrypted secret.
const SAFE_COLUMNS =
  'id, shop_domain, is_active, event_templates, created_at, updated_at';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from('shopify_config')
      .select(`${SAFE_COLUMNS}, webhook_secret`)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[GET /api/account/shopify] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load Shopify config' },
        { status: 500 }
      );
    }

    if (!data) return NextResponse.json({ config: null });

    const { webhook_secret, ...safe } = data as Record<string, unknown>;
    return NextResponse.json({
      config: { ...safe, has_secret: Boolean(webhook_secret) },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:shopifyConfig:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      shop_domain?: unknown;
      webhook_secret?: unknown;
      is_active?: unknown;
      event_templates?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Request body must be a JSON object' },
        { status: 400 }
      );
    }

    const shopDomain = normalizeShopDomain(body.shop_domain);
    if (!shopDomain) {
      return NextResponse.json(
        {
          error:
            "'shop_domain' must be your permanent *.myshopify.com domain (e.g. mystore.myshopify.com)",
        },
        { status: 400 }
      );
    }

    const eventTemplates = normalizeEventTemplates(body.event_templates ?? {});
    if (eventTemplates === null) {
      return NextResponse.json(
        { error: "'event_templates' contains an unknown topic or a malformed mapping" },
        { status: 400 }
      );
    }

    const isActive =
      typeof body.is_active === 'boolean' ? body.is_active : true;

    const rawSecret =
      typeof body.webhook_secret === 'string' ? body.webhook_secret.trim() : '';

    const { data: existing } = await ctx.supabase
      .from('shopify_config')
      .select('id')
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    // A first-time connect must include the signing secret; later
    // saves may omit it to keep the stored one.
    if (!existing && !rawSecret) {
      return NextResponse.json(
        { error: "'webhook_secret' is required to connect a store" },
        { status: 400 }
      );
    }

    const values: Record<string, unknown> = {
      shop_domain: shopDomain,
      is_active: isActive,
      event_templates: eventTemplates,
    };
    if (rawSecret) values.webhook_secret = encrypt(rawSecret);

    const query = existing
      ? ctx.supabase
          .from('shopify_config')
          .update(values)
          .eq('account_id', ctx.accountId)
      : ctx.supabase.from('shopify_config').insert({
          ...values,
          account_id: ctx.accountId,
          created_by: ctx.userId,
        });

    const { data, error } = await query.select(SAFE_COLUMNS).single();

    if (error || !data) {
      // Unique shop_domain: another account already claimed this store.
      if (error?.code === '23505') {
        return NextResponse.json(
          { error: 'This store is already connected to another account' },
          { status: 409 }
        );
      }
      console.error('[PUT /api/account/shopify] save error:', error);
      return NextResponse.json(
        { error: 'Failed to save Shopify config' },
        { status: 500 }
      );
    }

    return NextResponse.json({ config: { ...data, has_secret: true } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:shopifyDisconnect:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { data, error } = await ctx.supabase
      .from('shopify_config')
      .delete()
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[DELETE /api/account/shopify] error:', error);
      return NextResponse.json(
        { error: 'Failed to disconnect Shopify' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json(
        { error: 'No Shopify store connected' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
