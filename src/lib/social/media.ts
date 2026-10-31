import type { SupabaseClient } from '@supabase/supabase-js'

import { buildMediaPath, MEDIA_MAX_BYTES } from '@/lib/storage/upload-media'

/** Same bucket the inbox composer uploads to (migration 023). */
const CHAT_MEDIA_BUCKET = 'chat-media'

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
}

/**
 * Copy an Instagram / Messenger attachment into the account's
 * `chat-media` folder and return its public URL.
 *
 * Meta serves inbound attachments (and profile pictures) from signed
 * CDN URLs that expire within days, so storing them as-is leaves
 * broken images in old threads. Best-effort: on any failure (too big,
 * fetch error, storage error) the original URL is returned so the
 * message still lands.
 */
export async function rehostSocialMedia(
  db: SupabaseClient,
  accountId: string,
  url: string,
  baseName: string,
): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) return url
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MEDIA_MAX_BYTES) return url

    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > MEDIA_MAX_BYTES) return url

    const contentType = (response.headers.get('content-type') ?? 'application/octet-stream')
      .split(';')[0]
      .trim()
    const ext = EXT_BY_MIME[contentType] ?? 'bin'
    const path = buildMediaPath(accountId, `${baseName}.${ext}`)

    const { error } = await db.storage
      .from(CHAT_MEDIA_BUCKET)
      .upload(path, bytes, { contentType, upsert: false, cacheControl: '3600' })
    if (error) {
      console.warn('[social] media re-host upload failed:', error.message)
      return url
    }
    return db.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl
  } catch (err) {
    console.warn('[social] media re-host failed:', err instanceof Error ? err.message : err)
    return url
  }
}
