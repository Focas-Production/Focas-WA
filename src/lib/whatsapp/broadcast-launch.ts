// ============================================================
// Campaign launch — audience resolution + materialization.
//
// Runs server-side inside POST /api/broadcasts/launch, with the
// caller's RLS-scoped Supabase client, so a campaign is one request
// from the wizard instead of a browser loop:
//
//   1. resolve the audience (all / picked contacts / tags / custom
//      field / CSV, minus exclude tags), paging every query — a plain
//      select is silently capped at 1,000 rows by PostgREST;
//   2. de-duplicate by normalized phone, so one person never gets the
//      campaign twice (and never trips Meta's pair rate limit);
//   3. write the broadcasts row + one pending broadcast_recipients row
//      per contact, and prepay the wallet as ONE campaign debit;
//   4. hand the row to the engine as 'scheduled' (at now, or the
//      chosen time). broadcast-engine.ts does the actual sending.
//
// While steps 3–4 run the row is a 'draft', which neither the engine
// nor the cron ever picks up — a half-built campaign can't start
// sending. Any failure deletes it again (recipients cascade).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Contact } from '@/types';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import type { VariableMapping } from '@/lib/whatsapp/variable-resolution';
import { selectAll, selectByChunks } from '@/lib/supabase/select-all';
import {
  getTemplateCharge,
  chargeTemplateSend,
  settleBroadcastCharge,
  WalletError,
} from '@/lib/wallet/wallet';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'contacts' | 'tags' | 'custom_field' | 'csv';
  /** Hand-picked contact IDs (the "Select Contacts" audience type). */
  contactIds?: string[];
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

export interface LaunchInput {
  name: string;
  templateName: string;
  templateLanguage: string;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /** Media URL for an IMAGE/VIDEO/DOCUMENT header template. */
  headerMediaUrl?: string | null;
  /** ISO time to send at; omitted/null = send now. */
  scheduledAt?: string | null;
  /** Saved draft this launch came from — deleted on success. */
  draftId?: string | null;
}

export interface LaunchResult {
  broadcastId: string;
  totalRecipients: number;
  /** When the engine may start: now for "Send now". */
  scheduledAt: string;
  /** True when scheduledAt is in the future (cron delivers it). */
  isScheduled: boolean;
}

/** Caller-visible launch failure; the route maps `status` to HTTP. */
export class LaunchError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'LaunchError';
    this.status = status;
  }
}

const INSERT_CHUNK = 500;

async function contactsByIds(
  supabase: SupabaseClient,
  accountId: string,
  ids: readonly string[],
): Promise<Contact[]> {
  return selectByChunks<Contact>(ids, (chunk) =>
    supabase.from('contacts').select('*').eq('account_id', accountId).in('id', chunk),
  );
}

async function contactIdsWithTags(
  supabase: SupabaseClient,
  tagIds: readonly string[],
): Promise<Set<string>> {
  const rows = await selectAll<{ contact_id: string }>((from, to) =>
    supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', [...tagIds])
      .order('id')
      .range(from, to),
  );
  return new Set(rows.map((r) => r.contact_id));
}

async function customFieldContactIds(
  supabase: SupabaseClient,
  { fieldId, operator, value }: CustomFieldFilter,
): Promise<string[]> {
  const rows = await selectAll<{ contact_id: string }>((from, to) => {
    let query = supabase
      .from('contact_custom_values')
      .select('contact_id')
      .eq('custom_field_id', fieldId);
    // ilike with wildcards makes "contains" case-insensitive.
    if (operator === 'is') query = query.eq('value', value);
    else if (operator === 'is_not') query = query.neq('value', value);
    else if (operator === 'contains') query = query.ilike('value', `%${value}%`);
    return query.order('id').range(from, to);
  });
  return [...new Set(rows.map((r) => r.contact_id))];
}

/**
 * CSV rows are raw phone/name pairs; recipients need real contact
 * ids. Match existing contacts on `phone_normalized` (the column the
 * account-wide unique index is on, migration 022) so "+91 98840
 * 12345" in the CSV finds the stored "919884012345", then insert the
 * rest.
 */
