import { describe, expect, it } from 'vitest'
import {
  BLANK,
  decodeMismatchMask,
  encodeMismatchMask,
  MATCH,
  mismatchClassAt,
  WRONG,
} from './mismatch-mask.js'

describe('mismatch mask', () => {
  it('round-trips four classifications per byte within its tile rectangle', () => {
    const encoded = encodeMismatchMask(
      { left: 12, top: 34, width: 3, height: 2 },
      new Uint8Array([MATCH, WRONG, BLANK, WRONG, MATCH, BLANK]),
    )
    const mask = decodeMismatchMask(encoded)

    expect(mask).not.toBeNull()
    expect(mask && mismatchClassAt(mask, 12, 34)).toBe(MATCH)
    expect(mask && mismatchClassAt(mask, 13, 34)).toBe(WRONG)
    expect(mask && mismatchClassAt(mask, 14, 34)).toBe(BLANK)
    expect(mask && mismatchClassAt(mask, 14, 35)).toBe(BLANK)
    expect(mask && mismatchClassAt(mask, 11, 34)).toBeNull()
  })

  it('packs every pixel of an odd-sized rectangle in order, with the last byte partially filled', () => {
    const rect = { left: 1, top: 2, width: 5, height: 3 }
    const classes = [MATCH, WRONG, BLANK] as const
    const classifications = Uint8Array.from(
      { length: 15 },
      (_, index) => classes[index % 3] ?? MATCH,
    )
    const encoded = encodeMismatchMask(rect, classifications)
    const mask = decodeMismatchMask(encoded)

    expect(encoded.byteLength).toBe(12 + 4)
    expect(mask).not.toBeNull()
    for (let index = 0; index < 15; index += 1) {
      const x = rect.left + (index % rect.width)
      const y = rect.top + Math.floor(index / rect.width)
      expect(mask && mismatchClassAt(mask, x, y)).toBe(classes[index % 3])
    }
    // The three unused slots of the final byte stay zero so the artifact is byte-stable.
    expect((encoded[15] ?? 0) >> 6).toBe(0)
    expect(() =>
      encodeMismatchMask(
        rect,
        Uint8Array.from({ length: 15 }, (_, index) => (index === 14 ? 3 : 0)),
      ),
    ).toThrow(RangeError)
  })

  it('rejects truncated and unknown mask formats', () => {
    const encoded = encodeMismatchMask(
      { left: 0, top: 0, width: 1, height: 1 },
      new Uint8Array([WRONG]),
    )
    expect(decodeMismatchMask(encoded.subarray(0, encoded.length - 1))).toBeNull()
    encoded[0] = 0
    expect(decodeMismatchMask(encoded)).toBeNull()
    const unknown = encodeMismatchMask(
      { left: 0, top: 0, width: 1, height: 1 },
      new Uint8Array([WRONG]),
    )
    unknown[12] = 3
    expect(decodeMismatchMask(unknown)).toBeNull()
  })
})
