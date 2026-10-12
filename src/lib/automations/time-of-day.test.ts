import { describe, expect, it } from 'vitest'

import { isValidTimeZone, isWithinTimeWindow, minutesInTimeZone } from './time-of-day'

// 2026-10-12 13:00 UTC == 18:30 in Asia/Kolkata (UTC+5:30).
const NOW = new Date('2026-10-12T13:00:00Z')

describe('minutesInTimeZone', () => {
  it('reads the wall clock in the given zone', () => {
    expect(minutesInTimeZone(NOW, 'UTC')).toBe(13 * 60)
    expect(minutesInTimeZone(NOW, 'Asia/Kolkata')).toBe(18 * 60 + 30)
  })

  it('falls back to the server clock for a missing or invalid zone', () => {
    const local = NOW.getHours() * 60 + NOW.getMinutes()
    expect(minutesInTimeZone(NOW)).toBe(local)
    expect(minutesInTimeZone(NOW, 'Not/AZone')).toBe(local)
  })
})

describe('isWithinTimeWindow', () => {
  it('evaluates an over-midnight window in the business timezone', () => {
    // 18:30 IST is after hours; 13:00 UTC is not.
    expect(isWithinTimeWindow('18:00-09:00', NOW, 'Asia/Kolkata')).toBe(true)
    expect(isWithinTimeWindow('18:00-09:00', NOW, 'UTC')).toBe(false)
  })

  it('handles same-day windows with an exclusive end', () => {
    expect(isWithinTimeWindow('09:00-18:30', NOW, 'Asia/Kolkata')).toBe(false)
    expect(isWithinTimeWindow('09:00-18:31', NOW, 'Asia/Kolkata')).toBe(true)
  })

  it('never matches a malformed window', () => {
    expect(isWithinTimeWindow('', NOW, 'UTC')).toBe(false)
    expect(isWithinTimeWindow('18:00-', NOW, 'UTC')).toBe(false)
    expect(isWithinTimeWindow(undefined, NOW, 'UTC')).toBe(false)
  })
})

describe('isValidTimeZone', () => {
  it('accepts IANA names and rejects garbage', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true)
    expect(isValidTimeZone('Not/AZone')).toBe(false)
  })
})
