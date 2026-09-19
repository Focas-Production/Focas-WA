import { describe, it, expect, beforeEach, vi } from 'vitest'

// ------------------------------------------------------------
// In-memory stand-in for the service-role Supabase client. Unlike a
// canned-response mock it really applies filters, so the engine's
// conditional updates (campaign claim, per-recipient claim, "only if
// still sending") behave as they would against Postgres.
// ------------------------------------------------------------
const h = vi.hoisted(() => {
  type Row = Record<string, unknown>
  const tables: Record<string, Row[]> = {}

  function cmp(a: unknown, b: unknown): number {
    const ta = typeof a === 'string' ? Date.parse(a) : NaN
    const tb = typeof b === 'string' ? Date.parse(b) : NaN
    if (!Number.isNaN(ta) && !Number.isNaN(tb) && /T/.test(String(a))) return ta - tb
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
  }

  let nextId = 0

  function builder(table: string) {
    const filters: ((r: Row) => boolean)[] = []
    let op: 'select' | 'update' | 'insert' = 'select'
    let patch: Row = {}
    let inserted: Row[] = []
    let selectCols = '*'
    let countHead = false
    let orderCol: string | null = null
    let limitN: number | null = null
    let range: [number, number] | null = null

    const run = () => {
      const rows = (tables[table] ??= [])
      if (op === 'insert') {
        for (const r of inserted) {
          r.id ??= `${table}-${++nextId}`
          r.created_at ??= new Date().toISOString()
          rows.push(r)
        }
        return { data: inserted.map((r) => ({ ...r })), error: null }
      }
      let matched = rows.filter((r) => filters.every((f) => f(r)))
      if (op === 'update') {
        for (const r of matched) Object.assign(r, patch)
      }
      if (countHead) return { data: null, count: matched.length, error: null }
      if (orderCol) {
        const col = orderCol
        matched = [...matched].sort((a, b) => cmp(a[col], b[col]))
      }
      if (range) matched = matched.slice(range[0], range[1] + 1)
      if (limitN != null) matched = matched.slice(0, limitN)
      const withEmbeds = matched.map((r) =>
        selectCols.includes('contact:contacts')
          ? {
              ...r,
              contact: (tables.contacts ?? []).find((c) => c.id === r.contact_id) ?? null,
            }
          : { ...r },
      )
      return { data: withEmbeds, error: null }
    }

    const b = {
      select: (cols = '*', opts?: { count?: string; head?: boolean }) => {
        selectCols = cols
        if (opts?.head) countHead = true
        return b
      },
      update: (p: Row) => ((op = 'update'), (patch = p), b),
      insert: (p: Row | Row[]) => (
        (op = 'insert'), (inserted = (Array.isArray(p) ? p : [p]).map((r) => ({ ...r }))), b
      ),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), b),
      lt: (k: string, v: unknown) => (filters.push((r) => r[k] != null && cmp(r[k], v) < 0), b),
      lte: (k: string, v: unknown) => (filters.push((r) => r[k] != null && cmp(r[k], v) <= 0), b),
      gt: (k: string, v: unknown) => (filters.push((r) => r[k] != null && cmp(r[k], v) > 0), b),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
      is: (k: string, v: null) => (filters.push((r) => (r[k] ?? null) === v), b),
      not: (k: string, _op: 'is', v: null) => (filters.push((r) => (r[k] ?? null) !== v), b),
      order: (col: string) => ((orderCol = col), b),
      limit: (n: number) => ((limitN = n), b),
      range: (from: number, to: number) => ((range = [from, to]), b),
      maybeSingle: () => {
        const res = run()
        return Promise.resolve({ ...res, data: Array.isArray(res.data) ? (res.data[0] ?? null) : null })
      },
      single: () => b.maybeSingle(),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(onF, onR),
    }
    return b
  }

  return {
    tables,
    db: { from: (t: string) => builder(t) },
    settled: [] as string[],
    charged: [] as number[],
  }
})

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => h.db }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }))
vi.mock('@/lib/wallet/wallet', () => {
  class WalletError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
  return {
    WalletError,
    hasBroadcastDebit: vi.fn(async () => true),
    getTemplateCharge: vi.fn(async () => ({ category: 'marketing', pricePaise: 78 })),
    chargeTemplateSend: vi.fn(async ({ quantity }: { quantity: number }) => {
      h.charged.push(quantity)
    }),
    settleBroadcastCharge: vi.fn(async (_account: string, id: string) => {
      h.settled.push(id)
      return true
    }),
  }
})
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTemplateMessage: vi.fn(),
  getPhoneSendingProfile: vi.fn(async () => ({
    throughputLevel: 'HIGH',
    isCoexistence: false,
    messagingLimit: null,
  })),
}))

