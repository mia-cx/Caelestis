import { describe, expect, it } from 'vitest'
import { nativeAlliancePlacements } from './native-alliance.js'

/** One Wplace HQ template as `GET /alliance/templates` returns it: `x`/`y` count from the canvas's top-left. */
const body = (x: number, y: number) => ({
  templates: [
    {
      id: 7,
      name: 'Logo',
      width: 10,
      height: 10,
      locations: [{ target: 'headquarters', x, y, width: 10, height: 10 }],
    },
  ],
})

/** Wplace's signed HQ bounds for one upgrade tier, half-open as Caelestis keeps them. */
const hq = (size: number) => ({
  minX: -size / 2,
  minY: -size / 2,
  maxX: size / 2,
  maxY: size / 2,
})

describe('native alliance HQ placements', () => {
  it.each([
    { size: 250, x: 0, y: 0, origin: [-125, -125] },
    { size: 1_000, x: 100, y: 200, origin: [-400, -300] },
    { size: 1_000, x: 990, y: 990, origin: [490, 490] },
    { size: 2_000, x: 1_500, y: 40, origin: [500, -960] },
  ])('lands where Wplace draws it on a $size HQ at ($x, $y)', ({ size, x, y, origin }) => {
    const [placement] = nativeAlliancePlacements(body(x, y), { target: 'headquarters' }, hq(size))
    expect([placement?.originX, placement?.originY]).toEqual(origin)
  })

  it('refuses a placement past the edge of a smaller HQ', () => {
    expect(() =>
      nativeAlliancePlacements(body(995, 0), { target: 'headquarters' }, hq(1_000)),
    ).toThrow('outside its canvas')
  })
})
