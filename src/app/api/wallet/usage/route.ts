import { NextResponse, type NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveWalletCaller } from '@/lib/wallet/auth'

/**
 * GET /api/wallet/usage — grouped wallet spend for the caller's account.
 *
 * Query:
 *   group  campaign | template | category | source | day   (default campaign)
 *   from   ISO timestamp, inclusive (optional)
 *   to     ISO timestamp, exclusive (optional)
 *   tz     IANA zone for day buckets (default Asia/Kolkata)
 *
 * Aggregation runs in Postgres (`wallet_usage_summary`, migration 045)
 * over the (account_id, created_at) index, so totals are exact for any
 * volume — the browser never pages through raw ledger rows to add them up.
 */

const GROUPS = ['campaign', 'template', 'category', 'source', 'day'] as const
type Group = (typeof GROUPS)[number]

interface SummaryRow {
  group_key: string
  label: string | null
  source: string | null
  source_ref: string | null
  debit_paise: number | string
  refund_paise: number | string
  credit_paise: number | string
  messages: number | string
  refunded_messages: number | string
  tx_count: number | string
  first_at: string | null
  last_at: string | null
}

function parseDate(value: string | null): string | null | undefined {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return /^[A-Za-z0-9_+\-/]+$/.test(tz)
  } catch {
    return false
  }
}

function serialize(r: SummaryRow) {
  const debit = Number(r.debit_paise)
  const refund = Number(r.refund_paise)
  const messages = Number(r.messages)
  const refunded = Number(r.refunded_messages)
  return {
    key: r.group_key,
    label: r.label,
    source: r.source,
    source_ref: r.source_ref,
    debit_paise: debit,
    refund_paise: refund,
    credit_paise: Number(r.credit_paise),
    net_spend_paise: Math.round((debit - refund) * 100) / 100,
    messages,
    refunded_messages: refunded,
    net_messages: messages - refunded,
    tx_count: Number(r.tx_count),
    first_at: r.first_at,
    last_at: r.last_at,
  }
}

export async function GET(request: NextRequest) {
  const { caller, error } = await resolveWalletCaller()
  if (error) return error

  const params = request.nextUrl.searchParams
  const group = (params.get('group') ?? 'campaign') as Group
  if (!GROUPS.includes(group)) {
    return NextResponse.json({ error: 'Invalid group' }, { status: 400 })
  }
  const from = parseDate(params.get('from'))
  const to = parseDate(params.get('to'))
  if (from === undefined || to === undefined) {
    return NextResponse.json({ error: 'Invalid date range' }, { status: 400 })
  }
  const tz = params.get('tz') || 'Asia/Kolkata'
  if (!isValidTimeZone(tz)) {
    return NextResponse.json({ error: 'Invalid time zone' }, { status: 400 })
  }

  const db = supabaseAdmin()
  const args = { p_account_id: caller.accountId, p_from: from, p_to: to, p_tz: tz }
  const [grouped, totals] = await Promise.all([
    db.rpc('wallet_usage_summary', { ...args, p_group: group }),
    db.rpc('wallet_usage_summary', { ...args, p_group: 'total' }),
  ])
  if (grouped.error || totals.error) {
    console.error(
      '[wallet/usage] summary failed:',
      grouped.error?.message ?? totals.error?.message,
    )
    return NextResponse.json({ error: 'Failed to load usage' }, { status: 500 })
  }

  const rows = ((grouped.data ?? []) as SummaryRow[]).map(serialize)
  rows.sort((a, b) =>
    group === 'day'
      ? b.key.localeCompare(a.key)
      : b.net_spend_paise - a.net_spend_paise || b.messages - a.messages,
  )
  const total = ((totals.data ?? []) as SummaryRow[]).map(serialize)[0] ?? null

  return NextResponse.json({ group, from, to, tz, totals: total, rows })
}
