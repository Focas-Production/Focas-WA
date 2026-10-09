'use client';

import { useEffect, useState } from 'react';
import { Loader2, BarChart3, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

// ============================================================
// Wallet usage report (WATI-style): period picker, spend tiles,
// and spend grouped by campaign / template / source / category /
// day. Aggregates come from /api/wallet/usage (computed in SQL);
// clicking a row drills the transaction history down to it.
// ============================================================

export type PeriodPreset = '7d' | '30d' | 'this_month' | 'last_month' | 'all';
export type Period = { kind: PeriodPreset } | { kind: 'month'; month: string };
export type UsageGroup = 'campaign' | 'template' | 'source' | 'category' | 'day';

/** A usage row the history table is filtered down to. */
export interface UsageDrill {
  label: string;
  source?: string;
  /** null = rows with no source_ref (e.g. inbox sends). */
  sourceRef?: string | null;
  /** null = rows with no template. */
  templateName?: string | null;
  templateCategory?: string;
  /** Overrides the period range (day drill-down). */
  start?: string;
  end?: string;
}

interface UsageRow {
  key: string;
  label: string | null;
  source: string | null;
  source_ref: string | null;
  debit_paise: number;
  refund_paise: number;
  credit_paise: number;
  net_spend_paise: number;
  messages: number;
  refunded_messages: number;
  net_messages: number;
  tx_count: number;
  last_at: string | null;
}

interface UsageResponse {
  totals: UsageRow | null;
  rows: UsageRow[];
}

const PRESETS: PeriodPreset[] = ['7d', '30d', 'this_month', 'last_month', 'all'];
const GROUPS: UsageGroup[] = ['campaign', 'template', 'source', 'category', 'day'];

/** Local-time [start, end) for a period; null bounds = open-ended. */
export function periodRange(period: Period): { start: string | null; end: string | null } {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (period.kind) {
    case '7d':
    case '30d': {
      const days = period.kind === '7d' ? 6 : 29;
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - days);
      return { start: start.toISOString(), end: null };
    }
    case 'this_month':
      return { start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), end: null };
    case 'last_month':
      return {
        start: new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString(),
        end: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      };
    case 'month': {
      const [y, m] = period.month.split('-').map(Number);
      return {
        start: new Date(y, m - 1, 1).toISOString(),
        end: new Date(y, m, 1).toISOString(),
      };
    }
    default:
      return { start: null, end: null };
  }
}

/** Short tag for file names: '2026-10', 'last-30-days', … */
export function periodSlug(period: Period): string {
  if (period.kind === 'month') return period.month;
  const now = new Date();
  const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (period.kind === 'this_month') return ym(now);
  if (period.kind === 'last_month') return ym(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  if (period.kind === 'all') return 'all-time';
  return period.kind === '7d' ? 'last-7-days' : 'last-30-days';
}

function formatMoney(paise: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency || 'INR',
    minimumFractionDigits: 2,
  }).format(paise / 100);
}

function formatCount(n: number): string {
  return new Intl.NumberFormat('en-IN').format(n);
}

