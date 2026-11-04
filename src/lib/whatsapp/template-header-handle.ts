import { uploadResumableMedia } from '@/lib/whatsapp/meta-api'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'

/**
 * Meta requires an `example.header_handle` (from the Resumable Upload
 * API) to create/edit a template with an IMAGE, VIDEO or DOCUMENT header
 * — a plain public URL (`header_url`) is rejected at creation time with
 * a bare "Invalid parameter". This helper turns the template's
 * `header_media_url` (whether the user uploaded a file or pasted a link)
 * into a handle and writes it onto the payload.
 *
 * No-op unless the header is media with a URL but no handle yet.
 * `header_media_url` itself is kept: sends fall back to it as the
 * header link (template-send-builder).
 */

type MediaKind = 'image' | 'video' | 'document'

// Meta's header-sample limits per media type.
const RULES: Record<MediaKind, {
  maxBytes: number
  types: string[]
  label: string
  typeError: string
  defaultType: string
  fileName: (mime: string) => string
}> = {
  image: {
    maxBytes: 5 * 1024 * 1024,
    types: ['image/jpeg', 'image/png'],
    label: 'image',
    typeError: 'Header image must be JPEG or PNG',
    defaultType: 'image/jpeg',
    fileName: (m) => (m === 'image/png' ? 'header.png' : 'header.jpg'),
  },
  video: {
    maxBytes: 16 * 1024 * 1024,
    types: ['video/mp4', 'video/3gpp'],
    label: 'video',
    typeError: 'Header video must be MP4 or 3GPP',
    defaultType: 'video/mp4',
    fileName: (m) => (m === 'video/3gpp' ? 'header.3gp' : 'header.mp4'),
  },
  document: {
    maxBytes: 100 * 1024 * 1024,
    types: ['application/pdf'],
    label: 'document',
    typeError: 'Header document must be a PDF',
    defaultType: 'application/pdf',
    fileName: () => 'sample.pdf',
  },
}

// Generic types servers send for any file — judge those by the bytes instead.
const GENERIC_TYPES = ['', 'application/octet-stream', 'binary/octet-stream', 'application/force-download']

export async function ensureMediaHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
): Promise<void> {
  const kind = payload.header_type as MediaKind
  const rule = RULES[kind]
  if (!rule) return
  if (payload.header_handle) return // already have one
  if (!payload.header_media_url) return // validator already requires url-or-handle

  const appId = process.env.META_APP_ID
  if (!appId) {
    throw new Error(
      `${cap(rule.label)}-header templates need META_APP_ID set (used for Meta’s Resumable Upload). Add it to your environment, or remove the ${rule.label} header.`,
    )
  }

  // Fetch the sample bytes (works for our uploaded chat-media URL and
  // for a manually-pasted public link).
  let res: Response
  try {
    res = await fetch(payload.header_media_url)
  } catch {
    throw new Error(`Could not fetch the header ${rule.label} URL. Make sure it is publicly reachable.`)
  }
  if (!res.ok) {
    throw new Error(`Header ${rule.label} URL returned ${res.status}. It must be publicly reachable.`)
  }

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new Error(`Header ${rule.label} is empty.`)
  }

  const looksPdf = kind === 'document' && bytes.byteLength >= 5 &&
    String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-'
  if (contentType && !rule.types.includes(contentType) && !(GENERIC_TYPES.includes(contentType) && (kind !== 'document' || looksPdf))) {
    throw new Error(`${rule.typeError} (got ${contentType}).`)
  }
  if (kind === 'document' && !looksPdf) {
    throw new Error(`${rule.typeError} — the link did not return a PDF file.`)
  }
  if (bytes.byteLength > rule.maxBytes) {
    throw new Error(
      `Header ${rule.label} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — Meta's limit is ${rule.maxBytes / 1024 / 1024} MB.`,
    )
  }

  const mimeType = rule.types.includes(contentType) ? contentType : rule.defaultType
  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName: rule.fileName(mimeType),
    mimeType,
    bytes,
  })
  payload.header_handle = handle
}

/** @deprecated kept for older imports — handles every media header now. */
export const ensureImageHeaderHandle = ensureMediaHeaderHandle

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
