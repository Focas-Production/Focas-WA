// ============================================================
// GET  /api/v1/contacts  — list contacts (scope: contacts:read)
// POST /api/v1/contacts  — create a contact  (scope: contacts:write)
//
// List is keyset-paginated (see src/lib/api/v1/pagination.ts) and
// supports `?search=` (name/phone), `?tag=<tagId>` and
// `?allow_campaign=true|false` filters. Create
// is find-or-create by phone: an existing match returns 200 with
// `created: false`; a new row returns 201 with `created: true`.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import {
  CONTACT_SELECT,
  serializeContact,
  findOrCreateContact,
  setContactTags,
  getContactById,
  resolveAuditUserId,
  ContactError,
} from '@/lib/api/v1/contacts';
import { parseAllowCampaign } from '@/lib/contacts/campaign-consent';

// PostgREST filter values are comma/paren-delimited; strip anything
// that could break the `.or()` grammar before interpolating a search
// term. Leaves the characters a phone or name legitimately contains.
function sanitizeSearch(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} +@.\-_]/gu, '').trim();
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const search = sanitizeSearch(url.searchParams.get('search') ?? '');
    const tag = url.searchParams.get('tag');
    const allowCampaignParam = url.searchParams.get('allow_campaign');
    const allowCampaign =
      allowCampaignParam === null ? undefined : parseAllowCampaign(allowCampaignParam);
    if (allowCampaignParam !== null && allowCampaign === undefined) {
      return fail('bad_request', "'allow_campaign' must be true or false", 400);
    }

    // When filtering by tag, add an aliased INNER join on contact_tags
    // used purely for the WHERE — the parent is kept only if it has the
    // tag. The main `contact_tags(tags(*))` embed still returns the
    // contact's FULL tag set for serialization. This filters in one
    // bounded query (paged by limit+1) instead of pre-fetching an
    // unbounded id list into an `.in(...)`.
    const selectClause = tag
      ? `${CONTACT_SELECT}, tag_filter:contact_tags!inner(tag_id)`
      : CONTACT_SELECT;

    let query = ctx.supabase
      .from('contacts')
      .select(selectClause)
      .eq('account_id', ctx.accountId);

    if (search) {
      query = query.or(`name.ilike.*${search}*,phone.ilike.*${search}*`);
    }

    if (tag) {
      query = query.eq('tag_filter.tag_id', tag);
    }

    if (allowCampaign !== undefined) {
      query = query.eq('allow_campaign', allowCampaign);
    }

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/contacts] list error:', error);
      return fail('internal', 'Failed to list contacts', 500);
    }

    // Cast via unknown: the conditional `selectClause` (with the
    // tag_filter alias) is a runtime string, so supabase-js can't infer
    // a row type from it.
    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((r) => serializeContact(r as Record<string, unknown>)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!phone) {
      return fail('bad_request', "'phone' is required", 400);
    }

    let allowCampaign: boolean | undefined;
    if ('allow_campaign' in body) {
      if (typeof body.allow_campaign !== 'boolean') {
        return fail('bad_request', "'allow_campaign' must be a boolean", 400);
      }
      allowCampaign = body.allow_campaign;
    }

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const { id, created } = await findOrCreateContact(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      {
        phone,
        name: typeof body.name === 'string' ? body.name : undefined,
        email: typeof body.email === 'string' ? body.email : undefined,
        company: typeof body.company === 'string' ? body.company : undefined,
        allow_campaign: allowCampaign,
      }
    );

    // Find-or-create: an EXISTING contact keeps its fields, except an
    // explicit allow_campaign, which is applied — callers sync opt-outs
    // by phone through this endpoint, so it must not be ignored.
    if (!created && allowCampaign !== undefined) {
      const { error } = await ctx.supabase
        .from('contacts')
        .update({ allow_campaign: allowCampaign, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('account_id', ctx.accountId);
      if (error) {
        console.error('[api/v1/contacts] allow_campaign update error:', error);
        return fail('internal', 'Failed to update contact', 500);
      }
    }

    if (Array.isArray(body.tags)) {
      await setContactTags(
        ctx.supabase,
        ctx.accountId,
        auditUserId,
        id,
        body.tags.filter((t): t is string => typeof t === 'string')
      );
    }

    const contact = await getContactById(ctx.supabase, ctx.accountId, id);
    return ok(contact, created ? 201 : 200);
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
