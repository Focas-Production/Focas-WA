import { describe, it, expect } from 'vitest';

import {
  extractOrderPhone,
  extractCustomerName,
  extractOrderVariables,
  fillTemplateParams,
  type ShopifyOrderPayload,
} from './order-variables';

const order: ShopifyOrderPayload = {
  id: 5678,
  name: '#1001',
  total_price: '1499.00',
  currency: 'INR',
  financial_status: 'paid',
  customer: {
    phone: null,
    first_name: 'Priya',
    last_name: 'Sharma',
    default_address: { phone: '+91 98765 43210' },
  },
  shipping_address: { phone: '+919876543299' },
  line_items: [
    { title: 'NEET Crash Course', quantity: 1 },
    { title: 'Mock Test Pack', quantity: 2 },
  ],
  fulfillments: [
    { tracking_number: 'AWB123', tracking_url: 'https://track.example/AWB123' },
  ],
};

describe('extractOrderPhone', () => {
  it('walks customer → default_address → shipping → billing', () => {
    expect(extractOrderPhone(order)).toBe('+91 98765 43210');
    expect(
      extractOrderPhone({ shipping_address: { phone: '+15550001111' } })
    ).toBe('+15550001111');
  });

  it('returns null when no phone anywhere', () => {
    expect(extractOrderPhone({ customer: { phone: '' } })).toBeNull();
    expect(extractOrderPhone({})).toBeNull();
  });
});

describe('extractCustomerName', () => {
  it('joins first + last from the first source that has them', () => {
    expect(extractCustomerName(order)).toBe('Priya Sharma');
    expect(
      extractCustomerName({ shipping_address: { first_name: 'Ravi' } })
    ).toBe('Ravi');
    expect(extractCustomerName({})).toBe('');
  });
});

describe('extractOrderVariables', () => {
  const vars = extractOrderVariables(order, 'focas.myshopify.com');

  it('maps the order onto the flat variable set', () => {
    expect(vars.customer_name).toBe('Priya Sharma');
    expect(vars.first_name).toBe('Priya');
    expect(vars.order_number).toBe('#1001');
    expect(vars.order_id).toBe('5678');
    expect(vars.total_with_currency).toBe('1499.00 INR');
    expect(vars.item_count).toBe('3');
    expect(vars.first_item).toBe('NEET Crash Course');
    expect(vars.tracking_number).toBe('AWB123');
    expect(vars.shop).toBe('focas.myshopify.com');
  });

  it('derives order_number from order_number when name is absent', () => {
    expect(
      extractOrderVariables({ order_number: 1002 }, 's.myshopify.com')
        .order_number
    ).toBe('#1002');
  });
});

describe('fillTemplateParams', () => {
  it('substitutes placeholders and passes literals through', () => {
    expect(
      fillTemplateParams(
        ['{{customer_name}}', 'Order {{order_number}}', 'FOCAS'],
        { customer_name: 'Priya Sharma', order_number: '#1001' }
      )
    ).toEqual(['Priya Sharma', 'Order #1001', 'FOCAS']);
  });

  it("falls back to '-' for unknown/empty results (Meta rejects '')", () => {
    expect(fillTemplateParams(['{{nope}}', '  '], {})).toEqual(['-', '-']);
  });
});
