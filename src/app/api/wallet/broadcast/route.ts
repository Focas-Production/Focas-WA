import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveWalletCaller } from '@/lib/wallet/auth'
import {
  getTemplateCharge,
  chargeTemplateSend,
  settleBroadcastCharge,
  WalletError,
} from '@/lib/wallet/wallet'

/**
 * POST /api/wallet/broadcast — campaign-level wallet operations for
 * dashboard broadcasts. One ledger row per campaign instead of one
 * per recipient (the ledger stays small on large sends).
 *
 * Body: { broadcast_id: string, action: 'charge' | 'settle' }
 *
 *   charge — debit rate × total_recipients as a single transaction
 *            (reference `broadcast:<id>`, idempotent) BEFORE the
 *            fan-out. 402 on insufficient balance.
 *   settle — after the fan-out, refund every recipient that never
 *            reached Meta as ONE aggregate refund row.
 */
export async function POST(request: Request) {
  const { caller, error } = await resolveWalletCaller()
  if (error) return error

  const body = await request.json().catch(() => null)
  const broadcastId = String(body?.broadcast_id ?? '')
  const action = String(body?.action ?? '')
  if (!broadcastId || (action !== 'charge' && action !== 'settle')) {
    return NextResponse.json(
      { error: "Provide broadcast_id and action ('charge' | 'settle')." },
      { status: 400 },
    )
  }

  const db = supabaseAdmin()
  const { data: broadcast } = await db
    .from('broadcasts')
    .select('id, name, template_name, template_language, total_recipients')
    .eq('id', broadcastId)
    .eq('account_id', caller.accountId)
    .maybeSingle()
  if (!broadcast) {
    return NextResponse.json({ error: 'Broadcast not found.' }, { status: 404 })
  }

  if (action === 'settle') {
    await settleBroadcastCharge(caller.accountId, broadcastId)
    return NextResponse.json({ success: true })
  }

  const quantity = Number(broadcast.total_recipients ?? 0)
  if (quantity <= 0) {
    return NextResponse.json({ error: 'Broadcast has no recipients.' }, { status: 400 })
  }

  const { category, pricePaise } = await getTemplateCharge(
    caller.accountId,
    broadcast.template_name,
    broadcast.template_language,
  )

  try {
    await chargeTemplateSend({
      accountId: caller.accountId,
      reference: `broadcast:${broadcastId}`,
      category,
      pricePaise,
      quantity,
      description: `Broadcast "${broadcast.name}" — ${quantity} × Template "${broadcast.template_name}"`,
      createdBy: caller.userId,
    })
  } catch (err) {
    if (err instanceof WalletError && err.code === 'insufficient_balance') {
      return NextResponse.json({ error: err.message }, { status: 402 })
    }
    throw err
  }

  return NextResponse.json({
    success: true,
    charged_paise: pricePaise * quantity,
    unit_price_paise: pricePaise,
    quantity,
  })
}