import { MetaApiError, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import {
  runBroadcast,
  scanBroadcastQueue,
  runQueue,
  classifySendError,
  targetMessagesPerSecond,
  runPool,
  Pacer,
} from './broadcast-engine'
import { parseMessagingLimitTier } from '@/lib/whatsapp/meta-api'

const send = vi.mocked(sendTemplateMessage)
const BID = 'b1'

function seed({
  recipients,
  status = 'scheduled',
  lockedUntil = null,
  scheduledAt = new Date(Date.now() - 1000).toISOString(),
}: {
  recipients: number
  status?: string
  lockedUntil?: string | null
  scheduledAt?: string
}) {
  for (const k of Object.keys(h.tables)) delete h.tables[k]
  h.tables.broadcasts = [
    {
      id: BID,
      account_id: 'acc1',
      name: 'Promo',
      template_name: 'promo',
      template_language: 'en_US',
      template_variables: {},
      header_media_url: null,
      status,
      scheduled_at: scheduledAt,
      locked_until: lockedUntil,
    },
  ]
  h.tables.whatsapp_config = [
    { account_id: 'acc1', user_id: 'owner1', phone_number_id: 'pn1', access_token: 'tok' },
  ]
  h.tables.message_templates = []
  h.tables.contact_custom_values = []
  h.tables.contacts = []
  h.tables.conversations = []
  h.tables.messages = []
  h.tables.broadcast_recipients = []
  for (let i = 0; i < recipients; i++) {
    const n = String(i).padStart(5, '0')
    h.tables.contacts.push({ id: `c${n}`, phone: `9198840${n}`, name: `User ${i}` })
    h.tables.broadcast_recipients.push({
      id: `r${n}`,
      broadcast_id: BID,
      contact_id: `c${n}`,
      status: 'pending',
      attempted_at: null,
      whatsapp_message_id: null,
      error_message: null,
    })
  }
}

const recipients = () => h.tables.broadcast_recipients
const broadcastRow = () => h.tables.broadcasts[0]

beforeEach(() => {
  process.env.BROADCAST_MAX_MPS = '1000'
  h.settled.length = 0
  h.charged.length = 0
  let n = 0
  send.mockImplementation(async () => ({ messageId: `wamid.${++n}` }))
})

describe('runBroadcast', () => {
  it('sends every recipient exactly once across pages and closes the campaign', async () => {
    seed({ recipients: 1_050 }) // > 2 pages of 500

    await runBroadcast(BID)

    expect(send).toHaveBeenCalledTimes(1_050)
    const sentTo = new Set(send.mock.calls.map(([args]) => args.to))
    expect(sentTo.size).toBe(1_050)
    expect(recipients().every((r) => r.status === 'sent' && r.whatsapp_message_id)).toBe(true)
    expect(broadcastRow().status).toBe('sent')
    expect(broadcastRow().locked_until).toBeNull()
    expect(h.settled).toEqual([BID])
  })

  it('copies each sent message into the contact’s inbox thread', async () => {
    seed({ recipients: 3 })
    h.tables.message_templates = [
      {
        id: 't1',
        user_id: 'owner1',
        account_id: 'acc1',
        name: 'promo',
        language: 'en_US',
        category: 'MARKETING',
        status: 'APPROVED',
        body_text: 'Hi {{1}}, 20% off today!',
        buttons: [],
      },
    ]
    h.tables.broadcasts[0].template_variables = { '1': { type: 'field', value: 'name' } }
    // c00000 already has a thread; the others get one created.
    h.tables.conversations = [
      { id: 'conv-existing', account_id: 'acc1', contact_id: 'c00000', created_at: '2026-01-01T00:00:00.000Z' },
    ]
    send.mockImplementation(async ({ to }) => ({ messageId: `wamid.${to}` }))

    await runBroadcast(BID)

    expect(h.tables.conversations).toHaveLength(3)
    expect(h.tables.messages).toHaveLength(3)
    const first = h.tables.messages.find((m) => m.conversation_id === 'conv-existing')
    expect(first).toMatchObject({
      sender_type: 'bot',
      content_type: 'template',
      content_text: 'Hi User 0, 20% off today!',
      template_name: 'promo',
      message_id: 'wamid.919884000000',
      status: 'sent',
    })
    expect(h.tables.conversations.find((c) => c.id === 'conv-existing')).toMatchObject({
      last_message_text: 'Hi User 0, 20% off today!',
    })
  })

  it('does not copy failed sends into the inbox', async () => {
    seed({ recipients: 2 })
    send.mockImplementation(async ({ to }) => {
      if (to === '919884000001') throw new MetaApiError('Message undeliverable', 400, 131026)
      return { messageId: `wamid.${to}` }
    })

    await runBroadcast(BID)

    expect(h.tables.messages).toHaveLength(1)
    expect(h.tables.conversations).toHaveLength(1)
    expect(h.tables.conversations[0].contact_id).toBe('c00000')
  })

  it('retries a Meta outage and then succeeds', async () => {
    seed({ recipients: 1 })
    send.mockRejectedValueOnce(new MetaApiError('Service unavailable', 503))

    await runBroadcast(BID)

    expect(send).toHaveBeenCalledTimes(2)
    expect(recipients()[0].status).toBe('sent')
  })

  it('stops the whole campaign on an account-wide error', async () => {
    seed({ recipients: 300 })
    send.mockRejectedValue(new MetaApiError('Error validating access token', 401, 190))

    await runBroadcast(BID)

    // Only what was already in flight — not all 300.
    expect(send.mock.calls.length).toBeLessThan(100)
    expect(recipients().every((r) => r.status === 'failed')).toBe(true)
    expect(recipients().filter((r) => r.attempted_at === null)[0].error_message).toBe(
      'Error validating access token',
    )
    expect(broadcastRow().status).toBe('failed')
    expect(h.settled).toEqual([BID])
  })

  it('trips the breaker when nothing gets through', async () => {
    seed({ recipients: 300 })
    send.mockRejectedValue(new MetaApiError('Message undeliverable', 400, 131026))

    await runBroadcast(BID)

    expect(send.mock.calls.length).toBeLessThan(150)
    const unattempted = recipients().filter((r) => r.attempted_at === null)
    expect(unattempted.length).toBeGreaterThan(0)
    expect(String(unattempted[0].error_message)).toMatch(/^Stopped: the first \d+ sends all failed/)
    expect(broadcastRow().status).toBe('failed')
  })

  it('fails one bad recipient without stopping the rest', async () => {
    seed({ recipients: 5 })
    send.mockImplementation(async ({ to }) => {
      if (to === '919884000002') throw new MetaApiError('Message undeliverable', 400, 131026)
      return { messageId: `wamid.${to}` }
    })

    await runBroadcast(BID)

    expect(recipients().filter((r) => r.status === 'sent')).toHaveLength(4)
    expect(recipients().find((r) => r.id === 'r00002')?.error_message).toBe('Message undeliverable')
    expect(broadcastRow().status).toBe('sent')
  })

  it('resumes after a crash without re-sending the recipient that was mid-flight', async () => {
    seed({
      recipients: 4,
      status: 'sending',
      lockedUntil: new Date(Date.now() - 5_000).toISOString(),
    })
    // r00000 went out before the crash; r00001 was mid-send.
    Object.assign(recipients()[0], {
      status: 'sent',
      attempted_at: new Date().toISOString(),
      whatsapp_message_id: 'wamid.old',
    })
    Object.assign(recipients()[1], { attempted_at: new Date().toISOString() })

    const queue = await scanBroadcastQueue()
    expect(queue.run).toEqual([BID])
    await runQueue(queue)

    const sentTo = send.mock.calls.map(([args]) => args.to).sort()
    expect(sentTo).toEqual(['919884000002', '919884000003'])
    expect(recipients()[1].status).toBe('failed')
    expect(String(recipients()[1].error_message)).toMatch(/^Interrupted mid-send/)
    expect(broadcastRow().status).toBe('sent')
  })

  it('closes, rather than resumes, a campaign that died over an hour ago', async () => {
    seed({
      recipients: 3,
      status: 'sending',
      lockedUntil: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    })

    const queue = await scanBroadcastQueue()
    expect(queue).toEqual({ run: [], close: [{ id: BID, status: 'sending' }] })
    await runQueue(queue)

    expect(send).not.toHaveBeenCalled()
    expect(recipients().every((r) => r.status === 'failed')).toBe(true)
    expect(broadcastRow().status).toBe('failed')
    expect(broadcastRow().locked_until).toBeNull()
    expect(h.settled).toEqual([BID])
  })

  it('settles a campaign stopped by the user whose process then died', async () => {
    seed({
      recipients: 3,
      status: 'cancelled',
      lockedUntil: new Date(Date.now() - 5_000).toISOString(),
    })
    Object.assign(recipients()[0], { status: 'sent', whatsapp_message_id: 'wamid.x' })

    const queue = await scanBroadcastQueue()
    expect(queue.close).toEqual([{ id: BID, status: 'cancelled' }])
    await runQueue(queue)

    expect(send).not.toHaveBeenCalled()
    expect(recipients().filter((r) => r.error_message === 'Cancelled')).toHaveLength(2)
    expect(broadcastRow().status).toBe('cancelled')
    expect(broadcastRow().locked_until).toBeNull()
    expect(h.settled).toEqual([BID])
    // Closed once — the next tick has nothing to do.
    expect(await scanBroadcastQueue()).toEqual({ run: [], close: [] })
  })

  it('leaves a campaign for resume, not closed, when it crashes', async () => {
    seed({ recipients: 3 })
    const realFrom = h.db.from
    // The database drops out while recipients are being loaded.
    h.db.from = (t: string) => {
      if (t === 'broadcast_recipients') {
        return {
          ...realFrom(t),
          select: () => {
            throw new Error('connection reset')
          },
        } as unknown as ReturnType<typeof realFrom>
      }
      return realFrom(t)
    }
    try {
      await runBroadcast(BID)
    } finally {
      h.db.from = realFrom
    }

    expect(send).not.toHaveBeenCalled()
    expect(broadcastRow().status).toBe('sending')
    expect(broadcastRow().locked_until).not.toBeNull()
    expect(h.settled).toEqual([])
  })

  it('never sends to recipients a Stop has already cancelled', async () => {
    seed({ recipients: 200 })
    let calls = 0
    send.mockImplementation(async () => {
      if (++calls === 10) {
        // What POST /api/broadcasts/[id]/cancel does.
        broadcastRow().status = 'cancelled'
        for (const r of recipients()) {
          if (r.status === 'pending' && r.attempted_at === null) {
            Object.assign(r, { status: 'failed', error_message: 'Cancelled' })
          }
        }
      }
      return { messageId: `wamid.${calls}` }
    })

    await runBroadcast(BID)

    const sent = recipients().filter((r) => r.status === 'sent').length
    const cancelled = recipients().filter((r) => r.error_message === 'Cancelled').length
    expect(sent).toBe(send.mock.calls.length)
    expect(sent + cancelled).toBe(200)
    expect(sent).toBeLessThan(200)
    expect(broadcastRow().status).toBe('cancelled')
  })

  it('does not start a campaign scheduled for later', async () => {
    seed({ recipients: 2, scheduledAt: new Date(Date.now() + 60_000).toISOString() })

    await runBroadcast(BID)

    expect(send).not.toHaveBeenCalled()
    expect(broadcastRow().status).toBe('scheduled')
  })

  it('runs a campaign once even when started twice at the same time', async () => {
    seed({ recipients: 50 })

    await Promise.all([runBroadcast(BID), runBroadcast(BID)])

    expect(send).toHaveBeenCalledTimes(50)
  })
})

describe('classifySendError', () => {
  it.each([
    [new MetaApiError('throughput', 400, 130429), 'throttled'],
    [new MetaApiError('too many', 429), 'throttled'],
    [new MetaApiError('pair rate', 400, 131056), 'throttled'],
    [new MetaApiError('down', 500), 'transient'],
    [new MetaApiError('Something went wrong', 400, 131000), 'transient'],
    [new MetaApiError('token', 401, 190), 'fatal'],
    [new MetaApiError('template paused', 400, 132015), 'fatal'],
    [new MetaApiError('(#131030) Recipient phone number not in allowed list', 400, 131030), 'recipient_not_allowed'],
    [new MetaApiError('undeliverable', 400, 131026), 'permanent'],
    [new MetaApiError('marketing limit', 400, 131049), 'permanent'],
    // Connection never opened — safe to retry.
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'transient'],
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), 'transient'],
    // Dropped after the request went out — Meta may have it; don't resend.
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), 'permanent'],
    [new TypeError('fetch failed'), 'permanent'],
    [Object.assign(new Error('aborted'), { name: 'TimeoutError' }), 'permanent'],
  ])('%s → %s', (err, kind) => {
    expect(classifySendError(err)).toBe(kind)
  })
})

