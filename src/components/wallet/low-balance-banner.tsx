"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { formatPaiseINR } from "@/lib/currency";

// Per-tab dismissal — the banner comes back in a new tab/session so a
// low wallet is never hidden for long.
const DISMISS_KEY = "wallet-low-banner-dismissed";

/**
 * App-wide amber bar shown while the wallet is below its low-balance
 * threshold (₹100 by default). Checks on mount and whenever the tab
 * becomes visible again, so a top-up done elsewhere clears it.
 */
export function LowBalanceBanner() {
  const t = useTranslations("WalletBanner");
  const [low, setLow] = useState<{ balance: number; threshold: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch("/api/wallet");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        try {
          setDismissed(sessionStorage.getItem(DISMISS_KEY) === "1");
        } catch {
          // Storage blocked — the banner just can't be dismissed.
        }
        const balance = Number(data.balance_paise ?? 0);
        const threshold = Number(data.low_balance_threshold_paise ?? 0);
        setLow(balance < threshold ? { balance, threshold } : null);
      } catch {
        // Best-effort; the Wallet page still shows its own warning.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };

    void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!low || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-600 lg:px-6 dark:text-amber-400">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1">
        {t("message", {
          balance: formatPaiseINR(low.balance),
          threshold: formatPaiseINR(low.threshold),
        })}
      </p>
      <Link
        href="/settings?tab=wallet"
        className="shrink-0 font-medium underline underline-offset-2"
      >
        {t("topUp")}
      </Link>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("dismiss")}
        className="shrink-0 rounded p-0.5 hover:bg-amber-500/20"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
