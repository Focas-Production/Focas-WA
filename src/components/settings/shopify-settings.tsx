'use client';

// ============================================================
// ShopifySettings — Settings → Shopify
//
// Connect a Shopify store and map its order events to WhatsApp
// template sends: order placed / paid / fulfilled / cancelled →
// pick an approved template and fill its body params from order
// variables like {{customer_name}} and {{order_number}}.
//
// Setup is the manual (no-OAuth) Shopify path: the admin creates
// webhooks in Shopify Admin → Settings → Notifications → Webhooks
// pointing at our receiver URL, and pastes the signing secret shown
// on that page here. The receiver resolves the store by its
// *.myshopify.com domain and verifies every delivery's HMAC.
//
// Any member can view; only admin+ can save/disconnect (enforced
// here via RequireRole and on the server by the admin-only routes
// + RLS).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, ShoppingBag, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import {
  SHOPIFY_TOPICS,
  type ShopifyTopic,
  type ShopifyEventTemplates,
} from '@/lib/shopify/events';
import { ORDER_VARIABLES } from '@/lib/shopify/order-variables';
import { useTranslations } from 'next-intl';
import { SettingsPanelHead } from './settings-panel-head';

interface ShopifyConfig {
  shop_domain: string;
  is_active: boolean;
  event_templates: ShopifyEventTemplates;
  has_secret: boolean;
  updated_at?: string;
}

interface TemplateOption {
  id: string;
  name: string;
  language: string | null;
  body_text: string | null;
}

/**
 * Number of distinct body variables a template needs. Counts unique
 * `{{…}}` tokens, so `{{1}} … {{1}}` needs one param, `{{1}} {{2}}`
 * needs two — matching how Meta expects positional body params.
 */
function templateParamCount(body: string | null | undefined): number {
  if (!body) return 0;
  const matches = body.match(/\{\{\s*[^}]+?\s*\}\}/g) ?? [];
  return new Set(matches.map((m) => m.replace(/\s+/g, ''))).size;
}