async function upsertCsvContacts(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  csvRows: { phone: string; name?: string }[],
): Promise<Contact[]> {
  const byNormalized = new Map<string, { phone: string; name?: string }>();
  for (const row of csvRows) {
    const normalized = normalizePhone(row.phone ?? '');
    if (normalized && !byNormalized.has(normalized)) byNormalized.set(normalized, row);
  }
  const normalizedPhones = [...byNormalized.keys()];
  if (normalizedPhones.length === 0) return [];

  const existing = await selectByChunks<Contact & { phone_normalized: string }>(
    normalizedPhones,
    (chunk) =>
      supabase
        .from('contacts')
        .select('*')
        .eq('account_id', accountId)
        .in('phone_normalized', chunk),
  );
  const found = new Map<string, Contact>();
  for (const c of existing) found.set(c.phone_normalized, c);

  const missing = normalizedPhones
    .filter((n) => !found.has(n))
    .map((n) => {
      const row = byNormalized.get(n)!;
      return { user_id: userId, account_id: accountId, phone: row.phone, name: row.name ?? null };
    });
  for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
    const { data, error } = await supabase
      .from('contacts')
      .insert(missing.slice(i, i + INSERT_CHUNK))
      .select();
    if (error) {
      throw new LaunchError(`Failed to create CSV contacts: ${error.message}`, 500);
    }
    for (const c of (data ?? []) as Contact[]) found.set(normalizePhone(c.phone), c);
  }

  // Keep CSV order so the send order roughly matches the file.
  return normalizedPhones
    .map((n) => found.get(n))
    .filter((c): c is Contact => Boolean(c));
}

