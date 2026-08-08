'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Contact, CustomField, Tag } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Users,
  UserCheck,
  Tags,
  Filter,
  Upload,
  Loader2,
  ArrowRight,
  ArrowLeft,
  Search,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

type AudienceType = 'all' | 'contacts' | 'tags' | 'custom_field' | 'csv';
type CustomFieldOperator = 'is' | 'is_not' | 'contains';

interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

interface AudienceConfig {
  type: AudienceType;
  contactIds?: string[];
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
}

/**
 * Minimal CSV parser for the audience upload. Handles quoted fields
 * ("a,b"), CRLF, and both comma and semicolon delimiters. Returns rows
 * of raw string cells — header interpretation happens in the caller.
 */
function parseCsv(text: string): string[][] {
  const delimiter = (() => {
    const firstLine = text.slice(0, text.indexOf('\n') + 1 || text.length);
    return (firstLine.match(/;/g)?.length ?? 0) >
      (firstLine.match(/,/g)?.length ?? 0)
      ? ';'
      : ',';
  })();

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const PHONE_HEADER_ALIASES = [
  'phone',
  'phone number',
  'phone_number',
  'mobile',
  'number',
  'whatsapp',
];
const NAME_HEADER_ALIASES = ['name', 'full name', 'full_name', 'contact name'];

/** Keeps leading +, strips spaces/dashes/parens; '' if not phone-like. */
function normalizeCsvPhone(raw: string): string {
  const cleaned = raw.trim().replace(/[\s().-]/g, '');
  const normalized = cleaned.startsWith('+')
    ? '+' + cleaned.slice(1).replace(/\D/g, '')
    : cleaned.replace(/\D/g, '');
  const digits = normalized.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? normalized : '';
}

interface Step2Props {
  audience: AudienceConfig;
  onUpdate: (audience: AudienceConfig) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step2SelectAudience({
  audience,
  onUpdate,
  onNext,
  onBack,
}: Step2Props) {
  const t = useTranslations('Broadcasts.wizard');

  const OPERATOR_OPTIONS = useMemo<{ value: CustomFieldOperator; label: string }[]>(() => [
    { value: 'is', label: t('selectAudience.operatorIs') },
    { value: 'is_not', label: t('selectAudience.operatorIsNot') },
    { value: 'contains', label: t('selectAudience.operatorContains') },
  ], [t]);

  const audienceOptions = useMemo<{
    type: AudienceType;
    label: string;
    description: string;
    icon: typeof Users;
  }[]>(() => [
    {
      type: 'all',
      label: t('selectAudience.method.all'),
      description: t('selectAudience.allDescLoading'),
      icon: Users,
    },
    {
      type: 'contacts',
      label: t('selectAudience.method.contacts'),
      description: t('selectAudience.contactsDesc'),
      icon: UserCheck,
    },
    {
      type: 'tags',
      label: t('selectAudience.method.tags'),
      description: t('selectAudience.tagDesc'),
      icon: Tags,
    },
    {
      type: 'custom_field',
      label: t('selectAudience.method.customField'),
      description: t('selectAudience.customFieldDesc'),
      icon: Filter,
    },
    {
      type: 'csv',
      label: t('selectAudience.method.csv'),
      description: t('selectAudience.csvDesc'),
      icon: Upload,
    },
  ], [t]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [estimatedCount, setEstimatedCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);

  // "Select Contacts" picker state
  const [contactSearch, setContactSearch] = useState('');
  const [contactResults, setContactResults] = useState<Contact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  // Details of already-selected contacts so their chips stay labeled
  // even when the search results no longer include them.
  const [selectedContacts, setSelectedContacts] = useState<
    Map<string, Contact>
  >(new Map());

  // CSV upload state
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  // Tags are used both by the primary "Filter by Tags" audience type
  // AND by the exclude-list below — so always load once on mount.
  useEffect(() => {
    async function fetchTags() {
      setLoadingTags(true);
      try {
        const supabase = createClient();
        const { data } = await supabase.from('tags').select('*').order('name');
        setTags(data ?? []);
      } finally {
        setLoadingTags(false);
      }
    }
    fetchTags();
  }, []);

  // Lazy-load custom fields only when that audience type is active.
  useEffect(() => {
    if (audience.type !== 'custom_field') return;
    async function fetchFields() {
      setLoadingFields(true);
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from('custom_fields')
          .select('*')
          .order('field_name');
        setCustomFields(data ?? []);
      } finally {
        setLoadingFields(false);
      }
    }
    fetchFields();
  }, [audience.type]);

  // Contact picker — load on activation, re-query on search (debounced).
  useEffect(() => {
    if (audience.type !== 'contacts') return;
    const handle = setTimeout(async () => {
      setLoadingContacts(true);
      try {
        const supabase = createClient();
        let q = supabase
          .from('contacts')
          .select('*')
          .order('name', { ascending: true, nullsFirst: false })
          .limit(50);
        const term = contactSearch.trim();
        if (term) {
          // Escape PostgREST or-filter specials, then match name/phone.
          const safe = term.replace(/[,()%]/g, ' ').trim();
          if (safe) q = q.or(`name.ilike.%${safe}%,phone.ilike.%${safe}%`);
        }
        const { data } = await q;
        setContactResults(data ?? []);
      } finally {
        setLoadingContacts(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [audience.type, contactSearch]);

  // Hydrate labels for contact IDs selected in a previous visit to this
  // step (state survives Back/Next but this component remounts).
  useEffect(() => {
    if (audience.type !== 'contacts') return;
    const ids = audience.contactIds ?? [];
    const missing = ids.filter((id) => !selectedContacts.has(id));
    if (missing.length === 0) return;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from('contacts')
        .select('*')
        .in('id', missing);
      if (data && data.length > 0) {
        setSelectedContacts((prev) => {
          const next = new Map(prev);
          for (const c of data as Contact[]) next.set(c.id, c);
          return next;
        });
      }
    })();
    // selectedContacts intentionally omitted — running on ids change is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience.type, audience.contactIds]);

  const fetchEstimatedCount = useCallback(async () => {
    setLoadingCount(true);
    try {
      const supabase = createClient();

      // Base query — produces the superset before exclude is applied.
      let baseIds: Set<string> | null = null; // null means "all contacts"

      if (audience.type === 'all') {
        // Handled below — full-table count adjusted by excludes.
      } else if (
        audience.type === 'contacts' &&
        audience.contactIds &&
        audience.contactIds.length > 0
      ) {
        baseIds = new Set(audience.contactIds);
      } else if (
        audience.type === 'tags' &&
        audience.tagIds &&
        audience.tagIds.length > 0
      ) {
        const { data } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.tagIds);
        baseIds = new Set((data ?? []).map((r) => r.contact_id));
      } else if (
        audience.type === 'custom_field' &&
        audience.customField?.fieldId &&
        audience.customField.value
      ) {
        const { fieldId, operator, value } = audience.customField;
        let q = supabase
          .from('contact_custom_values')
          .select('contact_id')
          .eq('custom_field_id', fieldId);
        if (operator === 'is') q = q.eq('value', value);
        else if (operator === 'is_not') q = q.neq('value', value);
        else q = q.ilike('value', `%${value}%`);
        const { data } = await q;
        baseIds = new Set((data ?? []).map((r) => r.contact_id));
      } else if (
        audience.type === 'csv' &&
        audience.csvContacts &&
        audience.csvContacts.length > 0
      ) {
        setEstimatedCount(audience.csvContacts.length);
        return;
      } else {
        // Partially-configured audience — wait for the user to finish.
        setEstimatedCount(null);
        return;
      }

      // Apply exclude tags
      let excludeSet: Set<string> | null = null;
      if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
        const { data: excludeRows } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.excludeTagIds);
        excludeSet = new Set((excludeRows ?? []).map((r) => r.contact_id));
      }

      if (baseIds) {
        const effective = [...baseIds].filter(
          (id) => !excludeSet?.has(id),
        );
        setEstimatedCount(effective.length);
      } else {
        // "All" — fetch the total, then subtract exclude set if any.
        const { count } = await supabase
          .from('contacts')
          .select('*', { count: 'exact', head: true });
        const total = count ?? 0;
        setEstimatedCount(excludeSet ? Math.max(0, total - excludeSet.size) : total);
      }
    } finally {
      setLoadingCount(false);
    }
  }, [
    audience.type,
    audience.contactIds,
    audience.tagIds,
    audience.customField,
    audience.csvContacts,
    audience.excludeTagIds,
  ]);

  useEffect(() => {
    fetchEstimatedCount();
  }, [fetchEstimatedCount]);

  function toggleContact(contact: Contact) {
    const current = audience.contactIds ?? [];
    const isSelected = current.includes(contact.id);
    const updated = isSelected
      ? current.filter((id) => id !== contact.id)
      : [...current, contact.id];
    setSelectedContacts((prev) => {
      const next = new Map(prev);
      if (isSelected) next.delete(contact.id);
      else next.set(contact.id, contact);
      return next;
    });
    onUpdate({ ...audience, contactIds: updated });
  }

  function selectAllResults() {
    const current = new Set(audience.contactIds ?? []);
    setSelectedContacts((prev) => {
      const next = new Map(prev);
      for (const c of contactResults) next.set(c.id, c);
      return next;
    });
    for (const c of contactResults) current.add(c.id);
    onUpdate({ ...audience, contactIds: [...current] });
  }

  function clearContactSelection() {
    setSelectedContacts(new Map());
    onUpdate({ ...audience, contactIds: [] });
  }

  function handleCsvFile(file: File) {
    setCsvError(null);
    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onerror = () => setCsvError(t('selectAudience.errorCsvParse'));
    reader.onload = () => {
      try {
        const text = String(reader.result ?? '');
        const rows = parseCsv(text);
        if (rows.length === 0) {
          setCsvError(t('selectAudience.errorCsvParse'));
          return;
        }

        const header = rows[0].map((h) => h.trim().toLowerCase());
        let phoneCol = header.findIndex((h) =>
          PHONE_HEADER_ALIASES.includes(h),
        );
        let nameCol = header.findIndex((h) => NAME_HEADER_ALIASES.includes(h));
        let dataRows = rows.slice(1);

        // Headerless file: if the first cell of the first row already
        // parses as a phone number, treat every row as data.
        if (phoneCol === -1 && normalizeCsvPhone(rows[0][0] ?? '')) {
          phoneCol = 0;
          nameCol = rows[0].length > 1 ? 1 : -1;
          dataRows = rows;
        }

        if (phoneCol === -1) {
          setCsvError(t('selectAudience.errorCsvMissingPhone'));
          onUpdate({ ...audience, csvContacts: undefined });
          return;
        }

        const seen = new Set<string>();
        const contacts: { phone: string; name?: string }[] = [];
        for (const row of dataRows) {
          const phone = normalizeCsvPhone(row[phoneCol] ?? '');
          if (!phone || seen.has(phone)) continue;
          seen.add(phone);
          const name =
            nameCol >= 0 ? row[nameCol]?.trim() || undefined : undefined;
          contacts.push({ phone, name });
        }

        if (contacts.length === 0) {
          setCsvError(t('selectAudience.errorCsvParse'));
          onUpdate({ ...audience, csvContacts: undefined });
          return;
        }
        onUpdate({ ...audience, csvContacts: contacts });
      } catch {
        setCsvError(t('selectAudience.errorCsvParse'));
      }
    };
    reader.readAsText(file);
  }

  function toggleTag(tagId: string) {
    const current = audience.tagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, tagIds: updated });
  }

  function toggleExcludeTag(tagId: string) {
    const current = audience.excludeTagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, excludeTagIds: updated });
  }

  function updateCustomField(patch: Partial<CustomFieldFilter>) {
    const prev = audience.customField ?? {
      fieldId: '',
      operator: 'is' as CustomFieldOperator,
      value: '',
    };
    onUpdate({ ...audience, customField: { ...prev, ...patch } });
  }

  const isValid =
    audience.type === 'all' ||
    (audience.type === 'contacts' &&
      audience.contactIds &&
      audience.contactIds.length > 0) ||
    (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) ||
    (audience.type === 'custom_field' &&
      !!audience.customField?.fieldId &&
      audience.customField.value.length > 0) ||
    (audience.type === 'csv' &&
      audience.csvContacts &&
      audience.csvContacts.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('selectAudience.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('selectAudience.subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {audienceOptions.map((option: { type: AudienceType; label: string; description: string; icon: typeof Users }) => {
          const isSelected = audience.type === option.type;
          const Icon = option.icon;
          return (
            <button
              key={option.type}
              onClick={() =>
                onUpdate({
                  ...audience,
                  type: option.type,
                  // Wipe shape fields from other types to avoid stale
                  // config leaking across selections.
                  contactIds:
                    option.type === 'contacts' ? audience.contactIds : undefined,
                  tagIds: option.type === 'tags' ? audience.tagIds : undefined,
                  customField:
                    option.type === 'custom_field'
                      ? audience.customField
                      : undefined,
                  csvContacts:
                    option.type === 'csv' ? audience.csvContacts : undefined,
                })
              }
              className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
                isSelected
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                  : 'border-border bg-card/50 hover:border-border'
              }`}
            >
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  isSelected
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{option.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {option.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {audience.type === 'contacts' && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground">
              {t('selectAudience.selectContacts')}
            </p>
            <span className="text-xs text-muted-foreground">
              {t('selectAudience.selectedCount', {
                count: audience.contactIds?.length ?? 0,
              })}
            </span>
          </div>

          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={contactSearch}
              onChange={(e) => setContactSearch(e.target.value)}
              placeholder={t('selectAudience.searchContacts')}
              className="h-9 w-full rounded-lg border border-border bg-muted pl-8 pr-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Selected chips (kept visible across searches) */}
          {(audience.contactIds?.length ?? 0) > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {(audience.contactIds ?? []).map((id) => {
                const c = selectedContacts.get(id);
                return (
                  <button
                    key={id}
                    onClick={() => {
                      const contact = selectedContacts.get(id);
                      if (contact) toggleContact(contact);
                      else
                        onUpdate({
                          ...audience,
                          contactIds: (audience.contactIds ?? []).filter(
                            (x) => x !== id,
                          ),
                        });
                    }}
                    className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs text-primary"
                    title={c?.phone ?? ''}
                  >
                    {c?.name || c?.phone || '…'}
                    <X className="h-3 w-3" />
                  </button>
                );
              })}
              <button
                onClick={clearContactSelection}
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                {t('selectAudience.clearSelection')}
              </button>
            </div>
          )}

          {loadingContacts ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : contactResults.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('selectAudience.noContactsFound')}
            </p>
          ) : (
            <>
              <div className="mb-2">
                <button
                  onClick={selectAllResults}
                  className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                >
                  {t('selectAudience.selectAllShown', {
                    count: contactResults.length,
                  })}
                </button>
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
                {contactResults.map((contact) => {
                  const isSelected = audience.contactIds?.includes(contact.id);
                  return (
                    <button
                      key={contact.id}
                      onClick={() => toggleContact(contact)}
                      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all ${
                        isSelected
                          ? 'border-primary/30 bg-primary/10'
                          : 'border-transparent hover:bg-muted'
                      }`}
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                          isSelected
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-muted'
                        }`}
                      >
                        {isSelected ? '✓' : ''}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">
                          {contact.name || contact.phone}
                        </span>
                        {contact.name && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {contact.phone}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {audience.type === 'csv' && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <p className="mb-1 text-sm font-medium text-foreground">
            {t('selectAudience.uploadCsv')}
          </p>
          <p className="mb-3 text-xs text-muted-foreground">
            {t('selectAudience.csvFormatDesc')}
          </p>

          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleCsvFile(file);
              // Allow re-selecting the same file after a fix.
              e.target.value = '';
            }}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              onClick={() => csvInputRef.current?.click()}
              className="border-border text-foreground"
            >
              <Upload className="h-4 w-4" />
              {t('selectAudience.uploadCsv')}
            </Button>
            {csvFileName && (
              <span className="text-xs text-muted-foreground">{csvFileName}</span>
            )}
          </div>

          {csvError && (
            <p className="mt-3 text-xs text-red-400">{csvError}</p>
          )}
          {!csvError &&
            audience.csvContacts &&
            audience.csvContacts.length > 0 && (
              <p className="mt-3 text-xs text-primary">
                {t('selectAudience.csvContactsFound', {
                  count: audience.csvContacts.length,
                })}
              </p>
            )}
        </div>
      )}

      {audience.type === 'tags' && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <p className="mb-3 text-sm font-medium text-foreground">{t('selectAudience.selectTags')}</p>
          {loadingTags ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : tags.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('selectAudience.noTagsFound')}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const isSelected = audience.tagIds?.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    onClick={() => toggleTag(tag.id)}
                    className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                      isSelected
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'border-border bg-muted text-muted-foreground hover:border-border'
                    }`}
                  >
                    <span
                      className="mr-1.5 h-2 w-2 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {audience.type === 'custom_field' && (
        <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <p className="text-sm font-medium text-foreground">{t('selectAudience.method.customField')}</p>
          {loadingFields ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : customFields.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('selectAudience.errorLoadFields')}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)]">
              <select
                value={audience.customField?.fieldId ?? ''}
                onChange={(e) => updateCustomField({ fieldId: e.target.value })}
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="">{t('selectAudience.selectField')}</option>
                {customFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.field_name}
                  </option>
                ))}
              </select>
              <select
                value={audience.customField?.operator ?? 'is'}
                onChange={(e) =>
                  updateCustomField({
                    operator: e.target.value as CustomFieldOperator,
                  })
                }
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                {OPERATOR_OPTIONS.map((op: { value: CustomFieldOperator; label: string }) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={audience.customField?.value ?? ''}
                onChange={(e) => updateCustomField({ value: e.target.value })}
                placeholder={t('selectAudience.valuePlaceholder')}
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </div>
          )}
        </div>
      )}

      {/* Exclude list — applies regardless of audience type */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <X className="h-4 w-4 text-red-400" />
          <p className="text-sm font-medium text-foreground">
            {t('selectAudience.excludeTags')}
          </p>
        </div>
        {tags.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('selectAudience.noTagsFound')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => {
              const isExcluded = audience.excludeTagIds?.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  onClick={() => toggleExcludeTag(tag.id)}
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                    isExcluded
                      ? 'border-red-500/30 bg-red-500/10 text-red-300'
                      : 'border-border bg-muted text-muted-foreground hover:border-border'
                  }`}
                >
                  <span
                    className="mr-1.5 h-2 w-2 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Audience Summary */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <p className="mb-2 text-sm font-medium text-foreground">Audience Summary</p>
        {loadingCount ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-xs text-muted-foreground">Calculating…</span>
          </div>
        ) : estimatedCount !== null ? (
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            <span className="text-sm text-foreground">
              {estimatedCount.toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground">estimated recipients</span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Select an audience type to see the estimate.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!isValid}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
