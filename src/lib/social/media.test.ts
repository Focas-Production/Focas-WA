import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'

import { compressImage, socialMediaMaxBytes } from './media'

const MB = 1024 * 1024

describe('socialMediaMaxBytes', () => {
  afterEach(() => {
    delete process.env.SOCIAL_MEDIA_MAX_MB
  })

  it('defaults to 5 MB', () => {
    expect(socialMediaMaxBytes()).toBe(5 * MB)
  })

  it('honours SOCIAL_MEDIA_MAX_MB', () => {
    process.env.SOCIAL_MEDIA_MAX_MB = '2'
    expect(socialMediaMaxBytes()).toBe(2 * MB)
  })

  it('never exceeds the 16 MB bucket limit', () => {
    process.env.SOCIAL_MEDIA_MAX_MB = '100'
    expect(socialMediaMaxBytes()).toBe(16 * MB)
  })

  it('ignores invalid values', () => {
    process.env.SOCIAL_MEDIA_MAX_MB = 'abc'
    expect(socialMediaMaxBytes()).toBe(5 * MB)
  })
})

describe('compressImage', () => {
  it('shrinks a large image to fit and returns WebP', async () => {
    const png = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .png({ compressionLevel: 0 })
      .toBuffer()
    const ab = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer

    const out = await compressImage(ab, 1280)
    expect(out).not.toBeNull()
    expect(out!.byteLength).toBeLessThan(png.byteLength)
    const meta = await sharp(out!).metadata()
    expect(meta.format).toBe('webp')
    expect(Math.max(meta.width!, meta.height!)).toBe(1280)
  })

  it('returns null for bytes that are not an image', async () => {
    const junk = new TextEncoder().encode('not an image').buffer as ArrayBuffer
    expect(await compressImage(junk, 1280)).toBeNull()
  })
})
