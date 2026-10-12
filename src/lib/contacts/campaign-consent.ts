// ============================================================
// Per-contact messaging permissions.
//
//   allow_campaign             (047) — broadcasts / campaigns.
//   allow_api_templates        (048) — templates via the public API
//                                      and the Shopify webhook.
//   allow_automation_templates (048) — templates sent by automations.
//
// All default to TRUE; only an explicit FALSE blocks. Manual inbox
// sends, free-form replies and system messages ignore them.
// ============================================================

/** Recipient error recorded when the engine skips an opted-out contact. */
export const OPTED_OUT_MESSAGE = 'Contact opted out of campaigns'

/**
 * Whether a contact may receive campaigns. A missing value (a row read
 * before migration 047 ran) counts as allowed — the column's default.
 */
export function canReceiveCampaign(
  contact: { allow_campaign?: boolean | null } | null | undefined,
): boolean {
  return contact?.allow_campaign !== false
}

export const API_TEMPLATES_BLOCKED_MESSAGE =
  'Contact has turned off API template messages (allow_api_templates is false)'
export const AUTOMATION_TEMPLATES_BLOCKED_MESSAGE =
  'Contact has turned off automation template messages (allow_automation_templates is false)'

/** Whether the public API / Shopify integration may send this contact a template. */
export function canReceiveApiTemplate(
  contact: { allow_api_templates?: boolean | null } | null | undefined,
): boolean {
  return contact?.allow_api_templates !== false
}

/** Whether an automation rule may send this contact a template. */
export function canReceiveAutomationTemplate(
  contact: { allow_automation_templates?: boolean | null } | null | undefined,
): boolean {
  return contact?.allow_automation_templates !== false
}

/**
 * Parse a user-supplied allow_campaign value (API body, CSV cell).
 * Accepts booleans and the usual spellings — true/false, yes/no, 1/0,
 * on/off, opt-in/opt-out — case-insensitively. Anything else is
 * `undefined` so the caller can reject it or leave the field alone.
 */
export function parseAllowCampaign(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase().replace(/[\s_-]/g, '')
  if (['true', 'yes', 'y', '1', 'on', 'optin', 'allow', 'allowed'].includes(v)) return true
  if (['false', 'no', 'n', '0', 'off', 'optout', 'block', 'blocked'].includes(v)) return false
  return undefined
}
