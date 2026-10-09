'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Wallet,
  Loader2,
  Plus,
  RefreshCw,
  ArrowDownLeft,
  ArrowUpRight,
  RotateCcw,
  AlertTriangle,
  Banknote,
  ShieldCheck,
  Download,
  X,
} from 'lucide-react';
import { toCsv, downloadBlob } from '@/lib/csv';
import {
  WalletUsage,
  periodRange,
  periodSlug,
  type Period,
  type UsageDrill,
} from './wallet-usage';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

/** Razorpay Checkout global, injected by its script tag. */
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

interface WalletInfo {
  balance_paise: number;
  currency: string;
  low_balance_threshold_paise: number;
  pricing: Partial<Record<'marketing' | 'utility' | 'authentication', number>>;
  razorpay_configured: boolean;
  /** Approver gate armed (WALLET_APPROVER_PHONE set server-side). */
  manual_credit_otp: boolean;
  /** Owner-only identity details; null for other roles. */
  manual_credit_label: string | null;
  manual_credit_phone_hint: string | null;
  manual_credit_phone_valid: boolean;
}

interface WalletTx {
  id: string;
  type: 'credit' | 'debit' | 'refund';
  amount_paise: number;
  balance_after_paise: number;
  category: string;
  description: string | null;
  created_at: string;
  source: string | null;
  source_ref: string | null;
  template_name: string | null;
  template_category: string | null;
  quantity: number | null;
}

const TX_COLUMNS =
  'id, type, amount_paise, balance_after_paise, category, description, created_at, source, source_ref, template_name, template_category, quantity';

/** The subset of the PostgREST filter builder the history filters use. */
interface TxFilterable<T> {
  eq(column: string, value: string): T;
  is(column: string, value: null): T;
  gte(column: string, value: string): T;
  lt(column: string, value: string): T;
}

const TX_PAGE_SIZE = 25;
const PRESET_AMOUNTS_RUPEES = [500, 1000, 2000, 5000];

function formatMoney(paise: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency || 'INR',
    minimumFractionDigits: 2,
  }).format(paise / 100);
}

/** Meta rates carry fractions of a paisa (₹0.7846) — show up to 4 dp. */
function formatRate(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(paise / 100);
}

let razorpayScriptPromise: Promise<void> | null = null;
function loadRazorpayScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (!razorpayScriptPromise) {
    razorpayScriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = () => resolve();
      s.onerror = () => {
        razorpayScriptPromise = null;
        reject(new Error('Failed to load Razorpay checkout'));
      };
      document.body.appendChild(s);
    });
  }
  return razorpayScriptPromise;
}

