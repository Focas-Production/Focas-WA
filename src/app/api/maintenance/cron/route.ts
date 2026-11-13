import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * Daily storage / database housekeeping (migration 053).
 *
 *   1. Media retention — deletes `chat-media` files older than
 *      MEDIA_RETENTION_DAYS (default 90) that are attached only to chat
 *      messages, then clears those messages' `media_url` so the inbox
 *      shows "media unavailable". Message text is kept. Files used by
 *      templates, broadcasts, flows, automations, quick replies, catalog
 *      products or contact avatars are never deleted. 0 disables.
 *   2. Log pruning — automation_logs and finished flow_run_events older
 *      than LOG_RETENTION_DAYS (default 30), read notifications older
 *      than NOTIFICATION_RETENTION_DAYS (default 60). 0 disables.
 *
 * Auth: `x-cron-secret` = AUTOMATION_CRON_SECRET, like the other crons.
 * Schedule: once a day is plenty, e.g.
 *   0 3 * * * curl -s -H "x-cron-secret: $SECRET" https://your-host/api/maintenance/cron
 * Add `?dry_run=1` to see what would be deleted without deleting it.
 */

export const maxDuration = 60

const BUCKET = 'chat-media'
/** Objects per run — keeps one call well inside maxDuration. */
const MEDIA_BATCH_LIMIT = 500
/** Storage API remove() batch size. */
const REMOVE_CHUNK = 100

function retentionDays(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

function authorized(request: Request): boolean {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return false
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const expectedBuf = Buffer.from(expected)
  return supplied.length === expectedBuf.length && timingSafeEqual(supplied, expectedBuf)
}

export async function GET(request: Request) {
  if (!process.env.AUTOMATION_CRON_SECRET) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dryRun = new URL(request.url).searchParams.get('dry_run') === '1'
  const db = supabaseAdmin()
  const result: Record<string, unknown> = { dry_run: dryRun }

  // ---- 1. Media retention -------------------------------------------
  const mediaDays = retentionDays('MEDIA_RETENTION_DAYS', 90)
  if (mediaDays > 0) {
    const cutoff = new Date(Date.now() - mediaDays * 86_400_000).toISOString()
    const { data, error } = await db.rpc('chat_media_expired_objects', {
      p_cutoff: cutoff,
      p_limit: MEDIA_BATCH_LIMIT,
    })
    if (error) {
      console.error('[maintenance] media scan failed:', error.message)
      result.media = { error: error.message }
    } else {
      const names = ((data ?? []) as { object_name: string }[]).map((r) => r.object_name)
      let deleted = 0
      let messagesCleared = 0
      if (!dryRun) {
        for (let i = 0; i < names.length; i += REMOVE_CHUNK) {
          const chunk = names.slice(i, i + REMOVE_CHUNK)
          const { data: removed, error: rmErr } = await db.storage.from(BUCKET).remove(chunk)
          if (rmErr) {
            console.error('[maintenance] media delete failed:', rmErr.message)
            continue
          }
          const removedNames = (removed ?? []).map((o) => o.name)
          deleted += removedNames.length
          if (removedNames.length === 0) continue
          const urls = removedNames.map((n) => db.storage.from(BUCKET).getPublicUrl(n).data.publicUrl)
          const { count, error: upErr } = await db
            .from('messages')
            .update({ media_url: null }, { count: 'exact' })
            .in('media_url', urls)
          if (upErr) console.error('[maintenance] message media_url clear failed:', upErr.message)
          messagesCleared += count ?? 0
        }
      }
      result.media = {
        retention_days: mediaDays,
        candidates: names.length,
        deleted,
        messages_cleared: messagesCleared,
        more_remaining: names.length === MEDIA_BATCH_LIMIT,
      }
    }
  } else {
    result.media = 'disabled'
  }

  // ---- 2. Log pruning -----------------------------------------------
  const logDays = retentionDays('LOG_RETENTION_DAYS', 30)
  const notificationDays = retentionDays('NOTIFICATION_RETENTION_DAYS', 60)
  if (dryRun) {
    result.logs = { log_retention_days: logDays, notification_retention_days: notificationDays, skipped: 'dry run' }
  } else {
    const { data, error } = await db.rpc('prune_old_logs', {
      p_log_days: logDays,
      p_notification_days: notificationDays,
    })
    if (error) {
      console.error('[maintenance] log prune failed:', error.message)
      result.logs = { error: error.message }
    } else {
      result.logs = data
    }
  }

  return NextResponse.json(result)
}
