import { describe, it, expect } from 'vitest'
import { parseRange } from './media-range'

describe('parseRange', () => {
  it('returns null without a header or for unsupported forms', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=-', 100)).toBeNull()
    expect(parseRange('bytes=0-1,5-9', 100)).toBeNull()
    expect(parseRange('items=0-1', 100)).toBeNull()
  })

  it('parses open-ended and bounded ranges', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
  })

  it('clamps the end to the file size', () => {
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
  })

  it('parses suffix ranges', () => {
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
  })

  it('flags unsatisfiable ranges', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=20-10', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
  })
})
