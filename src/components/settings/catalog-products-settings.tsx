'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Package, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { formatOrderAmount } from '@/lib/whatsapp/order-products';
import { SettingsPanelHead } from './settings-panel-head';

/**
 * Settings → Catalog products — the local retailer_id → name map for
 * WhatsApp cart orders.
 *
 * Order webhooks carry only opaque retailer ids (and the catalog API
 * is unavailable for coexistence numbers), so rows are auto-captured
 * here the first time a product appears in an order; an admin fills in
 * the name once and every later order renders full product details in
 * the inbox and in the order.received webhook. Products can also be
 * pre-seeded manually when the retailer id is known.
 */
interface ProductRow {
  id: string;
  retailer_id: string;
  name: string | null;
  price: number | null;
  currency: string | null;
  catalog_id: string | null;
  image_url: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function CatalogProductsSettings() {
  const { canEditSettings } = useAuth();
  const t = useTranslations('Settings.catalogProducts');

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Per-row name drafts; a row is "dirty" when its draft differs from
  // the stored name.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const [newRetailerId, setNewRetailerId] = useState('');
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/products');
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      setProducts(payload.products ?? []);
      setDrafts({});
    } catch {
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(row: ProductRow) {
    const draft = (drafts[row.id] ?? row.name ?? '').trim();
    if (draft === (row.name ?? '')) return;
    setSavingId(row.id);
    try {
      const res = await fetch(`/api/account/products/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: draft || null }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      setProducts((prev) =>
        prev.map((p) => (p.id === row.id ? payload.product : p))
      );
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      toast.success(t('saveSuccess'));
    } catch {
      toast.error(t('networkError'));
    } finally {
      setSavingId(null);
    }
  }

  async function handleDelete(row: ProductRow) {
    if (!window.confirm(t('deleteConfirm'))) return;
    try {
      const res = await fetch(`/api/account/products/${row.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('deleteFailed'));
        return;
      }
      setProducts((prev) => prev.filter((p) => p.id !== row.id));
      toast.success(t('deleteSuccess'));
    } catch {
      toast.error(t('networkError'));
    }
  }

  async function handleAdd() {
    const retailerId = newRetailerId.trim();
    if (!retailerId) return;
    setAdding(true);
    try {
      const res = await fetch('/api/account/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retailer_id: retailerId, name: newName.trim() }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('addFailed'));
        return;
      }
      setProducts((prev) => [payload.product, ...prev]);
      setNewRetailerId('');
      setNewName('');
      toast.success(t('addSuccess'));
    } catch {
      toast.error(t('networkError'));
    } finally {
      setAdding(false);
    }
  }

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {canEditSettings && (
        <Card className="mb-4">
          <CardContent className="pt-6">
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">
                  {t('retailerIdLabel')}
                </Label>
                <Input
                  value={newRetailerId}
                  onChange={(e) => setNewRetailerId(e.target.value)}
                  placeholder={t('retailerIdPlaceholder')}
                  className="font-mono"
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">{t('nameLabel')}</Label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t('namePlaceholder')}
                />
              </div>
              <Button
                onClick={handleAdd}
                disabled={adding || !newRetailerId.trim()}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {adding ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
                {t('add')}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('addHint')}
            </p>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : products.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <Package className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">{t('empty')}</p>
            <p className="max-w-md text-xs text-muted-foreground">
              {t('emptyHint')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {products.map((row) => {
            const draft = drafts[row.id] ?? row.name ?? '';
            const dirty = draft.trim() !== (row.name ?? '');
            return (
              <Card key={row.id}>
                <CardContent className="flex flex-wrap items-center gap-3 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {row.retailer_id}
                      </code>
                      {row.price != null && row.currency && (
                        <span className="text-xs text-muted-foreground">
                          {formatOrderAmount(row.price, row.currency)}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {t('lastSeen', { date: fmtDate(row.last_seen_at) })}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Input
                        value={draft}
                        disabled={!canEditSettings}
                        placeholder={t('unnamedPlaceholder')}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [row.id]: e.target.value,
                          }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleSave(row);
                        }}
                        className="max-w-md"
                      />
                      {canEditSettings && dirty && (
                        <Button
                          size="sm"
                          onClick={() => handleSave(row)}
                          disabled={savingId === row.id}
                          className="bg-primary text-primary-foreground hover:bg-primary/90"
                        >
                          {savingId === row.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            t('save')
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                  {canEditSettings && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(row)}
                      aria-label={t('delete')}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {!canEditSettings && (
        <p className="mt-3 text-xs text-muted-foreground">{t('adminOnlyHint')}</p>
      )}
    </section>
  );
}
