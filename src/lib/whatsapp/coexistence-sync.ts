import { requestSmbAppDataSync, type SmbAppDataSyncType } from './meta-api'

export interface CoexistenceSyncResult {
  /** Sync types Meta accepted — their data arrives on the webhook. */
  requested: SmbAppDataSyncType[]
  /** One readable line per sync type Meta rejected. */
  errors: string[]
}

/**
 * Ask Meta to replay a coexistence number's WhatsApp Business app
 * contacts, then its chat history, to our webhook (handled there as
 * `smb_app_state_sync` / `history` events).
 *
 * Contacts go first, as Meta's onboarding guide orders them. Each type
 * is requested independently so one rejection (e.g. contacts were
 * already synced once) doesn't block the other. Never throws.
 */
export async function requestCoexistenceSync(args: {
  phoneNumberId: string
  accessToken: string
}): Promise<CoexistenceSyncResult> {
  const result: CoexistenceSyncResult = { requested: [], errors: [] }
  const steps: Array<[SmbAppDataSyncType, string]> = [
    ['smb_app_state_sync', 'Contacts sync'],
    ['history', 'Chat history sync'],
  ]
  for (const [syncType, label] of steps) {
    try {
      await requestSmbAppDataSync({ ...args, syncType })
      result.requested.push(syncType)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[coexistence-sync] ${syncType} request failed:`, message)
      result.errors.push(`${label} failed: ${message}`)
    }
  }
  return result
}
