// ------------------------------------------------------------
// Time-of-day window check for the `time_of_day` condition.
//
// The window ("HH:mm-HH:mm", may cross midnight like "18:00-09:00") is
// evaluated in the condition's own IANA `timezone` so "after hours" means
// the business's local hours, not the server's clock (servers usually run
// UTC). Conditions saved before the timezone setting existed have none and
// keep the old behaviour: the server's local clock.
// ------------------------------------------------------------

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Minutes since local midnight at `now`, in `timeZone` (server-local when
 *  absent or invalid). */
export function minutesInTimeZone(now: Date, timeZone?: string): number {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(now)
      const h = Number(parts.find((p) => p.type === 'hour')?.value)
      const m = Number(parts.find((p) => p.type === 'minute')?.value)
      if (Number.isFinite(h) && Number.isFinite(m)) return (h % 24) * 60 + m
    } catch {
      // Invalid zone — fall through to the server clock.
    }
  }
  return now.getHours() * 60 + now.getMinutes()
}

function parseHHmm(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** True when `now` falls inside the "HH:mm-HH:mm" window (start inclusive,
 *  end exclusive). An empty/malformed window is never matched. */
export function isWithinTimeWindow(
  window: string | undefined,
  now: Date,
  timeZone?: string,
): boolean {
  const [from, to] = (window ?? '').split('-')
  if (!from || !to) return false
  const mins = minutesInTimeZone(now, timeZone)
  const f = parseHHmm(from)
  const t = parseHHmm(to)
  return f <= t ? mins >= f && mins < t : mins >= f || mins < t
}