export function WalletUsage({
  currency,
  period,
  onPeriodChange,
  onDrill,
  refreshKey,
}: {
  currency: string;
  period: Period;
  onPeriodChange: (p: Period) => void;
  onDrill: (drill: UsageDrill) => void;
  refreshKey: number;
}) {
  const t = useTranslations('Settings.wallet');
  const [group, setGroup] = useState<UsageGroup>('campaign');
  // Loading/failed are derived from which request last settled, so
  // the effect only sets state from async callbacks.
  const requestKey = `${group}|${JSON.stringify(period)}|${refreshKey}`;
  const [data, setData] = useState<UsageResponse | null>(null);
  const [settled, setSettled] = useState<{ key: string; failed: boolean } | null>(null);
  const loading = settled?.key !== requestKey;
  const failed = !loading && Boolean(settled?.failed);

  useEffect(() => {
    const controller = new AbortController();
    const { start, end } = periodRange(period);
    const qs = new URLSearchParams({ group });
    if (start) qs.set('from', start);
    if (end) qs.set('to', end);
    try {
      qs.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      // server defaults to Asia/Kolkata
    }
    fetch(`/api/wallet/usage?${qs}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        setData((await res.json()) as UsageResponse);
        setSettled({ key: requestKey, failed: false });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error('[wallet] usage load failed:', err);
        setSettled({ key: requestKey, failed: true });
      });
    return () => controller.abort();
  }, [group, period, refreshKey, requestKey]);

  const totals = data?.totals;
  const netSpend = totals?.net_spend_paise ?? 0;
  const netMessages = totals?.net_messages ?? 0;
  const maxRowSpend = Math.max(0, ...(data?.rows ?? []).map((r) => r.net_spend_paise));

  function rowName(r: UsageRow): string {
    switch (group) {
      case 'campaign':
        if (r.label) return r.label;
        switch (r.source) {
          case 'broadcast':
            return r.source_ref ? t('usage.names.deletedBroadcast') : t('usage.names.quickBulk');
          case 'automation':
            return r.source_ref ? t('usage.names.deletedAutomation') : t('usage.names.automations');
          case 'api':
            return r.source_ref ? t('usage.names.deletedKey') : t('usage.names.api');
          case 'shopify':
            return r.source_ref ? `Shopify · ${r.source_ref}` : 'Shopify';
          case 'inbox':
            return t('usage.names.inbox');
          default:
            return t('usage.names.unattributed');
        }
      case 'template':
        return r.key || t('usage.names.noTemplate');
      case 'source':
        return t(`usage.source.${r.key}` as 'usage.source.other');
      case 'category':
        return r.key ? t(`pricing.${r.key}` as 'pricing.marketing') : t('usage.names.unknown');
      case 'day': {
        const [y, m, d] = r.key.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString(undefined, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });
      }
    }
  }

  function drillFor(r: UsageRow): UsageDrill {
    const label = rowName(r);
    switch (group) {
      case 'campaign':
        return { label, source: r.source ?? 'other', sourceRef: r.source_ref ?? null };
      case 'template':
        return { label, templateName: r.key || null };
      case 'source':
        return { label, source: r.key };
      case 'category':
        return { label, templateCategory: r.key };
      case 'day': {
        const [y, m, d] = r.key.split('-').map(Number);
        return {
          label,
          start: new Date(y, m - 1, d).toISOString(),
          end: new Date(y, m - 1, d + 1).toISOString(),
        };
      }
    }
  }

  const chip = (active: boolean) =>
    `rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all ${
      active
        ? 'border-primary/30 bg-primary/10 text-primary'
        : 'border-border bg-muted text-muted-foreground hover:text-foreground'
    }`;

  const tiles = [
    {
      label: t('usage.tiles.spent'),
      value: formatMoney(netSpend, currency),
      hint: t('usage.tiles.spentHint', {
        debit: formatMoney(totals?.debit_paise ?? 0, currency),
      }),
      className: 'text-foreground',
    },
    {
      label: t('usage.tiles.messages'),
      value: formatCount(netMessages),
      hint:
        netMessages > 0
          ? t('usage.tiles.avgCost', { cost: formatMoney(netSpend / netMessages, currency) })
          : '—',
      className: 'text-foreground',
    },
    {
      label: t('usage.tiles.refunded'),
      value: formatMoney(totals?.refund_paise ?? 0, currency),
      hint: t('usage.tiles.refundedHint', {
        count: formatCount(totals?.refunded_messages ?? 0),
      }),
      className: 'text-amber-500',
    },
    {
      label: t('usage.tiles.added'),
      value: formatMoney(totals?.credit_paise ?? 0, currency),
      hint: t('usage.tiles.addedHint'),
      className: 'text-emerald-500',
    },
  ];

  return (
    <div className="rounded-xl border border-border bg-card/50 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <BarChart3 className="h-4 w-4 text-primary" />
            {t('usage.title')}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('usage.desc')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => onPeriodChange({ kind: p })}
              className={chip(period.kind === p)}
            >
              {t(`usage.period.${p}`)}
            </button>
          ))}
          <input
            type="month"
            value={period.kind === 'month' ? period.month : ''}
            max={new Date().toISOString().slice(0, 7)}
            onChange={(e) =>
              e.target.value
                ? onPeriodChange({ kind: 'month', month: e.target.value })
                : onPeriodChange({ kind: 'this_month' })
            }
            aria-label={t('usage.period.pickMonth')}
            className={`h-7 rounded-md border px-2 text-xs [color-scheme:light] dark:[color-scheme:dark] ${
              period.kind === 'month'
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-border bg-muted text-foreground'
            }`}
          />
        </div>
      </div>

      {/* Tiles */}
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-lg border border-border bg-muted/50 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">{tile.label}</p>
            <p className={`mt-0.5 text-lg font-semibold tabular-nums ${tile.className}`}>
              {loading && !data ? '—' : tile.value}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={tile.hint}>
              {loading && !data ? '' : tile.hint}
            </p>
          </div>
        ))}
      </div>

      {/* Group tabs */}
      <div className="mt-5 flex flex-wrap items-center gap-1.5 border-b border-border pb-2">
        <span className="mr-1 text-xs text-muted-foreground">{t('usage.groupBy')}</span>
        {GROUPS.map((g) => (
          <button key={g} onClick={() => setGroup(g)} className={chip(group === g)}>
            {t(`usage.group.${g}`)}
          </button>
        ))}
        {loading && <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin text-primary" />}
      </div>

      {failed ? (
        <p className="mt-4 text-sm text-red-400">{t('usage.loadError')}</p>
      ) : data && data.rows.length === 0 && !loading ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('usage.empty')}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">{t(`usage.col.${group}`)}</th>
                <th className="py-2 pr-3 text-right font-medium">{t('usage.col.messages')}</th>
                <th className="py-2 pr-3 text-right font-medium">{t('usage.col.charged')}</th>
                <th className="py-2 pr-3 text-right font-medium">{t('usage.col.refunded')}</th>
                <th className="py-2 pr-3 text-right font-medium">{t('usage.col.net')}</th>
                {group !== 'day' && (
                  <th className="hidden py-2 text-right font-medium md:table-cell">
                    {t('usage.col.lastActivity')}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((r) => {
                const share = maxRowSpend > 0 ? (r.net_spend_paise / maxRowSpend) * 100 : 0;
                return (
                  <tr
                    key={r.key}
                    onClick={() => onDrill(drillFor(r))}
                    className="group cursor-pointer border-b border-border/50 hover:bg-muted/40"
                    title={t('usage.drillHint')}
                  >
                    <td className="max-w-[300px] py-2.5 pr-3">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-foreground">{rowName(r)}</span>
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      </div>
                      {group === 'campaign' && r.source && (
                        <span className="text-[11px] text-muted-foreground">
                          {t(`usage.source.${r.source}` as 'usage.source.other')}
                        </span>
                      )}
                      {group !== 'source' && (
                        <div className="mt-1 h-1 w-full max-w-[200px] overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary/60"
                            style={{ width: `${Math.max(share, r.net_spend_paise > 0 ? 2 : 0)}%` }}
                          />
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-right tabular-nums text-foreground">
                      {formatCount(r.net_messages)}
                      {r.refunded_messages > 0 && (
                        <span className="block text-[11px] text-muted-foreground">
                          {t('usage.ofSent', { sent: formatCount(r.messages) })}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-right tabular-nums text-muted-foreground">
                      {formatMoney(r.debit_paise, currency)}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-right tabular-nums text-amber-500">
                      {r.refund_paise > 0 ? `+${formatMoney(r.refund_paise, currency)}` : '—'}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-right font-medium tabular-nums text-foreground">
                      {group === 'source' && r.credit_paise > 0 ? (
                        <span className="text-emerald-500">
                          +{formatMoney(r.credit_paise, currency)}
                        </span>
                      ) : (
                        formatMoney(r.net_spend_paise, currency)
                      )}
                    </td>
                    {group !== 'day' && (
                      <td className="hidden whitespace-nowrap py-2.5 text-right text-xs text-muted-foreground md:table-cell">
                        {r.last_at ? new Date(r.last_at).toLocaleString() : '—'}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
