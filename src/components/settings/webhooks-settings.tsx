'use client';

// ============================================================
// WebhooksSettings — Settings → Webhooks
//
// WATI-style outbound webhook management: register HTTPS endpoints
// that receive signed event callbacks (message received, status
// updated, conversation created) so external systems can react to
// WhatsApp activity without polling. Backed by the same
// `webhook_endpoints` table the public `/api/v1/webhooks` routes
// manage — this panel is the no-curl way in.
//
// Any member sees the roster (read-only); admin+ can add, edit,
// toggle, and delete (gated by <RequireRole min="admin"> here and
// the admin-only routes + RLS on the server).
//
// WATI-style: the signing secret is never surfaced. The server still
// generates one and signs every delivery (X-Wacrm-Signature), but
// receivers that don't verify just ignore the header — so the create
// flow ends with a toast, not a secret-reveal dialog. Integrations
// that DO want to verify can register via `POST /api/v1/webhooks`,
// which returns the secret once.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Trash2, Webhook } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { WEBHOOK_EVENTS, type WebhookEvent } from '@/lib/webhooks/events';
import { useTranslations } from 'next-intl';
import { SettingsPanelHead } from './settings-panel-head';

interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  last_delivery_at: string | null;
  failure_count: number;
  created_at: string;
}