/** Resolve an audience to contacts. Every query is paged. */
export async function resolveAudience(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  audience: AudienceConfig,
): Promise<Contact[]> {
  let contacts: Contact[] = [];
  try {
    if (audience.type === 'all') {
      contacts = await selectAll<Contact>((from, to) =>
        supabase
          .from('contacts')
          .select('*')
          .eq('account_id', accountId)
          .order('id')
          .range(from, to),
      );
    } else if (audience.type === 'contacts' && audience.contactIds?.length) {
      contacts = await contactsByIds(supabase, accountId, audience.contactIds);
    } else if (audience.type === 'tags' && audience.tagIds?.length) {
      const ids = await contactIdsWithTags(supabase, audience.tagIds);
      contacts = await contactsByIds(supabase, accountId, [...ids]);
    } else if (audience.type === 'custom_field' && audience.customField) {
      const ids = await customFieldContactIds(supabase, audience.customField);
      contacts = await contactsByIds(supabase, accountId, ids);
    } else if (audience.type === 'csv' && audience.csvContacts?.length) {
      contacts = await upsertCsvContacts(supabase, accountId, userId, audience.csvContacts);
    }

    // Exclusion applies to every audience type — CSV rows resolve to
    // real contacts, which can carry tags too.
    if (audience.excludeTagIds?.length) {
      const excluded = await contactIdsWithTags(supabase, audience.excludeTagIds);
      contacts = contacts.filter((c) => !excluded.has(c.id));
    }
  } catch (err) {
    if (err instanceof LaunchError) throw err;
    throw new LaunchError(
      `Failed to resolve the audience: ${err instanceof Error ? err.message : 'unknown error'}`,
      500,
    );
  }

  // One recipient per phone number: two contacts sharing a number
  // would otherwise get the campaign twice.
  const seen = new Set<string>();
  return contacts.filter((c) => {
    const key = normalizePhone(c.phone ?? '') || `id:${c.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Materialize a campaign and hand it to the engine. Throws
 * {@link LaunchError}; nothing is left behind on failure.
 */
export async function launchBroadcast(
  supabase: SupabaseClient,
  ctx: { userId: string; accountId: string },
  input: LaunchInput,
): Promise<LaunchResult> {
  const name = input.name.trim();
  if (!name) throw new LaunchError('Give the broadcast a name.', 400);
  if (!input.templateName) throw new LaunchError('Choose a template.', 400);

  let scheduledAt = new Date();
  if (input.scheduledAt) {
    const when = new Date(input.scheduledAt);
    if (Number.isNaN(when.getTime())) {
      throw new LaunchError('Invalid schedule time.', 400);
    }
    if (when > scheduledAt) scheduledAt = when;
  }
  const isScheduled = scheduledAt.getTime() > Date.now();

  const contacts = await resolveAudience(
    supabase,
    ctx.accountId,
    ctx.userId,
    input.audience,
  );
  if (contacts.length === 0) {
    throw new LaunchError('No contacts found for this audience.', 400);
  }

  const { data: broadcast, error: insertErr } = await supabase
    .from('broadcasts')
    .insert({
      user_id: ctx.userId,
      account_id: ctx.accountId,
      name,
      template_name: input.templateName,
      template_language: input.templateLanguage,
      template_variables: input.variables,
      header_media_url: input.headerMediaUrl?.trim() || null,
      audience_filter: {
        type: input.audience.type,
        contactIds: input.audience.contactIds,
        tagIds: input.audience.tagIds,
        customField: input.audience.customField,
        excludeTagIds: input.audience.excludeTagIds,
      },
      status: 'draft',
      total_recipients: contacts.length,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    })
    .select('id')
    .single();
  if (insertErr || !broadcast) {
    throw new LaunchError(
      `Failed to create broadcast: ${insertErr?.message ?? 'unknown error'}`,
      500,
    );
  }
  const broadcastId = broadcast.id as string;

  let charged = false;
  try {
    for (let i = 0; i < contacts.length; i += INSERT_CHUNK) {
      const { error } = await supabase.from('broadcast_recipients').insert(
        contacts.slice(i, i + INSERT_CHUNK).map((c) => ({
          broadcast_id: broadcastId,
          contact_id: c.id,
          status: 'pending' as const,
        })),
      );
      if (error) {
        throw new LaunchError(`Failed to add recipients: ${error.message}`, 500);
      }
    }

    // ONE ledger debit for the whole campaign; the engine refunds
    // never-sent recipients in one settle row when it finishes.
    const { category, pricePaise } = await getTemplateCharge(
      ctx.accountId,
      input.templateName,
      input.templateLanguage,
    );
    try {
      await chargeTemplateSend({
        accountId: ctx.accountId,
        reference: `broadcast:${broadcastId}`,
        category,
        pricePaise,
        quantity: contacts.length,
        description: `Broadcast "${name}" — ${contacts.length} × Template "${input.templateName}"`,
        createdBy: ctx.userId,
      });
      charged = true;
    } catch (err) {
      if (err instanceof WalletError && err.code === 'insufficient_balance') {
        throw new LaunchError(err.message, 402);
      }
      throw err;
    }

    const { error: queueErr } = await supabase
      .from('broadcasts')
      .update({ status: 'scheduled', scheduled_at: scheduledAt.toISOString() })
      .eq('id', broadcastId);
    if (queueErr) {
      throw new LaunchError(`Failed to queue broadcast: ${queueErr.message}`, 500);
    }
  } catch (err) {
    if (charged) {
      // Debit taken but the campaign never queued: fail every
      // recipient (no wamid) and settle, which refunds all of them.
      await supabase
        .from('broadcast_recipients')
        .update({ status: 'failed', error_message: 'Launch failed' })
        .eq('broadcast_id', broadcastId);
      await supabase.from('broadcasts').update({ status: 'failed' }).eq('id', broadcastId);
      await settleBroadcastCharge(ctx.accountId, broadcastId);
    } else {
      await supabase.from('broadcasts').delete().eq('id', broadcastId);
    }
    if (err instanceof LaunchError) throw err;
    console.error('[broadcast-launch] launch failed:', err);
    throw new LaunchError('Failed to launch broadcast.', 500);
  }

  if (input.draftId) {
    await supabase
      .from('broadcasts')
      .delete()
      .eq('id', input.draftId)
      .eq('status', 'draft');
  }

  return {
    broadcastId,
    totalRecipients: contacts.length,
    scheduledAt: scheduledAt.toISOString(),
    isScheduled,
  };
}
