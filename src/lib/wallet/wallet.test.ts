import { describe, it, expect, beforeEach, vi } from 'vitest'

// Table-backed stand-in for the service-role client: enough of the
// query builder for the settle path, plus a recorder for wallet RPCs.
const h = vi.hoisted(() => {
  type Row = Record<string, unknown>
  const tables: Record<string, Row[]> = {}
  const rpcCalls: { fn: string; args: Row }[] = []

  function builder(table: string) {
    const filters: ((r: Row) => boolean)[] = []
    let countHead = false
    const matched = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
    const b = {
      select: (_cols?: string, opts?: { head?: boolean }) => ((countHead = !!opts?.head), b),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      is: (k: string, v: null) => (filters.push((r) => (r[k] ?? null) === v), b),
      limit: () => b,
      maybeSingle: () => Promise.resolve({ data: matched()[0] ?? null, error: null }),
      then: (onF: (v: unknown) => unknown) =>
        Promise.resolve(
          countHead ? { count: matched().length, data: null, error: null } : { data: matched(), error: null },
        ).then(onF),
    }
    return b
  }

  return {
    tables,
    rpcCalls,
    db: {
      from: (t: string) => builder(t),
      rpc: async (fn: string, args: Row) => {
        rpcCalls.push({ fn, args })
        return { data: null, error: null }
      },
    },
  }
})

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => h.db }))

import { settleBroadcastCharge, refundBroadcastMessage, chargeTemplateSend } from './wallet'

const MARKETING_PAISE = 78.46

function seed({ debitPaise, failedUnsent }: { debitPaise: number | null; failedUnsent: number }) {
  for (const k of Object.keys(h.tables)) delete h.tables[k]
  h.rpcCalls.length = 0
  h.tables.broadcasts = [
    { id: 'b1', account_id: 'acc1', name: 'Promo', template_name: 'promo', template_language: 'en_US' },
  ]
  h.tables.message_templates = []
  h.tables.wallet_transactions =
    debitPaise === null
      ? []
      : [{ account_id: 'acc1', type: 'debit', reference_id: 'broadcast:b1', amount_paise: String(debitPaise) }]
  h.tables.broadcast_recipients = Array.from({ length: failedUnsent }, (_, i) => ({
    id: `r${i}`,
    broadcast_id: 'b1',
    status: 'failed',
    whatsapp_message_id: null,
  }))
}

const refunds = () => h.rpcCalls.filter((c) => c.fn === 'wallet_credit')

beforeEach(() => seed({ debitPaise: null, failedUnsent: 0 }))

describe('settleBroadcastCharge', () => {
  it('refunds never-sent recipients of a paid campaign in one row', async () => {
    seed({ debitPaise: MARKETING_PAISE * 10, failedUnsent: 3 })

    expect(await settleBroadcastCharge('acc1', 'b1')).toBe(true)

    expect(refunds()).toHaveLength(1)
    expect(refunds()[0].args).toMatchObject({
      p_account_id: 'acc1',
      p_amount_paise: 235.38,
      p_reference_id: 'broadcast:b1',
      p_type: 'refund',
      // attribution is inherited from the campaign debit in SQL; only
      // the message count is passed
      p_quantity: 3,
    })
  })

  it('refunds nothing for a campaign that was never charged', async () => {
    // e.g. a broadcasts row an agent inserted by hand, then stopped.
    seed({ debitPaise: null, failedUnsent: 500 })

    expect(await settleBroadcastCharge('acc1', 'b1')).toBe(true)

    expect(refunds()).toHaveLength(0)
  })

  it('never refunds more than the campaign was charged', async () => {
    // Paid for 2 recipients; 500 failed rows were added afterwards.
    seed({ debitPaise: MARKETING_PAISE * 2, failedUnsent: 500 })

    await settleBroadcastCharge('acc1', 'b1')

    expect(refunds()[0].args.p_amount_paise).toBe(156.92)
  })
})

describe('refundBroadcastMessage', () => {
  it('refunds a failed delivery of a paid campaign', async () => {
    seed({ debitPaise: MARKETING_PAISE * 10, failedUnsent: 0 })

    await refundBroadcastMessage('b1', 'wamid.1')

    expect(refunds()).toHaveLength(1)
    expect(refunds()[0].args).toMatchObject({ p_amount_paise: MARKETING_PAISE, p_reference_id: 'wamid.1' })
  })

  it('attributes the refund to its campaign (the wamid has no debit to inherit from)', async () => {
    seed({ debitPaise: MARKETING_PAISE * 10, failedUnsent: 0 })

    await refundBroadcastMessage('b1', 'wamid.1')

    expect(refunds()[0].args).toMatchObject({
      p_source: 'broadcast',
      p_source_ref: 'b1',
      p_template_name: 'promo',
      p_template_category: 'marketing',
      p_quantity: 1,
    })
  })

  it('refunds nothing when the campaign was never charged', async () => {
    seed({ debitPaise: null, failedUnsent: 0 })

    await refundBroadcastMessage('b1', 'wamid.1')

    expect(refunds()).toHaveLength(0)
  })
})

describe('chargeTemplateSend', () => {
  it('records source, campaign ref, template and quantity on the debit', async () => {
    await chargeTemplateSend({
      accountId: 'acc1',
      reference: 'broadcast:b1',
      category: 'marketing',
      pricePaise: MARKETING_PAISE,
      quantity: 10,
      description: 'Broadcast',
      source: 'broadcast',
      sourceRef: 'b1',
      templateName: 'promo',
    })

    const charge = h.rpcCalls.find((c) => c.fn === 'wallet_charge')
    expect(charge?.args).toMatchObject({
      p_amount_paise: 784.6,
      p_source: 'broadcast',
      p_source_ref: 'b1',
      p_template_name: 'promo',
      p_quantity: 10,
    })
  })

  it('defaults a single send to quantity 1 with no campaign ref', async () => {
    await chargeTemplateSend({
      accountId: 'acc1',
      reference: 'prep:1',
      category: 'utility',
      pricePaise: 11.5,
      description: 'Template',
      source: 'inbox',
      templateName: 'hello',
    })

    const charge = h.rpcCalls.find((c) => c.fn === 'wallet_charge')
    expect(charge?.args).toMatchObject({ p_source: 'inbox', p_source_ref: null, p_quantity: 1 })
  })
})
