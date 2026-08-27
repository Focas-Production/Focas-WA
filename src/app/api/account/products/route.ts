// ============================================================
// /api/account/products
//
//   GET  — list this account's catalog product map.
//   POST — manually add a product (pre-seed before its first order).
//
// Dashboard endpoints behind Settings → Catalog products (cookie
// session + RLS client). Rows are mostly auto-captured by the inbound
// webhook when an order arrives; this API exists so an admin can name
// products and pre-seed known retailer ids. Listing is open to any
// member; writes are admin+ (enforced by requireRole AND the
// catalog_products RLS policies from migration 043).
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

// Not exported — Next.js route modules may only export handlers, and
// the [id] route keeps its own copy.
const PRODUCT_COLUMNS =
  'id, retailer_id, name, price, currency, catalog_id, image_url, first_seen_at, last_seen_at';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from('catalog_products')
      .select(PRODUCT_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('last_seen_at', { ascending: false });

    if (error) {
      console.error('[GET /api/account/products] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load products' },
        { status: 500 }
      );
    }

    return NextResponse.json({ products: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:productCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      retailer_id?: unknown;
      name?: unknown;
    } | null;

    const retailerId =
      typeof body?.retailer_id === 'string' ? body.retailer_id.trim() : '';
    if (!retailerId || retailerId.length > 200) {
      return NextResponse.json(
        { error: "'retailer_id' is required (max 200 chars)" },
        { status: 400 }
      );
    }
    const name =
      typeof body?.name === 'string' && body.name.trim()
        ? body.name.trim().slice(0, 200)
        : null;

    const { data, error } = await ctx.supabase
      .from('catalog_products')
      .insert({
        account_id: ctx.accountId,
        retailer_id: retailerId,
        name,
      })
      .select(PRODUCT_COLUMNS)
      .single();

    if (error) {
      // 23505 = unique_violation on (account_id, retailer_id).
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'A product with this retailer id already exists' },
          { status: 409 }
        );
      }
      console.error('[POST /api/account/products] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to add product' },
        { status: 500 }
      );
    }

    return NextResponse.json({ product: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