describe('targetMessagesPerSecond', () => {
  const standard = { throughputLevel: 'STANDARD', isCoexistence: false, messagingLimit: null }
  it('defaults to 40/s on a standard number', () => {
    expect(targetMessagesPerSecond(standard, NaN)).toBe(40)
  })
  it('stays under 80% of the coexistence cap of 20/s', () => {
    expect(targetMessagesPerSecond({ ...standard, isCoexistence: true }, 100)).toBe(16)
  })
  it('assumes the coexistence cap when the number is unknown', () => {
    expect(targetMessagesPerSecond(null, NaN)).toBe(16)
  })
  it('never exceeds 80% of the standard 80/s cap', () => {
    expect(targetMessagesPerSecond(standard, 500)).toBe(64)
  })
})

describe('parseMessagingLimitTier', () => {
  it.each([
    ['TIER_250', 250],
    ['TIER_2K', 2000],
    ['TIER_10K', 10000],
    ['TIER_UNLIMITED', Infinity],
    [undefined, null],
    ['garbage', null],
  ])('%s → %s', (tier, limit) => {
    expect(parseMessagingLimitTier(tier)).toBe(limit)
  })
})

describe('runPool', () => {
  it('stops handing out work once asked and waits for in-flight items', async () => {
    const done: number[] = []
    let stop = false
    await runPool(
      Array.from({ length: 100 }, (_, i) => i),
      4,
      async (i) => {
        await new Promise((r) => setTimeout(r, 1))
        done.push(i)
        if (i === 10) stop = true
      },
      () => stop,
    )
    expect(done.length).toBeLessThan(20)
    expect(done).toContain(10)
  })

  it('rethrows a worker error only after the other lanes finish', async () => {
    let finished = 0
    await expect(
      runPool(
        [0, 1, 2, 3],
        4,
        async (i) => {
          if (i === 0) throw new Error('boom')
          await new Promise((r) => setTimeout(r, 5))
          finished++
        },
        () => false,
      ),
    ).rejects.toThrow('boom')
    expect(finished).toBe(3)
  })
})

describe('Pacer', () => {
  it('spaces slots at the configured rate', async () => {
    const pacer = new Pacer(100) // 10 ms apart
    const start = Date.now()
    await Promise.all(Array.from({ length: 6 }, () => pacer.take()))
    expect(Date.now() - start).toBeGreaterThanOrEqual(45)
  })
})
