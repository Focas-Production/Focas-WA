import { describe, it, expect } from 'vitest'
import { buildOrderSummary, formatOrderAmount } from './order-products'

describe('formatOrderAmount', () => {
  it('formats a valid ISO code with 2 decimals', () => {
    expect(formatOrderAmount(1, 'INR')).toBe('₹1.00')
    expect(formatOrderAmount(1.5, 'USD')).toBe('$1.50')
  })

  it('falls back to "CODE amount" on an invalid code', () => {
    expect(formatOrderAmount(2.5, 'NOPE!')).toBe('NOPE! 2.50')
  })
})

describe('buildOrderSummary', () => {
  const order = {
    catalog_id: 'cat1',
    product_items: [
      { product_retailer_id: 'sku1', quantity: 2, item_price: 1.5, currency: 'INR' },
      { product_retailer_id: 'sku2', quantity: 1, item_price: 10, currency: 'INR' },
    ],
  }

  it('renders retailer ids when no names are known', () => {
    const text = buildOrderSummary(order, new Map())
    expect(text).toBe(
      '🛒 Order — 3 items · ₹13.00\n• 2 × sku1 — ₹1.50\n• 1 × sku2 — ₹10.00'
    )
  })

  it('substitutes known product names and keeps ids for the rest', () => {
    const text = buildOrderSummary(order, new Map([['sku1', 'MCQ Pack']]))
    expect(text).toContain('• 2 × MCQ Pack — ₹1.50')
    expect(text).toContain('• 1 × sku2 — ₹10.00')
  })

  it('singular item count and customer note', () => {
    const text = buildOrderSummary(
      {
        product_items: [
          { product_retailer_id: 'sku1', quantity: 1, item_price: 1, currency: 'INR' },
        ],
        text: 'Deliver fast',
      },
      new Map()
    )
    expect(text).toContain('🛒 Order — 1 item · ₹1.00')
    expect(text).toContain('Note: Deliver fast')
  })

  it('survives an empty / malformed order', () => {
    expect(buildOrderSummary({}, new Map())).toBe('🛒 Order — 0 items')
    expect(
      buildOrderSummary({ product_items: [{}] }, new Map())
    ).toBe('🛒 Order — 1 item\n• 1 × item')
  })
})
