/**
 * WhatsApp message ids ("wamid.<base64>") wrap a small binary record:
 *
 *   0x1c 0x18 <len> <chat id> ... 0x00 <0x11|0x12> 0x18 <len> <message key> 0x00
 *
 * The same message can reach us under two different wamids. On
 * coexistence numbers, a message sent from the WhatsApp Business app
 * echoes back (smb_message_echoes) keyed on a business-scoped user id
 * ("IN.1258…"), while the customer's later reaction / status for that
 * message references it keyed on their phone number ("9188…"). Only the
 * inner message key is common to both, so matching falls back to it.
 */
export function wamidKey(wamid: string | null | undefined): string | null {
  if (!wamid || !wamid.startsWith('wamid.')) return null
  let bytes: Buffer
  try {
    bytes = Buffer.from(wamid.slice(6), 'base64')
  } catch {
    return null
  }
  if (bytes.length < 4 || bytes[0] !== 0x1c || bytes[1] !== 0x18) return null

  // Skip the chat id, then find the key's length-prefixed field.
  for (let i = 3 + bytes[2]; i + 3 < bytes.length; i++) {
    if (
      bytes[i] === 0x00 &&
      (bytes[i + 1] === 0x11 || bytes[i + 1] === 0x12) &&
      bytes[i + 2] === 0x18
    ) {
      const len = bytes[i + 3]
      const start = i + 4
      if (len === 0 || start + len > bytes.length) return null
      return bytes.subarray(start, start + len).toString('latin1')
    }
  }
  return null
}

/** How far back the key fallback scans in one conversation. */
const KEY_SCAN_LIMIT = 300

/**
 * Internal id of the message `wamid` refers to in `conversationId`, or
 * null. Exact match first; falls back to the inner message key (see
 * wamidKey) over the conversation's recent messages.
 */
export async function findMessageIdByWamid(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  wamid: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('message_id', wamid)
    .eq('conversation_id', conversationId)
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('[wamid] exact lookup failed:', error.message)
    return null
  }
  if (data?.id) return data.id

  const key = wamidKey(wamid)
  if (!key) return null

  const { data: recent, error: scanError } = await supabase
    .from('messages')
    .select('id, message_id')
    .eq('conversation_id', conversationId)
    .like('message_id', 'wamid.%')
    .order('created_at', { ascending: false })
    .limit(KEY_SCAN_LIMIT)
  if (scanError) {
    console.error('[wamid] key scan failed:', scanError.message)
    return null
  }
  const hit = (recent ?? []).find(
    (m: { message_id: string }) => wamidKey(m.message_id) === key
  )
  return hit?.id ?? null
}
