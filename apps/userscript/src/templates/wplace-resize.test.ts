// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { resizeWplaceImage } from './wplace-resize.js'

const source = () =>
  new ImageData(
    new Uint8ClampedArray([
      10, 11, 12, 0, 20, 21, 22, 15, 30, 31, 32, 16, 40, 41, 42, 127, 50, 51, 52, 128, 60, 61, 62,
      254, 70, 71, 72, 255, 80, 81, 82, 255,
    ]),
    4,
    2,
  )

describe('Wplace nearest-neighbor sampling', () => {
  it('samples floor coordinates rather than pixel centres when shrinking', async () => {
    const image = source()
    const result = await resizeWplaceImage(image, 3, 1)
    expect([...result.data]).toEqual([...image.data.slice(0, 12)])
  })

  it('copies exact RGBA values at non-integer enlargement ratios on both axes', async () => {
    const image = source()
    const result = await resizeWplaceImage(image, 6, 3)
    const selected = [0, 0, 1, 2, 2, 3, 0, 0, 1, 2, 2, 3, 4, 4, 5, 6, 6, 7]
    expect([...result.data]).toEqual(
      selected.flatMap((pixel) => [...image.data.slice(pixel * 4, pixel * 4 + 4)]),
    )
  })

  it('retains the source for an identity resize', async () => {
    const image = source()
    expect(await resizeWplaceImage(image, 4, 2)).toBe(image)
  })
})
