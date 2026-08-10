'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  Send,
  Loader2,
  Users,
  Save,
  Wallet,
  AlertTriangle,
  CalendarClock,
  Zap,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

interface AudienceConfig {
  type: string;
  contactIds?: string[];
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  /** Called with an ISO timestamp when scheduling, undefined for send-now. */
  onSend: (scheduledAt?: string) => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

/** Local-time value for <input type="datetime-local">, minutes precision. */
function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  // Send timing: now, or a scheduled moment delivered by the server
  // cron (no browser needed at send time).
  const [sendMode, setSendMode] = useState<'now' | 'schedule'>('now');
  const [scheduleValue, setScheduleValue] = useState<string>(() =>
    toDatetimeLocal(new Date(Date.now() + 60 * 60 * 1000)),
  );
  const scheduleDate = sendMode === 'schedule' ? new Date(scheduleValue) : null;
  const scheduleInvalid =
    sendMode === 'schedule' &&
    (!scheduleDate ||
      Number.isNaN(scheduleDate.getTime()) ||
      scheduleDate.getTime() < Date.now() + 5 * 60 * 1000);
  const [walletBalancePaise, setWalletBalancePaise] = useState<number | null>(null);
  const [pricePaise, setPricePaise] = useState<number | null>(null);

  // Wallet balance + this template's per-message rate, so the user
  // sees the campaign cost before confirming.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/wallet');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setWalletBalancePaise(Number(data.balance_paise ?? 0));
        const category = (template.category ?? 'Marketing').toLowerCase();
        const price =
          data.pricing?.[category] ?? data.pricing?.marketing ?? null;
        setPricePaise(price !== null ? Number(price) : null);
      } catch {
        // Wallet info is a nicety here — the send API still enforces it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [template.category]);

  const estimatedCostPaise =
    pricePaise !== null ? pricePaise * estimatedReach : null;
  const insufficientFunds =
    walletBalancePaise !== null &&
    estimatedCostPaise !== null &&
    estimatedCostPaise > walletBalancePaise;

  const formatINR = (paise: number) =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(
      paise / 100,
    );

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'contacts' && audience.contactIds) {
          setEstimatedReach(audience.contactIds.length);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'contacts'
      ? t('scheduleSend.audienceContacts')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('scheduleSend.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('scheduleSend.broadcastName')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Estimated Reach</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Language</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.estimatedCost')}</p>
            <div className="flex items-center gap-1.5">
              <Wallet className="h-3.5 w-3.5 text-primary" />
              <p className="font-medium text-foreground">
                {estimatedCostPaise !== null ? formatINR(estimatedCostPaise) : '—'}
              </p>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.walletBalance')}</p>
            <p className={`font-medium ${insufficientFunds ? 'text-red-400' : 'text-foreground'}`}>
              {walletBalancePaise !== null ? formatINR(walletBalancePaise) : '—'}
            </p>
          </div>
        </div>
        {insufficientFunds && (
          <p className="flex items-center gap-1.5 text-xs text-amber-500">
            <AlertTriangle className="h-3.5 w-3.5" />
            {t('scheduleSend.insufficientFunds')}
          </p>
        )}
      </div>

      {/* When to send */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <p className="mb-3 text-sm font-medium text-foreground">{t('scheduleSend.whenTitle')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            onClick={() => setSendMode('now')}
            className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-all ${
              sendMode === 'now'
                ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                : 'border-border bg-card/50'
            }`}
          >
            <Zap className={`mt-0.5 h-4 w-4 shrink-0 ${sendMode === 'now' ? 'text-primary' : 'text-muted-foreground'}`} />
            <span>
              <span className="block text-sm font-medium text-foreground">{t('scheduleSend.sendNowOption')}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t('scheduleSend.sendNowDesc')}</span>
            </span>
          </button>
          <button
            onClick={() => setSendMode('schedule')}
            className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-all ${
              sendMode === 'schedule'
                ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                : 'border-border bg-card/50'
            }`}
          >
            <CalendarClock className={`mt-0.5 h-4 w-4 shrink-0 ${sendMode === 'schedule' ? 'text-primary' : 'text-muted-foreground'}`} />
            <span>
              <span className="block text-sm font-medium text-foreground">{t('scheduleSend.scheduleOption')}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t('scheduleSend.scheduleDesc')}</span>
            </span>
          </button>
        </div>

        {sendMode === 'schedule' && (
          <div className="mt-3">
            <label className="mb-1 block text-xs text-muted-foreground">
              {t('scheduleSend.scheduleAt')}
            </label>
            <input
              type="datetime-local"
              value={scheduleValue}
              min={toDatetimeLocal(new Date(Date.now() + 5 * 60 * 1000))}
              onChange={(e) => setScheduleValue(e.target.value)}
              className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
            {scheduleInvalid && (
              <p className="mt-1.5 text-xs text-red-400">
                {t('scheduleSend.scheduleTooSoon')}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">{t('scheduleSend.sending')}</p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogTrigger
            render={
              <Button
                disabled={!name.trim() || isProcessing || scheduleInvalid}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              />
            }
          >
            {sendMode === 'schedule' ? (
              <CalendarClock className="h-4 w-4" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {sendMode === 'schedule'
              ? t('scheduleSend.scheduleButton')
              : t('scheduleSend.sendNow')}
          </DialogTrigger>
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {sendMode === 'schedule'
                  ? t('scheduleSend.confirmScheduleTitle')
                  : 'Confirm Broadcast'}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {sendMode === 'schedule' && scheduleDate ? (
                  <>
                    {t('scheduleSend.confirmScheduleDesc', {
                      count: estimatedReach.toLocaleString(),
                      template: template.name,
                      when: scheduleDate.toLocaleString(),
                    })}
                  </>
                ) : (
                  <>
                    You are about to send this broadcast to{' '}
                    <span className="font-medium text-popover-foreground">{estimatedReach.toLocaleString()}</span>{' '}
                    contacts using the{' '}
                    <span className="font-medium text-popover-foreground">{template.name}</span> template.
                    This action cannot be undone.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                className="border-border text-muted-foreground"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={() => {
                  setShowConfirm(false);
                  onSend(
                    sendMode === 'schedule' && scheduleDate
                      ? scheduleDate.toISOString()
                      : undefined,
                  );
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {sendMode === 'schedule' ? (
                  <CalendarClock className="h-4 w-4" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {sendMode === 'schedule'
                  ? t('scheduleSend.scheduleButton')
                  : t('scheduleSend.sendNow')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>
    </div>
  );
}
