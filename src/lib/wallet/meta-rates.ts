// ============================================================
// Meta WhatsApp per-message rate card — the single source of truth
// for what a template send debits from the wallet.
//
// Rates are Meta's ACTUAL prices, deliberately NOT configurable (no
// DB table, no settings UI): the wallet exists to mirror real Meta
// spend, so an edited rate would only make the balance drift from
// the Meta invoice.
//
// Values are India (IN) rates from Meta's published rate card under
// per-message pricing (effective 2025-07-01), in PAISE per message:
//   marketing       ₹0.7846 → 78.46
//   utility         ₹0.1150 → 11.50
//   authentication  ₹0.1150 → 11.50
// Utility/authentication messages delivered inside an open customer-
// service window are free on Meta's side; we still see them as
// template sends and charge the listed rate — acceptable rounding
// toward safety (never undercharges a billable send).
//
// When Meta revises the rate card, update these constants (source:
// https://developers.facebook.com/docs/whatsapp/pricing/ — download
// the rate card CSV) and note the change in CHANGELOG.md.
// ============================================================

import type { WalletChargeCategory } from './wallet'

export const META_RATE_CARD_EFFECTIVE = '2025-07-01'

/** Paise per template message, by Meta category (India rate card). */
export const META_RATES_PAISE: Record<WalletChargeCategory, number> = {
  marketing: 78.46,
  utility: 11.5,
  authentication: 11.5,
}

export function getMetaRatePaise(category: WalletChargeCategory): number {
  return META_RATES_PAISE[category]
}
