// ============================================================
// /api/account/products/[id]
//
//   PATCH  — update a product's name / image_url (admin+).
//   DELETE — remove a product from the map (admin+).
//
// Companion to /api/account/products (Settings → Catalog products).
// Tenancy is double-guarded: the explicit account_id filter here plus
// the catalog_products RLS policies from migration 043.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const PRODUCT_COLUMNS =
  'id, retailer_id, name, price, currency, catalog_id, image_url, first_seen_at, last_seen_at';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;

    const limit = checkRateLimit(
      `admin:productUpdate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      image_url?: unknown;
    } | null;

    const patch: Record<string, string | null> = {};
    if (body && 'name' in body) {
      if (body.name !== null && typeof body.name !== 'string') {
        return NextResponse.json(
          { error: "'name' must be a string or null" },
          { status: 400 }
        );
      }
      patch.name =
        typeof body.name === 'string' && body.name.trim()
          ? body.name.trim().slice(0, 200)
          : null;
    }
    if (body && 'image_url' in body) {
      if (body.image_url !== null && typeof body.image_url !== 'string') {
        return NextResponse.json(
          { error: "'image_url' must be a string or null" },
          { status: 400 }
        );
      }
      const url = typeof body.image_url === 'string' ? body.image_url.trim() : '';
      if (url && !/^https:\/\//i.test(url)) {
        return NextResponse.json(
          { error: "'image_url' must be an https:// URL" },
          { status: 400 }
        );
      }
      patch.image_url = url ? url.slice(0, 2000) : null;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: 'Nothing to update' },
        { status: 400 }
      );
    }

    const { data, error } = await ctx.supabase
      .from('catalog_products')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(PRODUCT_COLUMNS)
      .maybeSingle();

    if (error) {
      console.error('[PATCH /api/account/products] update error:', error);
      return NextResponse.json(
        { error: 'Failed to update product' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    return NextResponse.json({ product: data });
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
    const { id } = await params;

    const limit = checkRateLimit(
      `admin:productDelete:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { data, error } = await ctx.supabase
      .from('catalog_products')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[DELETE /api/account/products] delete error:', error);
      return NextResponse.json(
        { error: 'Failed to delete product' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
