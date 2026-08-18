import { describe, it, expect } from 'vitest';

import {
  SHOPIFY_TOPICS,
  isShopifyTopic,
  normalizeEventTemplates,
  normalizeShopDomain,
} from './events';

describe('isShopifyTopic', () => {
  it('accepts every declared topic and rejects others', () => {
    for (const t of SHOPIFY_TOPICS) expect(isShopifyTopic(t)).toBe(true);
    expect(isShopifyTopic('orders/updated')).toBe(false);
    expect(isShopifyTopic(42)).toBe(false);
  });
});

describe('normalizeEventTemplates', () => {
  it('normalizes a valid map and defaults language', () => {
    const out = normalizeEventTemplates({
      'orders/create': {
        enabled: true,
        template_name: ' order_confirm ',
        params: ['{{customer_name}}'],
      },
    });
    expect(out).toEqual({
      'orders/create': {
        enabled: true,
        template_name: 'order_confirm',
        language: 'en_US',
        params: ['{{customer_name}}'],
      },
    });
  });

  it('accepts an empty map (connected, nothing mapped yet)', () => {
    expect(normalizeEventTemplates({})).toEqual({});
  });

  it('rejects unknown topics, non-objects, and enabled-without-template', () => {
    expect(normalizeEventTemplates({ 'orders/updated': {} })).toBeNull();
    expect(normalizeEventTemplates([])).toBeNull();
    expect(normalizeEventTemplates('x')).toBeNull();
    expect(
      normalizeEventTemplates({
        'orders/create': { enabled: true, template_name: '' },
      })
    ).toBeNull();
  });

  it('keeps a disabled mapping without a template (draft state)', () => {
    const out = normalizeEventTemplates({
      'orders/paid': { enabled: false, template_name: '' },
    });
    expect(out?.['orders/paid']?.enabled).toBe(false);
  });
});

describe('normalizeShopDomain', () => {
  it('lowercases and strips protocol/path', () => {
    expect(normalizeShopDomain('https://My-Store.myshopify.com/admin')).toBe(
      'my-store.myshopify.com'
    );
    expect(normalizeShopDomain('focas.myshopify.com')).toBe(
      'focas.myshopify.com'
    );
  });

  it('rejects non-myshopify domains and junk', () => {
    expect(normalizeShopDomain('focasedu.com')).toBeNull();
    expect(normalizeShopDomain('myshopify.com')).toBeNull();
    expect(normalizeShopDomain(42)).toBeNull();
  });
});
