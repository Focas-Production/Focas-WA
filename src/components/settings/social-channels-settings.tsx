'use client';

// ============================================================
// SocialChannelsSettings — Settings → Instagram & Messenger
//
// Connect Facebook Pages (Messenger) and their linked Instagram
// professional accounts (Instagram Direct) so their DMs land in the
// shared inbox next to WhatsApp.
//
// Two ways in:
//   - "Continue with Facebook": FB.login → POST /api/social/pages
//     lists the user's Pages → pick channels per Page →
//     POST /api/social/channels.
//   - Manual: paste a Page access token (e.g. from a System User).
//
// Any member can view; only admin+ can connect/disconnect (enforced
// here via canEditSettings and on the server by requireRole + RLS).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { ChannelBadge, ChannelGlyph, CHANNEL_LABEL } from '@/components/inbox/channel-icon';
import { useAuth } from '@/hooks/use-auth';
import type { SocialChannel } from '@/types';
import { SettingsPanelHead } from './settings-panel-head';

interface PageOption {
  id: string;
  name: string;
  picture_url: string | null;
  instagram: { id: string; username: string | null; name: string | null } | null;
  connected: { messenger: boolean; instagram: boolean };
}

type Selection = Record<string, { messenger: boolean; instagram: boolean }>;

// Minimal typings for the Facebook JS SDK surface this panel uses.
interface FbAuthResponse {
  authResponse?: { accessToken?: string } | null;
}
interface FbSdk {
  init(opts: { appId: string; xfbml: boolean; version: string }): void;
  login(callback: (response: FbAuthResponse) => void, opts: Record<string, unknown>): void;
}
type FbWindow = Window & { FB?: FbSdk; fbAsyncInit?: () => void };

/** Permissions for Messenger + Instagram messaging via a Page. */
const LOGIN_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_manage_messages',
  'business_management',
].join(',');

