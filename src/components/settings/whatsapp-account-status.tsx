'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Gauge, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface AccountStatus {
  connected: boolean;
  reason?: string;
  error?: string;
  display_phone_number?: string | null;
  verified_name?: string | null;
  quality_rating?: string | null;
  messaging_limit_tier?: string | null;
  messaging_limit?: number | null;
  messaging_limit_unlimited?: boolean;
  fetched_at?: string;
}

/** Meta's published tiers; `null` is unlimited. */
const STANDARD_TIERS: (number | null)[] = [250, 2000, 10000, 100000, null];

type Quality = 'high' | 'medium' | 'low' | 'unknown';

function toQuality(rating: string | null | undefined): Quality {
  switch ((rating ?? '').toUpperCase()) {
    case 'GREEN':
      return 'high';
    case 'YELLOW':
      return 'medium';
    case 'RED':
      return 'low';
    default:
      return 'unknown';
  }
}

const QUALITY_STYLES: Record<Quality, string> = {
  high: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  medium: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  low: 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30',
  unknown: 'bg-muted text-muted-foreground border-border',
};

/**
 * Messaging-limit tier and quality rating of the connected number,
 * read live from Meta via /api/whatsapp/account-status.
 */
export function WhatsAppAccountStatus() {
  const t = useTranslations('Settings.whatsappStatus');
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/account-status', { cache: 'no-store' });
      setStatus((await res.json()) as AccountStatus);
    } catch {
      setStatus({ connected: false, reason: 'meta_api_error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !status) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-10">
          <Loader2 className="size-5 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  if (!status?.connected) {
    if (status?.reason === 'not_configured') return null;
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t('messagingLimitTitle')}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('loadFailed')}
            {status?.error ? ` (${status.error})` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {t('refresh')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const current: number | null | undefined = status.messaging_limit_unlimited
    ? null
    : status.messaging_limit ?? undefined; // undefined = Meta didn't report a tier
  const tiers = [...STANDARD_TIERS];
  if (typeof current === 'number' && !tiers.includes(current)) {
    tiers.push(current);
    tiers.sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  }

  const quality = toQuality(status.quality_rating);
  const qualityLabel = t(`quality.${quality}`);
  const updated = status.fetched_at ? new Date(status.fetched_at).toLocaleString() : '';

  return (
    <div className="space-y-6">
      {/* Messaging limit */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-foreground">
                <Gauge className="size-4 text-primary" />
                {t('messagingLimitTitle')}
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('lastUpdated', { date: updated })}
                {status.display_phone_number ? ` · ${status.display_phone_number}` : ''}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {t('refresh')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {tiers.map((tier) => {
              const isCurrent = current !== undefined && tier === current;
              return (
                <div
                  key={tier ?? 'unlimited'}
                  className={cn(
                    'rounded-lg border p-4 space-y-2',
                    isCurrent
                      ? 'border-emerald-500/50 bg-emerald-500/10 border-l-4'
                      : 'border-border bg-card'
                  )}
                >
                  <span
                    className={cn(
                      'inline-block rounded px-2 py-0.5 text-[11px] font-medium',
                      isCurrent
                        ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                        : 'invisible'
                    )}
                  >
                    {t('current')}
                  </span>
                  <p className="text-2xl font-semibold text-foreground tabular-nums">
                    {tier === null ? t('unlimited') : tier.toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground leading-snug">
                    {tier === null ? t('unlimitedDesc') : t('tierDesc')}
                  </p>
                </div>
              );
            })}
          </div>
          {current === undefined && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t('tierUnknown')}</p>
          )}
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
            {t('serviceNote')}
          </p>
        </CardContent>
      </Card>

      {/* Quality rating */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <ShieldCheck className="size-4 text-primary" />
            {t('qualityTitle')}
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-xs font-medium',
                QUALITY_STYLES[quality]
              )}
            >
              {qualityLabel}
            </span>
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('lastUpdated', { date: updated })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>{t('qualityIntro')}</p>
          <ul className="list-disc space-y-1 pl-5 font-medium text-foreground">
            <li>{t('qualityTip1')}</li>
            <li>{t('qualityTip2')}</li>
            <li>{t('qualityTip3')}</li>
          </ul>
          {quality === 'low' || quality === 'medium' ? (
            <p className="text-amber-600 dark:text-amber-400">{t('qualityWarning')}</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