/** i18n keys can't contain dots — `message.received` → `message_received`. */
function eventKey(event: string): string {
  return event.replace(/\./g, '_');
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function WebhooksSettings() {
  const { canEditSettings } = useAuth();
  const t = useTranslations('Settings.webhooks');

  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/webhooks', { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      const data = (await res.json()) as { webhooks: WebhookEndpoint[] };
      setEndpoints(data.webhooks);
    } catch (err) {
      console.error('[WebhooksSettings] load error:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleToggle(endpoint: WebhookEndpoint, next: boolean) {
    setBusy(endpoint.id);
    try {
      const res = await fetch(`/api/account/webhooks/${endpoint.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: next }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('updateFailed'));
        return;
      }
      setEndpoints((prev) =>
        prev.map((e) =>
          e.id === endpoint.id ? (payload.webhook as WebhookEndpoint) : e
        )
      );
      toast.success(next ? t('enabled') : t('disabled'));
    } catch (err) {
      console.error('[WebhooksSettings] toggle error:', err);
      toast.error(t('networkError'));
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(endpoint: WebhookEndpoint) {
    if (!window.confirm(t('deleteConfirm'))) return;
    setBusy(endpoint.id);
    try {
      const res = await fetch(`/api/account/webhooks/${endpoint.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('deleteFailed'));
        return;
      }
      toast.success(t('deleteSuccess'));
      setEndpoints((prev) => prev.filter((e) => e.id !== endpoint.id));
    } catch (err) {
      console.error('[WebhooksSettings] delete error:', err);
      toast.error(t('networkError'));
    } finally {
      setBusy(null);
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
          <RequireRole min="admin">
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="size-4" />
              {t('addWebhook')}
            </Button>
          </RequireRole>
        }
      />

      {endpoints.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Webhook className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">
              {t('noWebhooks')}
            </p>
            {canEditSettings ? (
              <p className="text-muted-foreground mt-1 text-xs">
                {t.rich('createOneHint', {
                  bold: (chunks: React.ReactNode) => (
                    <span className="text-foreground">{chunks}</span>
                  ),
                })}
              </p>
            ) : (
              <p className="text-muted-foreground mt-1 text-xs">
                {t('askAdminHint')}
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {endpoints.map((endpoint) => (
                <li
                  key={endpoint.id}
                  className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`truncate font-mono text-sm ${
                          endpoint.is_active
                            ? 'text-foreground'
                            : 'text-muted-foreground'
                        }`}
                      >
                        {endpoint.url}
                      </span>
                      {endpoint.is_active ? (
                        <Badge className="shrink-0 border-emerald-500/30 bg-emerald-500/10 text-[10px] tracking-wide text-emerald-400 uppercase">
                          {t('statusEnabled')}
                        </Badge>
                      ) : (
                        <Badge className="border-border bg-muted text-muted-foreground shrink-0 text-[10px] tracking-wide uppercase">
                          {t('statusDisabled')}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {endpoint.events.map((event) => (
                        <Badge
                          key={event}
                          className="border-primary-soft-2 bg-primary-soft text-primary text-[10px]"
                        >
                          {t(`eventNames.${eventKey(event)}`)}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-muted-foreground mt-1.5 text-xs">
                      {t('created', { date: fmtDate(endpoint.created_at) })}
                      {' · '}
                      {endpoint.last_delivery_at
                        ? t('lastDelivery', {
                            date: fmtDate(endpoint.last_delivery_at),
                          })
                        : t('neverDelivered')}
                    </p>
                    {endpoint.failure_count > 0 && (
                      <p className="mt-1 text-xs text-amber-400">
                        {endpoint.is_active
                          ? t('failing', { count: endpoint.failure_count })
                          : t('autoDisabled')}
                      </p>
                    )}
                  </div>

                  <RequireRole min="admin">
                    <div className="flex shrink-0 items-center gap-1.5 self-start sm:self-center">
                      <Switch
                        checked={endpoint.is_active}
                        disabled={busy === endpoint.id}
                        onCheckedChange={(checked) =>
                          handleToggle(endpoint, checked === true)
                        }
                        aria-label={t('toggleAria')}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy === endpoint.id}
                        onClick={() => {
                          setEditing(endpoint);
                          setDialogOpen(true);
                        }}
                        aria-label={t('edit')}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy === endpoint.id}
                        onClick={() => handleDelete(endpoint)}
                        aria-label={t('delete')}
                        className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                      >
                        {busy === endpoint.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </Button>
                    </div>
                  </RequireRole>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <EndpointDialog
        open={dialogOpen}
        editing={editing}
        onOpenChange={(next) => {
          setDialogOpen(next);
          if (!next) setEditing(null);
        }}
        onSaved={load}
      />
    </section>
  );
}

// ------------------------------------------------------------
// Add / Edit dialog — one form for both; edit opens pre-filled.
// ------------------------------------------------------------

function EndpointDialog({
  open,
  editing,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  editing: WebhookEndpoint | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const t = useTranslations('Settings.webhooks');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Pre-fill when opening in edit mode; blank for add.
  useEffect(() => {
    if (open) {
      setUrl(editing?.url ?? '');
      setEvents((editing?.events as WebhookEvent[] | undefined) ?? []);
    }
  }, [open, editing]);

  function reset() {
    setUrl('');
    setEvents([]);
    setSubmitting(false);
  }

  function toggleEvent(event: WebhookEvent, checked: boolean) {
    setEvents((prev) =>
      checked ? [...prev, event] : prev.filter((e) => e !== event)
    );
  }

  async function handleSave() {
    const trimmed = url.trim();
    if (!/^https:\/\//i.test(trimmed)) {
      toast.error(t('urlInvalid'));
      return;
    }
    if (events.length === 0) {
      toast.error(t('eventsRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        editing ? `/api/account/webhooks/${editing.id}` : '/api/account/webhooks',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: trimmed, events }),
        }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      toast.success(editing ? t('updateSuccess') : t('createSuccess'));
      reset();
      onOpenChange(false);
      onSaved();
    } catch (err) {
      console.error('[EndpointDialog] save error:', err);
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {editing ? t('editTitle') : t('addTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {editing ? t('editDesc') : t('addDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="webhook-url" className="text-muted-foreground">
                  {t('urlLabel')}
                </Label>
                <Input
                  id="webhook-url"
                  type="url"
                  value={url}
                  placeholder="https://example.com/hooks/wacrm"
                  onChange={(e) => setUrl(e.target.value)}
                  className="font-mono text-xs"
                />
                <p className="text-muted-foreground text-xs">{t('urlHint')}</p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('eventsLabel')}
                </Label>
                <div className="border-border space-y-2 rounded-md border p-3">
                  {WEBHOOK_EVENTS.map((event) => (
                    <label
                      key={event}
                      className="flex cursor-pointer items-start gap-2.5"
                    >
                      <Checkbox
                        checked={events.includes(event)}
                        onCheckedChange={(checked) =>
                          toggleEvent(event, checked === true)
                        }
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="text-foreground block text-sm">
                          {t(`eventNames.${eventKey(event)}`)}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {t(`eventDescriptions.${eventKey(event)}`)}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {t('cancel')}
              </Button>
              <Button onClick={handleSave} disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('saving')}
                  </>
                ) : editing ? (
                  t('saveChanges')
                ) : (
                  t('createWebhook')
                )}
              </Button>
            </DialogFooter>
        </>
      </DialogContent>
    </Dialog>
  );
}
