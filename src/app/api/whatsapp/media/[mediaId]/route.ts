import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { parseRange } from '@/lib/whatsapp/media-range'

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/zip': 'zip',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
}

/** Display name for the file, guaranteed to carry an extension when the MIME type is known. */
function buildFilename(name: string | null, mediaId: string, mimeType: string): string {
  const base = (name ?? '').replace(/[\/\\\r\n]/g, '_').trim().slice(0, 200) || `file-${mediaId}`
  const ext = EXT_BY_MIME[mimeType.split(';')[0].trim().toLowerCase()]
  if (!ext || base.toLowerCase().endsWith(`.${ext}`)) return base
  return `${base}.${ext}`
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // Fetch and decrypt WhatsApp config
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    // Meta's CDN often serves documents as a generic octet-stream; the
    // media metadata carries the real MIME type. Without it (and a
    // filename) the browser saves an extension-less file nobody can open.
    const isGeneric = (t?: string) =>
      !t || t.startsWith('application/octet-stream') || t.startsWith('binary/')
    const resolvedType = !isGeneric(contentType)
      ? contentType
      : !isGeneric(mediaInfo.mimeType)
        ? mediaInfo.mimeType
        : 'application/octet-stream'

    const bytes = new Uint8Array(buffer)
    const headers: Record<string, string> = {
      'Content-Type': resolvedType,
      // Private: the bytes are only reachable with this account's session.
      'Cache-Control': 'private, max-age=86400',
      'Accept-Ranges': 'bytes',
    }

    const filename = buildFilename(
      new URL(request.url).searchParams.get('name'),
      mediaId,
      resolvedType
    )
    // inline: PDFs/images open in the browser tab; anything the browser
    // can't render is downloaded under this name instead.
    headers['Content-Disposition'] =
      `inline; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; ` +
      `filename*=UTF-8''${encodeURIComponent(filename)}`

    // <audio>/<video> send Range requests to seek; answer them with 206
    // so scrubbing and duration work instead of a non-seekable stream.
    const range = parseRange(request.headers.get('range'), bytes.length)
    if (range === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${bytes.length}` },
      })
    }
    if (range) {
      const { start, end } = range
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
          'Content-Length': String(end - start + 1),
        },
      })
    }

    return new Response(bytes, {
      status: 200,
      headers: { ...headers, 'Content-Length': String(bytes.length) },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