/** i18n keys can't contain '/' — `orders/create` → `orders_create`. */
function topicKey(topic: string): string {
  return topic.replace(/\//g, '_');
}

interface TopicFormState {
  enabled: boolean;
  templateValue: string; // "name::language" (select encoding)
  paramsText: string; // one param per line
}

const EMPTY_TOPIC: TopicFormState = {
  enabled: false,
  templateValue: '',
  paramsText: '',
};

const toValue = (name: string, lang: string) => `${name}::${lang}`;

export function ShopifySettings() {
  const { canEditSettings } = useAuth();
  const t = useTranslations('Settings.shopify');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [hasSecret, setHasSecret] = useState(false);

  const [shopDomain, setShopDomain] = useState('');
  const [secretInput, setSecretInput] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [topics, setTopics] = useState<Record<ShopifyTopic, TopicFormState>>(
    () =>
      Object.fromEntries(
        SHOPIFY_TOPICS.map((topic) => [topic, EMPTY_TOPIC])
      ) as Record<ShopifyTopic, TopicFormState>
  );
  const [templates, setTemplates] = useState<TemplateOption[]>([]);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/shopify/webhook`
      : '/api/shopify/webhook';

  const load = useCallback(async () => {
    try {
      const [configRes, templatesRes] = await Promise.all([
        fetch('/api/account/shopify', { cache: 'no-store' }),
        createClient()
          .from('message_templates')
          .select('id, name, language, body_text')
          .eq('status', 'APPROVED')
          .order('name'),
      ]);

      setTemplates((templatesRes.data as TemplateOption[] | null) ?? []);

      if (!configRes.ok) {
        const payload = await configRes.json().catch(() => ({}));
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      const { config } = (await configRes.json()) as {
        config: ShopifyConfig | null;
      };
      if (config) {
        setConnected(true);
        setHasSecret(config.has_secret);
        setShopDomain(config.shop_domain);
        setIsActive(config.is_active);
        setTopics(
          Object.fromEntries(
            SHOPIFY_TOPICS.map((topic) => {
              const m = config.event_templates?.[topic];
              return [
                topic,
                m
                  ? {
                      enabled: m.enabled,
                      templateValue: m.template_name
                        ? toValue(m.template_name, m.language || 'en_US')
                        : '',
                      paramsText: (m.params ?? []).join('\n'),
                    }
                  : EMPTY_TOPIC,
              ];
            })
          ) as Record<ShopifyTopic, TopicFormState>
        );
      }
    } catch (err) {
      console.error('[ShopifySettings] load error:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function patchTopic(topic: ShopifyTopic, patch: Partial<TopicFormState>) {
    setTopics((prev) => ({ ...prev, [topic]: { ...prev[topic], ...patch } }));
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast.success(t('copySuccess'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  async function handleSave() {
    const domain = shopDomain.trim().toLowerCase();
    if (!domain.endsWith('.myshopify.com')) {
      toast.error(t('domainInvalid'));
      return;
    }
    if (!connected && !secretInput.trim()) {
      toast.error(t('secretRequired'));
      return;
    }

    const event_templates: ShopifyEventTemplates = {};
    for (const topic of SHOPIFY_TOPICS) {
      const s = topics[topic];
      if (!s.templateValue && !s.enabled) continue;
      if (s.enabled && !s.templateValue) {
        toast.error(t('templateRequired', { event: t(`topics.${topicKey(topic)}`) }));
        return;
      }
      const [name, lang] = s.templateValue.split('::');
      event_templates[topic] = {
        enabled: s.enabled,
        template_name: name ?? '',
        language: lang || 'en_US',
        params: s.paramsText
          .split('\n')
          .map((p) => p.trim())
          .filter(Boolean),
      };
    }

    setSaving(true);
    try {
      const res = await fetch('/api/account/shopify', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop_domain: domain,
          ...(secretInput.trim() ? { webhook_secret: secretInput.trim() } : {}),
          is_active: isActive,
          event_templates,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      setConnected(true);
      setHasSecret(true);
      setSecretInput('');
      toast.success(t('saveSuccess'));
    } catch (err) {
      console.error('[ShopifySettings] save error:', err);
      toast.error(t('networkError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm(t('disconnectConfirm'))) return;
    setDisconnecting(true);
    try {
      const res = await fetch('/api/account/shopify', { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('disconnectFailed'));
        return;
      }
      setConnected(false);
      setHasSecret(false);
      setShopDomain('');
      setSecretInput('');
      setIsActive(true);
      setTopics(
        Object.fromEntries(
          SHOPIFY_TOPICS.map((topic) => [topic, EMPTY_TOPIC])
        ) as Record<ShopifyTopic, TopicFormState>
      );
      toast.success(t('disconnectSuccess'));
    } catch (err) {
      console.error('[ShopifySettings] disconnect error:', err);
      toast.error(t('networkError'));
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          connected ? (
            <Badge className="border-emerald-500/30 bg-emerald-500/10 text-[10px] tracking-wide text-emerald-400 uppercase">
              {t('connectedBadge')}
            </Badge>
          ) : undefined
        }
      />

      {/* Connection */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center gap-2">
            <ShoppingBag className="text-primary size-4" />
            <h3 className="text-foreground text-sm font-semibold">
              {t('connectionTitle')}
            </h3>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="shopify-domain" className="text-muted-foreground">
                {t('domainLabel')}
              </Label>
              <Input
                id="shopify-domain"
                value={shopDomain}
                disabled={!canEditSettings}
                placeholder="mystore.myshopify.com"
                onChange={(e) => setShopDomain(e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-muted-foreground text-xs">{t('domainHint')}</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="shopify-secret" className="text-muted-foreground">
                {t('secretInputLabel')}
              </Label>
              <Input
                id="shopify-secret"
                type="password"
                value={secretInput}
                disabled={!canEditSettings}
                placeholder={hasSecret ? t('secretSavedPlaceholder') : 'shpss_…'}
                onChange={(e) => setSecretInput(e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-muted-foreground text-xs">{t('secretHint')}</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-muted-foreground">{t('urlLabel')}</Label>
            <div className="flex gap-2">
              <Input
                readOnly
                value={webhookUrl}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button type="button" variant="outline" onClick={copyUrl}>
                <Copy className="size-4" />
                {t('copy')}
              </Button>
            </div>
          </div>

          <div className="border-border rounded-md border p-3">
            <p className="text-foreground text-xs font-medium">
              {t('setupTitle')}
            </p>
            <ol className="text-muted-foreground mt-1.5 list-decimal space-y-1 pl-4 text-xs">
              <li>{t('setupStep1')}</li>
              <li>{t('setupStep2')}</li>
              <li>{t('setupStep3')}</li>
              <li>{t('setupStep4')}</li>
            </ol>
          </div>

          <label className="flex cursor-pointer items-center gap-2.5">
            <Switch
              checked={isActive}
              disabled={!canEditSettings}
              onCheckedChange={(checked) => setIsActive(checked === true)}
            />
            <span className="text-foreground text-sm">{t('activeLabel')}</span>
          </label>
        </CardContent>
      </Card>

      {/* Event → template mappings */}
      <Card>
        <CardContent className="space-y-5 p-4">
          <div>
            <h3 className="text-foreground text-sm font-semibold">
              {t('eventsTitle')}
            </h3>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t('eventsDesc')}
            </p>
          </div>

          {templates.length === 0 && (
            <p className="text-xs text-amber-400">{t('noTemplates')}</p>
          )}

          {SHOPIFY_TOPICS.map((topic) => {
            const s = topics[topic];
            return (
              <div key={topic} className="border-border rounded-md border p-3">
                <label className="flex cursor-pointer items-start gap-2.5">
                  <Checkbox
                    checked={s.enabled}
                    disabled={!canEditSettings}
                    onCheckedChange={(checked) =>
                      patchTopic(topic, { enabled: checked === true })
                    }
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="text-foreground block text-sm font-medium">
                      {t(`topics.${topicKey(topic)}`)}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {t(`topicDescriptions.${topicKey(topic)}`)}
                    </span>
                  </span>
                </label>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                      {t('templateLabel')}
                    </Label>
                    <select
                      value={s.templateValue}
                      disabled={!canEditSettings}
                      onChange={(e) =>
                        patchTopic(topic, { templateValue: e.target.value })
                      }
                      className="border-border bg-muted text-foreground w-full rounded-md border px-2 py-1.5 text-xs"
                    >
                      <option value="">{t('templateSelect')}</option>
                      {templates.map((tmpl) => {
                        const lang = tmpl.language ?? 'en_US';
                        return (
                          <option key={tmpl.id} value={toValue(tmpl.name, lang)}>
                            {tmpl.name} ({lang})
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                      {t('paramsLabel')}
                    </Label>
                    <Textarea
                      value={s.paramsText}
                      disabled={!canEditSettings}
                      rows={2}
                      placeholder={'{{customer_name}}\n{{order_number}}'}
                      onChange={(e) =>
                        patchTopic(topic, { paramsText: e.target.value })
                      }
                      className="font-mono text-xs"
                    />
                  </div>
                </div>
              </div>
            );
          })}

          <p className="text-muted-foreground text-xs">
            {t('variablesHint')}{' '}
            <span className="font-mono text-[11px]">
              {ORDER_VARIABLES.map((v) => `{{${v}}}`).join(' ')}
            </span>
          </p>
        </CardContent>
      </Card>

      <RequireRole min="admin">
        <div className="flex items-center justify-between gap-3">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : connected ? (
              t('saveChanges')
            ) : (
              t('connect')
            )}
          </Button>

          {connected && (
            <Button
              variant="outline"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
            >
              {disconnecting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              {t('disconnect')}
            </Button>
          )}
        </div>
      </RequireRole>
    </section>
  );
}
