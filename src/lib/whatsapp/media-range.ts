/**
 * Parse a single-range `bytes=` header. Returns null when absent or not
 * a form we handle (caller then serves the full body), 'unsatisfiable'
 * when the range lies outside the file.
 */
export function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === '' && match[2] === '')) return null

  let start: number
  let end: number
  if (match[1] === '') {
    // Suffix range: last N bytes.
    const suffix = parseInt(match[2], 10)
    if (suffix === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = parseInt(match[1], 10)
    end = match[2] === '' ? size - 1 : Math.min(parseInt(match[2], 10), size - 1)
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}