export function SocialChannelsSettings() {
  const t = useTranslations('Settings.social');
  const { canEditSettings } = useAuth();

  const [loading, setLoading] = useState(true);
  const [channels, setChannels] = useState<SocialChannel[]>([]);
  const [loggingIn, setLoggingIn] = useState(false);
  const [session, setSession] = useState<string | null>(null);
  const [pages, setPages] = useState<PageOption[]>([]);
  const [selection, setSelection] = useState<Selection>({});
  const [connectingPageId, setConnectingPageId] = useState<string | null>(null);
  const [manualPageId, setManualPageId] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [manualSaving, setManualSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const loginConfigId = process.env.NEXT_PUBLIC_META_SOCIAL_CONFIG_ID;
  const webhookUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/social/webhook` : '';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/social/channels', { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      setChannels((payload.channels as SocialChannel[]) ?? []);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function loadFbSdk(): Promise<FbSdk> {
    return new Promise((resolve, reject) => {
      const w = window as FbWindow;
      if (w.FB) return resolve(w.FB);
      w.fbAsyncInit = () => {
        w.FB!.init({ appId: appId!, xfbml: false, version: 'v21.0' });
        resolve(w.FB!);
      };
      const script = document.createElement('script');
      script.src = 'https://connect.facebook.net/en_US/sdk.js';
      script.async = true;
      script.defer = true;
      script.onerror = () => reject(new Error('Failed to load the Facebook SDK'));
      document.body.appendChild(script);
    });
  }

  async function handleFacebookLogin() {
    if (!appId) {
      toast.error(t('appIdMissing'));
      return;
    }
    // Facebook Login refuses non-HTTPS pages ("isn't using a secure
    // connection"), so explain instead of opening a popup that fails.
    if (window.location.protocol !== 'https:') {
      toast.error(t('httpsRequired'), { duration: 10000 });
      return;
    }
    setLoggingIn(true);
    try {
      const FB = await loadFbSdk();
      // A Facebook Login for Business configuration (if set) carries
      // the permission set; otherwise request the scopes directly.
      const opts = loginConfigId
        ? { config_id: loginConfigId }
        : { scope: LOGIN_SCOPES, return_scopes: true };
      FB.login((response) => {
        const token = response?.authResponse?.accessToken;
        if (!token) {
          setLoggingIn(false);
          toast.error(t('loginCancelled'));
          return;
        }
        void (async () => {
          try {
            const res = await fetch('/api/social/pages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_access_token: token }),
            });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(payload.error || t('pagesFailed'));
            const list = (payload.pages as PageOption[]) ?? [];
            setSession(payload.session as string);
            setPages(list);
            setSelection(
              Object.fromEntries(
                list.map((p) => [
                  p.id,
                  { messenger: !p.connected.messenger, instagram: !!p.instagram && !p.connected.instagram },
                ]),
              ),
            );
            if (list.length === 0) toast.warning(t('noPages'));
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t('pagesFailed'));
          } finally {
            setLoggingIn(false);
          }
        })();
      }, opts);
    } catch (err) {
      setLoggingIn(false);
      toast.error(err instanceof Error ? err.message : t('pagesFailed'));
    }
  }

  async function postConnect(body: Record<string, unknown>): Promise<boolean> {
    const res = await fetch('/api/social/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload.error || t('connectFailed'));
      return false;
    }
    const saved = (payload.channels as SocialChannel[]) ?? [];
    toast.success(
      t('connectSuccess', {
        names: saved
          .map((c) => (c.channel === 'instagram' && c.username ? `@${c.username}` : c.name || CHANNEL_LABEL[c.channel]))
          .join(', '),
      }),
    );
    await load();
    return true;
  }

  async function connectPage(page: PageOption) {
    const sel = selection[page.id];
    const wanted = (['messenger', 'instagram'] as const).filter((c) => sel?.[c]);
    if (wanted.length === 0) {
      toast.error(t('pickChannel'));
      return;
    }
    setConnectingPageId(page.id);
    try {
      const ok = await postConnect({ session, page_id: page.id, channels: wanted });
      if (ok) {
        setPages((prev) =>
          prev.map((p) =>
            p.id === page.id
              ? {
                  ...p,
                  connected: {
                    messenger: p.connected.messenger || wanted.includes('messenger'),
                    instagram: p.connected.instagram || wanted.includes('instagram'),
                  },
                }
              : p,
          ),
        );
        setSelection((prev) => ({ ...prev, [page.id]: { messenger: false, instagram: false } }));
      }
    } finally {
      setConnectingPageId(null);
    }
  }

  async function handleManualConnect() {
    if (!manualToken.trim()) {
      toast.error(t('manualTokenRequired'));
      return;
    }
    setManualSaving(true);
    try {
      const ok = await postConnect({
        page_access_token: manualToken.trim(),
        page_id: manualPageId.trim() || undefined,
      });
      if (ok) {
        setManualToken('');
        setManualPageId('');
      }
    } finally {
      setManualSaving(false);
    }
  }

  async function disconnect(channel: SocialChannel) {
    const label =
      channel.channel === 'instagram' && channel.username ? `@${channel.username}` : channel.name;
    if (!confirm(t('disconnectConfirm', { name: label || CHANNEL_LABEL[channel.channel] }))) return;
    setRemovingId(channel.id);
    try {
      const res = await fetch(`/api/social/channels?id=${encodeURIComponent(channel.id)}`, {
        method: 'DELETE',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('disconnectFailed'));
        return;
      }
      toast.success(t('disconnected'));
      setChannels((prev) => prev.filter((c) => c.id !== channel.id));
    } finally {
      setRemovingId(null);
    }
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast.success(t('copySuccess'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
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
          channels.length > 0 ? (
            <Badge className="border-emerald-500/30 bg-emerald-500/10 text-[10px] tracking-wide text-emerald-400 uppercase">
              {t('connectedCount', { count: channels.length })}
            </Badge>
          ) : undefined
        }
      />

      {/* Connected channels */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <h3 className="text-foreground text-sm font-semibold">{t('connectedTitle')}</h3>
          {channels.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noneConnected')}</p>
          ) : (
            <ul className="divide-border divide-y">
              {channels.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-2.5">
                  <div className="relative shrink-0">
                    {c.picture_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.picture_url} alt="" className="size-9 rounded-full object-cover" />
                    ) : (
                      <div className="bg-muted text-foreground flex size-9 items-center justify-center rounded-full">
                        <ChannelGlyph channel={c.channel} className="size-4" />
                      </div>
                    )}
                    <ChannelBadge channel={c.channel} className="absolute -right-1 -bottom-1" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground truncate text-sm font-medium">
                      {c.channel === 'instagram' && c.username ? `@${c.username}` : c.name}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {CHANNEL_LABEL[c.channel]}
                      {c.channel === 'instagram' && c.name ? ` · ${c.name}` : ''}
                      {c.status !== 'connected' ? ` · ${t('statusDisconnected')}` : ''}
                    </p>
                  </div>
                  {canEditSettings && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={removingId === c.id}
                      onClick={() => void disconnect(c)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      {removingId === c.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                      {t('disconnect')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Connect */}
      {canEditSettings && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <div>
              <h3 className="text-foreground text-sm font-semibold">{t('connectTitle')}</h3>
              <p className="text-muted-foreground mt-0.5 text-xs">{t('connectDesc')}</p>
            </div>

            <Button
              type="button"
              onClick={() => void handleFacebookLogin()}
              disabled={loggingIn || !appId}
              className="bg-[#0866FF] text-white hover:bg-[#0866FF]/90"
            >
              {loggingIn ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ChannelGlyph channel="messenger" className="size-4" />
              )}
              {t('continueWithFacebook')}
            </Button>
            {!appId && <p className="text-xs text-amber-400">{t('appIdMissing')}</p>}

            {pages.length > 0 && (
              <ul className="border-border divide-border divide-y rounded-md border">
                {pages.map((page) => {
                  const sel = selection[page.id] ?? { messenger: false, instagram: false };
                  const nothingLeft =
                    page.connected.messenger && (!page.instagram || page.connected.instagram);
                  return (
                    <li key={page.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        {page.picture_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={page.picture_url} alt="" className="size-8 rounded-full object-cover" />
                        ) : (
                          <div className="bg-muted size-8 rounded-full" />
                        )}
                        <div className="min-w-0">
                          <p className="text-foreground truncate text-sm font-medium">{page.name}</p>
                          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                            <label className="flex items-center gap-1.5 text-xs">
                              <Checkbox
                                checked={page.connected.messenger || sel.messenger}
                                disabled={page.connected.messenger}
                                onCheckedChange={(v) =>
                                  setSelection((prev) => ({
                                    ...prev,
                                    [page.id]: { ...sel, messenger: v === true },
                                  }))
                                }
                              />
                              <span className="text-foreground">Messenger</span>
                              {page.connected.messenger && (
                                <span className="text-emerald-400">{t('alreadyConnected')}</span>
                              )}
                            </label>
                            {page.instagram ? (
                              <label className="flex items-center gap-1.5 text-xs">
                                <Checkbox
                                  checked={page.connected.instagram || sel.instagram}
                                  disabled={page.connected.instagram}
                                  onCheckedChange={(v) =>
                                    setSelection((prev) => ({
                                      ...prev,
                                      [page.id]: { ...sel, instagram: v === true },
                                    }))
                                  }
                                />
                                <span className="text-foreground">
                                  Instagram{page.instagram.username ? ` @${page.instagram.username}` : ''}
                                </span>
                                {page.connected.instagram && (
                                  <span className="text-emerald-400">{t('alreadyConnected')}</span>
                                )}
                              </label>
                            ) : (
                              <span className="text-muted-foreground text-xs">{t('noInstagramLinked')}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={nothingLeft || connectingPageId === page.id}
                        onClick={() => void connectPage(page)}
                      >
                        {connectingPageId === page.id && <Loader2 className="size-4 animate-spin" />}
                        {t('connect')}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}

            <Accordion>
              <AccordionItem value="manual">
                <AccordionTrigger className="text-sm">{t('manualTitle')}</AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-3 pt-1">
                    <p className="text-muted-foreground text-xs">{t('manualDesc')}</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="social-page-id" className="text-muted-foreground">
                          {t('pageIdLabel')}
                        </Label>
                        <Input
                          id="social-page-id"
                          value={manualPageId}
                          placeholder="1234567890"
                          onChange={(e) => setManualPageId(e.target.value)}
                          className="font-mono text-xs"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="social-page-token" className="text-muted-foreground">
                          {t('pageTokenLabel')}
                        </Label>
                        <Input
                          id="social-page-token"
                          type="password"
                          value={manualToken}
                          placeholder="EAAG…"
                          onChange={(e) => setManualToken(e.target.value)}
                          className="font-mono text-xs"
                        />
                      </div>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => void handleManualConnect()}
                      disabled={manualSaving}
                    >
                      {manualSaving && <Loader2 className="size-4 animate-spin" />}
                      {t('manualConnect')}
                    </Button>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>
      )}

      {/* Webhook setup */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div>
            <h3 className="text-foreground text-sm font-semibold">{t('webhookTitle')}</h3>
            <p className="text-muted-foreground mt-0.5 text-xs">{t('webhookDesc')}</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-muted-foreground">{t('webhookUrlLabel')}</Label>
            <div className="flex gap-2">
              <Input
                readOnly
                value={webhookUrl}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button type="button" variant="outline" onClick={() => void copyUrl()}>
                <Copy className="size-4" />
                {t('copy')}
              </Button>
            </div>
          </div>
          <ol className="text-muted-foreground list-decimal space-y-1 pl-4 text-xs">
            <li>{t('setupStep1')}</li>
            <li>{t('setupStep2')}</li>
            <li>{t('setupStep3')}</li>
            <li>{t('setupStep4')}</li>
          </ol>
          <p className="text-muted-foreground text-xs">{t('windowNote')}</p>
        </CardContent>
      </Card>
    </section>
  );
}