export function WalletSettings() {
  const t = useTranslations('Settings.wallet');
  const { user, accountRole } = useAuth();
  const isOwner = accountRole === 'owner';
  const canTopUp = accountRole === 'owner' || accountRole === 'admin';

  const [info, setInfo] = useState<WalletInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const [topupRupees, setTopupRupees] = useState<string>('1000');
  const [topupBusy, setTopupBusy] = useState(false);

  const [manualOpen, setManualOpen] = useState(false);
  const [manualStep, setManualStep] = useState<'form' | 'code'>('form');
  const [manualRupees, setManualRupees] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [manualRequestId, setManualRequestId] = useState<string | null>(null);
  const [manualBusy, setManualBusy] = useState(false);

  const [transactions, setTransactions] = useState<WalletTx[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [txFilter, setTxFilter] = useState<'all' | 'credit' | 'debit' | 'refund'>('all');
  /** Shared by the usage report and the history below it. */
  const [period, setPeriod] = useState<Period>({ kind: 'this_month' });
  /** Usage row the history is drilled down to, if any. */
  const [drill, setDrill] = useState<UsageDrill | null>(null);
  const [usageRefresh, setUsageRefresh] = useState(0);
  const historyRef = useRef<HTMLDivElement>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [txHasMore, setTxHasMore] = useState(false);
  const txOffset = useRef(0);

  const loadWallet = useCallback(async () => {
    try {
      const res = await fetch('/api/wallet');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load wallet');
      setInfo(data as WalletInfo);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load wallet');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTransactions = useCallback(
    async (reset: boolean) => {
      setTxLoading(true);
      try {
        const supabase = createClient();
        const from = reset ? 0 : txOffset.current;
        const q = applyTxFilters(
          supabase
            .from('wallet_transactions')
            .select(TX_COLUMNS)
            .order('created_at', { ascending: false })
            .range(from, from + TX_PAGE_SIZE - 1),
        );
        const { data, error } = await q;
        if (error) throw error;
        const rows = (data ?? []) as WalletTx[];
        setTransactions((prev) => (reset ? rows : [...prev, ...rows]));
        txOffset.current = from + rows.length;
        setTxHasMore(rows.length === TX_PAGE_SIZE);
      } catch {
        toast.error(t('history.loadError'));
      } finally {
        setTxLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyTxFilters reads exactly these
    [txFilter, period, drill, t],
  );

  /**
   * Type chip + period (or the drill's own range) + drill filters.
   * Shared by the paged history and the CSV export so both always
   * show the same rows.
   */
  function applyTxFilters<T extends TxFilterable<T>>(q: T): T {
    if (txFilter !== 'all') q = q.eq('type', txFilter);
    const range =
      drill?.start || drill?.end
        ? { start: drill.start ?? null, end: drill.end ?? null }
        : periodRange(period);
    if (range.start) q = q.gte('created_at', range.start);
    if (range.end) q = q.lt('created_at', range.end);
    if (drill) {
      if (drill.source) q = q.eq('source', drill.source);
      if (drill.sourceRef !== undefined) {
        q = drill.sourceRef === null ? q.is('source_ref', null) : q.eq('source_ref', drill.sourceRef);
      }
      if (drill.templateName !== undefined) {
        q =
          drill.templateName === null
            ? q.is('template_name', null)
            : q.eq('template_name', drill.templateName);
      }
      if (drill.templateCategory !== undefined) {
        q = drill.templateCategory
          ? q.eq('template_category', drill.templateCategory)
          : q.is('template_category', null);
      }
    }
    return q;
  }

  function handleDrill(next: UsageDrill) {
    setDrill(next);
    historyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function handlePeriodChange(next: Period) {
    setPeriod(next);
    setDrill(null);
  }

  function sourceLabel(source: string | null): string | null {
    return source ? t(`usage.source.${source}` as 'usage.source.other') : null;
  }

  /**
   * Full statement export for the current month/type filter —
   * ascending (statement order), amounts signed (debits negative)
   * so a spreadsheet SUM reconciles against the closing balance.
   */
  async function handleExportCsv() {
    setExportBusy(true);
    try {
      const supabase = createClient();
      const rows: WalletTx[] = [];
      for (let from = 0; ; from += 1000) {
        const q = applyTxFilters(
          supabase
            .from('wallet_transactions')
            .select(TX_COLUMNS)
            .order('created_at', { ascending: true })
            .range(from, from + 999),
        );
        const { data, error } = await q;
        if (error) throw error;
        rows.push(...((data ?? []) as WalletTx[]));
        if (!data || data.length < 1000) break;
      }
      const header = [
        'Date',
        'Type',
        'Category',
        'Source',
        'Source ref',
        'Template',
        'Template category',
        'Messages',
        'Description',
        'Amount (INR)',
        'Balance after (INR)',
      ];
      const body = rows.map((tx) => [
        new Date(tx.created_at).toLocaleString('en-IN'),
        tx.type,
        tx.category,
        tx.source ?? '',
        tx.source_ref ?? '',
        tx.template_name ?? '',
        tx.template_category ?? '',
        String(tx.quantity ?? ''),
        tx.description ?? '',
        ((tx.type === 'debit' ? -1 : 1) * (tx.amount_paise / 100)).toFixed(2),
        (tx.balance_after_paise / 100).toFixed(2),
      ]);
      const suffix = [periodSlug(period), drill ? 'filtered' : '', txFilter !== 'all' ? txFilter : '']
        .filter(Boolean)
        .join('-');
      downloadBlob(
        `wallet-statement${suffix ? `-${suffix}` : ''}.csv`,
        toCsv([header, ...body]),
      );
      toast.success(t('history.exported', { count: rows.length }));
    } catch {
      toast.error(t('history.exportFailed'));
    } finally {
      setExportBusy(false);
    }
  }

  useEffect(() => {
    loadWallet();
  }, [loadWallet]);

  useEffect(() => {
    loadTransactions(true);
  }, [loadTransactions]);

  const refreshAll = useCallback(() => {
    loadWallet();
    loadTransactions(true);
    setUsageRefresh((n) => n + 1);
  }, [loadWallet, loadTransactions]);

  async function handleRazorpayTopup() {
    const rupees = Number(topupRupees);
    if (!Number.isFinite(rupees) || rupees < 100) {
      toast.error(t('topup.minAmount'));
      return;
    }
    setTopupBusy(true);
    try {
      const res = await fetch('/api/wallet/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount_paise: Math.round(rupees * 100) }),
      });
      const order = await res.json();
      if (!res.ok) throw new Error(order.error || 'Failed to create order');

      await loadRazorpayScript();
      if (!window.Razorpay) throw new Error('Razorpay failed to load');

      const rzp = new window.Razorpay({
        key: order.key_id,
        order_id: order.order_id,
        amount: order.amount_paise,
        currency: order.currency,
        name: 'Wallet top-up',
        prefill: { email: user?.email ?? '' },
        handler: async (resp: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => {
          try {
            const vres = await fetch('/api/wallet/topup/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(resp),
            });
            const vdata = await vres.json();
            if (!vres.ok) throw new Error(vdata.error || 'Verification failed');
            toast.success(t('topup.success'));
            refreshAll();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Verification failed');
          }
        },
        modal: { ondismiss: () => setTopupBusy(false) },
        theme: { color: '#7c3aed' },
      });
      rzp.open();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Top-up failed');
    } finally {
      setTopupBusy(false);
    }
  }

  function resetManualDialog(open: boolean) {
    setManualOpen(open);
    if (!open) {
      setManualStep('form');
      setManualRupees('');
      setManualNote('');
      setManualCode('');
      setManualRequestId(null);
    }
  }

  /**
   * Gated flow, step 1: lock the amount into an approval request and
   * WhatsApp the code to the approver. The server message names the
   * amount + workspace, so the approver never approves blind.
   */
  async function handleRequestApproval() {
    const rupees = Number(manualRupees);
    if (!Number.isFinite(rupees) || rupees <= 0) {
      toast.error(t('manual.invalidAmount'));
      return;
    }
    setManualBusy(true);
    try {
      const res = await fetch('/api/wallet/manual-credit/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount_paise: Math.round(rupees * 100),
          note: manualNote,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('manual.otpSendFailed'));
      setManualRequestId(data.request_id);
      setManualStep('code');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('manual.otpSendFailed'));
    } finally {
      setManualBusy(false);
    }
  }

  async function handleManualCredit() {
    const gated = Boolean(info?.manual_credit_otp);
    // The approver sees "Request ID: WCR-123456" — accept pasted
    // "WCR-123456" too by keeping digits only.
    const codeDigits = manualCode.replace(/\D+/g, '');
    if (gated) {
      if (!manualRequestId || !/^\d{6}$/.test(codeDigits)) {
        toast.error(t('manual.approvalCodeHint'));
        return;
      }
    } else {
      const rupees = Number(manualRupees);
      if (!Number.isFinite(rupees) || rupees <= 0) {
        toast.error(t('manual.invalidAmount'));
        return;
      }
    }
    setManualBusy(true);
    try {
      const res = await fetch('/api/wallet/manual-credit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          gated
            ? { request_id: manualRequestId, approval_code: codeDigits }
            : {
                amount_paise: Math.round(Number(manualRupees) * 100),
                note: manualNote,
              },
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Manual credit failed');
      toast.success(t('manual.success'));
      resetManualDialog(false);
      refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Manual credit failed');
    } finally {
      setManualBusy(false);
    }
  }

  const currency = info?.currency ?? 'INR';
  const lowBalance =
    info !== null && info.balance_paise < info.low_balance_threshold_paise;

  const txMeta: Record<
    WalletTx['type'],
    { icon: typeof ArrowUpRight; className: string; sign: string }
  > = {
    credit: { icon: ArrowDownLeft, className: 'text-emerald-500', sign: '+' },
    refund: { icon: RotateCcw, className: 'text-amber-500', sign: '+' },
    debit: { icon: ArrowUpRight, className: 'text-red-400', sign: '−' },
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {/* Balance */}
      <div className="rounded-xl border border-border bg-card/50 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Wallet className="h-4 w-4" />
              {t('balance.label')}
            </div>
            <p className="mt-1 text-3xl font-bold tracking-tight text-foreground">
              {info ? formatMoney(info.balance_paise, currency) : '—'}
            </p>
            {lowBalance && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-500">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t('balance.lowWarning', {
                  threshold: info
                    ? formatMoney(info.low_balance_threshold_paise, currency)
                    : '',
                })}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            onClick={refreshAll}
            className="border-border text-muted-foreground"
          >
            <RefreshCw className="h-4 w-4" />
            {t('refresh')}
          </Button>
        </div>
      </div>

      {/* Top up */}
      {canTopUp && (
        <div className="rounded-xl border border-border bg-card/50 p-5">
          <p className="text-sm font-medium text-foreground">{t('topup.title')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('topup.desc')}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {PRESET_AMOUNTS_RUPEES.map((amt) => (
              <button
                key={amt}
                onClick={() => setTopupRupees(String(amt))}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                  Number(topupRupees) === amt
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border bg-muted text-muted-foreground hover:border-border'
                }`}
              >
                ₹{amt.toLocaleString('en-IN')}
              </button>
            ))}
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">₹</span>
              <Input
                type="number"
                min={100}
                value={topupRupees}
                onChange={(e) => setTopupRupees(e.target.value)}
                className="w-28 border-border bg-muted text-foreground"
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              onClick={handleRazorpayTopup}
              disabled={topupBusy || !info?.razorpay_configured}
              className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {topupBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {t('topup.payButton')}
            </Button>
            {isOwner && (
              <Button
                variant="outline"
                onClick={() => setManualOpen(true)}
                className="border-border text-muted-foreground"
              >
                <Banknote className="h-4 w-4" />
                {t('manual.button')}
              </Button>
            )}
          </div>
          {!info?.razorpay_configured && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('topup.notConfigured')}
            </p>
          )}
        </div>
      )}

      {/* Approver gate for manual credits (owner only) — read-only:
          the approver is configured via WALLET_APPROVER_PHONE /
          WALLET_APPROVER_NAME in the server environment, so
          repointing it requires server access, not a session. */}
      {isOwner && (
        <div className="rounded-xl border border-border bg-card/50 p-5">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ShieldCheck className="h-4 w-4 text-primary" />
            {t('approver.title')}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('approver.desc')}</p>
          <p className="mt-2 text-xs">
            {info?.manual_credit_otp ? (
              info.manual_credit_phone_valid ? (
                <span className="text-emerald-500">
                  {t('approver.active', {
                    label: info.manual_credit_label ?? 'Approver',
                    hint: info.manual_credit_phone_hint ?? '',
                  })}
                </span>
              ) : (
                <span className="text-red-400">{t('approver.invalidPhone')}</span>
              )
            ) : (
              <span className="text-amber-500">{t('approver.inactive')}</span>
            )}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t('approver.envNote')}
          </p>
        </div>
      )}

      {/* Meta rate card (fixed, informational) */}
      <div className="rounded-xl border border-border bg-card/50 p-5">
        <p className="text-sm font-medium text-foreground">{t('pricing.title')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('pricing.desc')}</p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(['marketing', 'utility', 'authentication'] as const).map((category) => (
            <div
              key={category}
              className="rounded-lg border border-border bg-muted/50 px-3 py-2.5"
            >
              <p className="text-xs text-muted-foreground">{t(`pricing.${category}`)}</p>
              <p className="mt-0.5 text-sm font-medium text-foreground">
                {formatRate(info?.pricing?.[category] ?? 0)}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  {t('pricing.perMessage')}
                </span>
              </p>
            </div>
          ))}
        </div>
      </div>

      <WalletUsage
        currency={currency}
        period={period}
        onPeriodChange={handlePeriodChange}
        onDrill={handleDrill}
        refreshKey={usageRefresh}
      />

      {/* History */}
      <div ref={historyRef} className="scroll-mt-4 rounded-xl border border-border bg-card/50 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground">{t('history.title')}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {(['all', 'credit', 'debit', 'refund'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setTxFilter(f)}
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all ${
                  txFilter === f
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border bg-muted text-muted-foreground'
                }`}
              >
                {t(`history.filter.${f}`)}
              </button>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCsv}
              disabled={exportBusy}
              className="h-7 border-border text-muted-foreground"
            >
              {exportBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {t('history.export')}
            </Button>
          </div>
        </div>

        {drill && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('history.showing')}</span>
            <button
              onClick={() => setDrill(null)}
              className="flex max-w-full items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
              title={t('history.clearFilter')}
            >
              <span className="truncate">{drill.label}</span>
              <X className="h-3 w-3 shrink-0" />
            </button>
          </div>
        )}

        {transactions.length === 0 && !txLoading ? (
          <p className="mt-4 text-sm text-muted-foreground">{t('history.empty')}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">{t('history.colDate')}</th>
                  <th className="pb-2 pr-3 font-medium">{t('history.colDescription')}</th>
                  <th className="pb-2 pr-3 text-right font-medium">{t('history.colAmount')}</th>
                  <th className="pb-2 text-right font-medium">{t('history.colBalance')}</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => {
                  const meta = txMeta[tx.type];
                  const Icon = meta.icon;
                  return (
                    <tr key={tx.id} className="border-b border-border/50">
                      <td className="whitespace-nowrap py-2.5 pr-3 text-xs text-muted-foreground">
                        {new Date(tx.created_at).toLocaleString()}
                      </td>
                      <td className="max-w-[280px] py-2.5 pr-3">
                        <div className="flex items-center gap-2">
                          <Icon className={`h-3.5 w-3.5 shrink-0 ${meta.className}`} />
                          <span className="truncate text-foreground" title={tx.description ?? ''}>
                            {tx.description || tx.category}
                          </span>
                        </div>
                        <span className="ml-5 block text-[11px] text-muted-foreground">
                          {[
                            sourceLabel(tx.source),
                            tx.type === 'credit' ? tx.category : tx.template_category,
                            (tx.quantity ?? 0) > 1
                              ? t('history.messagesCount', { count: tx.quantity ?? 0 })
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </td>
                      <td
                        className={`whitespace-nowrap py-2.5 pr-3 text-right font-medium ${meta.className}`}
                      >
                        {meta.sign}
                        {formatMoney(tx.amount_paise, currency)}
                      </td>
                      <td className="whitespace-nowrap py-2.5 text-right text-muted-foreground">
                        {formatMoney(tx.balance_after_paise, currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          {txLoading && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          {!txLoading && txHasMore && (
            <Button
              variant="outline"
              onClick={() => loadTransactions(false)}
              className="border-border text-muted-foreground"
            >
              {t('history.loadMore')}
            </Button>
          )}
        </div>
      </div>

      {/* Manual credit dialog — two-step when an approver WhatsApp
          number is set: request approval (OTP sent) → enter code. */}
      <Dialog open={manualOpen} onOpenChange={resetManualDialog}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('manual.title')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {manualStep === 'code'
                ? t('manual.codeStepDesc', {
                    label: info?.manual_credit_label ?? 'Approver',
                    hint: info?.manual_credit_phone_hint ?? '',
                  })
                : t('manual.desc')}
            </DialogDescription>
          </DialogHeader>

          {manualStep === 'form' ? (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  {t('manual.amount')}
                </label>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-muted-foreground">₹</span>
                  <Input
                    type="number"
                    min={1}
                    value={manualRupees}
                    onChange={(e) => setManualRupees(e.target.value)}
                    className="border-border bg-muted text-foreground"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  {t('manual.note')}
                </label>
                <Input
                  value={manualNote}
                  onChange={(e) => setManualNote(e.target.value)}
                  placeholder={t('manual.notePlaceholder')}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
              {info?.manual_credit_otp && (
                <p className="text-[11px] text-muted-foreground">
                  {t('manual.gatedNotice', {
                    label: info.manual_credit_label ?? 'Approver',
                  })}
                </p>
              )}
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                {t('manual.approvalCode', {
                  label: info?.manual_credit_label ?? 'Approver',
                })}
              </label>
              <Input
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                inputMode="numeric"
                maxLength={12}
                placeholder={t('manual.approvalCodePlaceholder')}
                className="border-border bg-muted font-mono tracking-widest text-foreground placeholder:text-muted-foreground"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t('manual.approvalCodeHint')}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => resetManualDialog(false)}
              className="border-border text-muted-foreground"
            >
              {t('manual.cancel')}
            </Button>
            {manualStep === 'form' && info?.manual_credit_otp ? (
              <Button
                onClick={handleRequestApproval}
                disabled={manualBusy}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {manualBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('manual.requestApproval')}
              </Button>
            ) : (
              <Button
                onClick={handleManualCredit}
                disabled={
                  manualBusy ||
                  (manualStep === 'code' &&
                    !/^\d{6}$/.test(manualCode.replace(/\D+/g, '')))
                }
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {manualBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('manual.confirm')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
