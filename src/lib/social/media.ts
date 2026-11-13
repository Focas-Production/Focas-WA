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

/** Still images we re-encode to WebP (GIFs are skipped — may be animated). */
const COMPRESSIBLE_IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp'])

/** Longest side, in px, for re-hosted chat images / avatars. */
const IMAGE_MAX_DIMENSION = 1280
const AVATAR_MAX_DIMENSION = 256
const WEBP_QUALITY = 75

/**
 * Largest Instagram / Messenger attachment we copy into storage.
 * Defaults to 5 MB to stay inside the free plan's 1 GB of file storage;
 * set SOCIAL_MEDIA_MAX_MB to change it (capped at the 16 MB bucket
 * limit). Bigger files keep Meta's CDN link, which expires after a few
 * days.
 */
export function socialMediaMaxBytes(): number {
  const mb = Number(process.env.SOCIAL_MEDIA_MAX_MB)
  const bytes = Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : 5 * 1024 * 1024
  return Math.min(bytes, MEDIA_MAX_BYTES)
}

/**
 * Shrink a still image: fit within `maxDimension` and re-encode as
 * WebP. Returns null when it can't help (sharp unavailable, decode
 * error, or the result isn't smaller) so the caller keeps the original.
 */
export async function compressImage(
  bytes: ArrayBuffer,
  maxDimension: number,
): Promise<Buffer | null> {
  try {
    const sharp = (await import('sharp')).default
    const out = await sharp(Buffer.from(bytes), { failOn: 'none' })
      .rotate() // honour EXIF orientation before metadata is stripped
      .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer()
    return out.byteLength < bytes.byteLength ? out : null
  } catch (err) {
    console.warn('[social] image compression skipped:', err instanceof Error ? err.message : err)
    return null
  }
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
  return (await rehostSocialMediaDetailed(db, accountId, url, baseName)).url
}

/**
 * Same as `rehostSocialMedia`, but also reports the MIME type Meta's
 * CDN served (null when the fetch failed). Used for attachments whose
 * webhook `type` doesn't say what they are (e.g. Instagram's
 * `unsupported_type`), so the caller can still render them as an
 * image or video.
 *
 * Still images are resized and re-encoded to WebP before upload
 * (avatars — `baseName` starting with "avatar-" — to 256 px), which
 * typically cuts them 5–10×.
 */
export async function rehostSocialMediaDetailed(
  db: SupabaseClient,
  accountId: string,
  url: string,
  baseName: string,
): Promise<{ url: string; contentType: string | null; rehosted: boolean }> {
  const fallback = (contentType: string | null = null) => ({ url, contentType, rehosted: false })
  const maxBytes = socialMediaMaxBytes()
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) {
      console.warn('[social] media re-host fetch failed:', response.status)
      return fallback()
    }
    const sourceType = (response.headers.get('content-type') ?? 'application/octet-stream')
      .split(';')[0]
      .trim()
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > maxBytes) {
      console.warn('[social] media too large to re-host:', declared, 'bytes, limit', maxBytes)
      return fallback(sourceType)
    }

    const raw = await response.arrayBuffer()

    // Compress still images first — a large photo can fit once shrunk.
    let body: ArrayBuffer | Buffer = raw
    let contentType = sourceType
    if (COMPRESSIBLE_IMAGES.has(sourceType)) {
      const maxDim = baseName.startsWith('avatar-') ? AVATAR_MAX_DIMENSION : IMAGE_MAX_DIMENSION
      const compressed = await compressImage(raw, maxDim)
      if (compressed) {
        body = compressed
        contentType = 'image/webp'
      }
    }

    if (body.byteLength > maxBytes) {
      console.warn('[social] media too large to re-host:', body.byteLength, 'bytes, limit', maxBytes)
      return fallback(sourceType)
    }

    const ext = EXT_BY_MIME[contentType] ?? 'bin'
    const path = buildMediaPath(accountId, `${baseName}.${ext}`)

    const { error } = await db.storage
      .from(CHAT_MEDIA_BUCKET)
      // Object names are unique per upload, so browsers/CDN can cache
      // them for a year — repeat views then cost no egress.
      .upload(path, body, { contentType, upsert: false, cacheControl: '31536000' })
    if (error) {
      console.warn('[social] media re-host upload failed:', error.message)
      return fallback(sourceType)
    }
    return {
      url: db.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl,
      contentType,
      rehosted: true,
    }
  } catch (err) {
    console.warn('[social] media re-host failed:', err instanceof Error ? err.message : err)
    return fallback()
  }
}
