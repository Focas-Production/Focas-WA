// ============================================================
// Shared pieces of the WhatsApp-OTP manual-credit approval flow —
// used by the request route (create + send) and the manual-credit
// route (redeem).
//
// The approver is configured by ENVIRONMENT, not the database:
//
//   WALLET_APPROVER_PHONE — WhatsApp number (with country code,
//     e.g. 917305504500) that receives approval codes. Setting it
//     arms the gate for EVERY workspace on this deployment; unset
//     it to return manual credits to the ungated legacy behavior.
//   WALLET_APPROVER_NAME  — optional display name ("Venkat");
//     shown in the UI and stamped into the ledger description.
//
// Changing the approver therefore requires server/env access — that
// access is the security boundary (an owner session alone cannot
// repoint approvals at a phone it controls).
//
// Fail-closed rule: a NON-EMPTY but invalid WALLET_APPROVER_PHONE
// still arms the gate (requests then fail with a config error).
// A misconfiguration must never silently disable approvals.
// ============================================================

import { createHmac } from 'node:crypto'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'

/**
 * The pre-approved UTILITY template that carries the approval code.
 * Utility (not authentication) on purpose: authentication-category
 * templates have Meta-fixed wording and cannot name the amount or
 * workspace — and the whole point of this gate is that the approver
 * sees exactly what they are approving. Live body:
 *
 *   Update on your wallet for workspace {{2}}: a manual credit of
 *   {{1}} is awaiting your review. Request ID: WCR-{{3}}. This
 *   request will expire automatically in 5 minutes if no action is
 *   taken.
 *
 * The code is styled as "Request ID: WCR-<code>" because Meta's
 * classifier instantly rejects UTILITY bodies that read like OTP
 * delivery ("Code: {{3}} … share it" → INCORRECT_CATEGORY, must be
 * AUTHENTICATION — which cannot show the amount). Param order stays
 * [amount, workspace, code]. The template must exist and be
 * APPROVED on each workspace's WABA.
 */
export const WALLET_APPROVAL_TEMPLATE = 'wallet_credit_approval'

export const CREDIT_OTP_TTL_MS = 5 * 60 * 1000
export const CREDIT_OTP_MAX_ATTEMPTS = 5

// Manual loads mirror the online top-up ceiling; the single source
// for both the request route and the ungated redeem path so the two
// can never drift apart.
export const MANUAL_CREDIT_MIN_PAISE = 100
export const MANUAL_CREDIT_MAX_PAISE = 500000 * 100

/** Parse + bounds-check an amount; returns paise or an error string. */
export function parseAmountPaise(
  raw: unknown,
): { ok: true; amountPaise: number } | { ok: false; error: string } {
  const amountPaise = Math.round(Number(raw))
  if (
    !Number.isFinite(amountPaise) ||
    amountPaise < MANUAL_CREDIT_MIN_PAISE ||
    amountPaise > MANUAL_CREDIT_MAX_PAISE
  ) {
    return {
      ok: false,
      error: `Amount must be between ₹${MANUAL_CREDIT_MIN_PAISE / 100} and ₹${MANUAL_CREDIT_MAX_PAISE / 100}.`,
    }
  }
  return { ok: true, amountPaise }
}

export interface ApproverConfig {
  /** Gate armed? True whenever WALLET_APPROVER_PHONE is non-empty. */
  configured: boolean
  /** Sanitized E.164 phone, or null when unset/invalid. */
  phone: string | null
  name: string
}

export function getApproverConfig(): ApproverConfig {
  const raw = (process.env.WALLET_APPROVER_PHONE ?? '').trim()
  const name = (process.env.WALLET_APPROVER_NAME ?? '').trim() || 'Approver'
  if (!raw) return { configured: false, phone: null, name }
  const phone = sanitizePhoneForMeta(raw)
  return { configured: true, phone: isValidE164(phone) ? phone : null, name }
}

export function hashApprovalCode(requestId: string, code: string): string {
  // Keyed with the app secret and bound to the request row, so a
  // leaked database can't be brute-forced offline against plain
  // SHA-256 of a 6-digit space.
  return createHmac('sha256', process.env.ENCRYPTION_KEY!)
    .update(`${requestId}:${code}`)
    .digest('hex')
}
