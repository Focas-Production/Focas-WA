// ============================================================
// POST /api/shopify/webhook — Shopify → WhatsApp bridge.
//
// One global endpoint for every connected store. Each delivery is
// resolved to its tenant via the `X-Shopify-Shop-Domain` header
// (Shopify always sends the permanent *.myshopify.com domain), then
// authenticated by verifying `X-Shopify-Hmac-Sha256` over the raw
// body with that store's signing secret.
//
// On a mapped, enabled topic: extract the customer's phone from the
// order, find-or-create the contact + conversation (the same helper
// the public API uses, so `contact.created` webhooks fire), fill the
// configured template params from order variables, and send through
// the shared send core (which handles wallet charging and fires
// `template.message.sent` / `template.message.failed`).
//
// Response codes: Shopify retries non-2xx for ~48h and then deletes
// the webhook subscription. So: bad signature / unknown store → 401
// (misconfig should surface loudly), but every *business* failure
// after auth (no phone on the order, template missing, wallet empty)
// → 200 with a server-side log, because a retry can never fix those
// and losing the subscription would silently kill the integration.
// ============================================================

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { verifyShopifyHmac } from '@/lib/shopify/verify';
import {
  isShopifyTopic,
  type ShopifyEventTemplates,
} from '@/lib/shopify/events';
import {
  extractOrderPhone,
  extractCustomerName,
  extractOrderVariables,
  fillTemplateParams,
  type ShopifyOrderPayload,
} from '@/lib/shopify/order-variables';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message';

export async function POST(request: Request) {
  const rawBody = await request.text();
  const topic = request.headers.get('x-shopify-topic');
  const shopDomain = request.headers
    .get('x-shopify-shop-domain')
    ?.toLowerCase();
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256');

  if (!shopDomain) {
    return NextResponse.json({ error: 'Missing shop domain' }, { status: 401 });
  }

  const db = supabaseAdmin();
  const { data: config, error: cfgErr } = await db
    .from('shopify_config')
    .select('*')
    .eq('shop_domain', shopDomain)
    .maybeSingle();

  if (cfgErr) {
    console.error('[shopify/webhook] config lookup error:', cfgErr);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
  if (!config) {
    return NextResponse.json({ error: 'Unknown store' }, { status: 401 });
  }

  let secret: string;
  try {
    secret = decrypt(config.webhook_secret);
  } catch (err) {
    console.error('[shopify/webhook] secret decrypt failed:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  if (!verifyShopifyHmac(rawBody, hmacHeader, secret)) {
    console.warn(`[shopify/webhook] bad signature from ${shopDomain}`);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // ---- Authenticated. Everything below acks 200. -------------

  if (!config.is_active) {
    console.log(`[shopify/webhook] ${shopDomain} ${topic}: integration inactive — skipping`);
    return NextResponse.json({ ok: true, skipped: 'inactive' });
  }
  if (!isShopifyTopic(topic ?? '')) {
    console.log(`[shopify/webhook] ${shopDomain}: unhandled topic "${topic}" — skipping`);
    return NextResponse.json({ ok: true, skipped: 'unhandled topic' });
  }

  const mapping = (config.event_templates as ShopifyEventTemplates | null)?.[
    topic as keyof ShopifyEventTemplates
  ];
  if (!mapping?.enabled || !mapping.template_name) {
    console.log(
      `[shopify/webhook] ${shopDomain} ${topic}: no enabled template mapping — skipping`
    );
    return NextResponse.json({ ok: true, skipped: 'topic not mapped' });
  }

  let order: ShopifyOrderPayload;
  try {
    order = JSON.parse(rawBody) as ShopifyOrderPayload;
  } catch {
    console.warn(`[shopify/webhook] unparseable body from ${shopDomain}`);
    return NextResponse.json({ ok: true, skipped: 'bad payload' });
  }

  const phone = extractOrderPhone(order);
  if (!phone) {
    console.log(
      `[shopify/webhook] ${shopDomain} ${topic} order ${order.name ?? order.id}: no customer phone — skipping`
    );
    return NextResponse.json({ ok: true, skipped: 'no phone' });
  }

  try {
    const resolved = await resolveConversationByPhone(
      db,
      config.account_id,
      phone,
      extractCustomerName(order) || null
    );

    const vars = extractOrderVariables(order, shopDomain);
    const result = await sendMessageToConversation(db, config.account_id, {
      conversationId: resolved.conversationId,
      messageType: 'template',
      templateName: mapping.template_name,
      templateLanguage: mapping.language || 'en_US',
      templateParams: fillTemplateParams(mapping.params, vars),
    });

    console.log(
      `[shopify/webhook] ${shopDomain} ${topic} → "${mapping.template_name}" to ${phone} (${result.whatsappMessageId})`
    );
    return NextResponse.json({ ok: true, message_id: result.messageId });
  } catch (err) {
    // Business failures (invalid phone, wallet empty, Meta reject…)
    // are logged, not retried — see the header comment.
    const detail =
      err instanceof SendMessageError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(
      `[shopify/webhook] ${shopDomain} ${topic} send failed — ${detail}`
    );
    return NextResponse.json({ ok: false, error: 'send failed' });
  }
}
