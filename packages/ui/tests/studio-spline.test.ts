import { describe, expect, it } from 'vitest'
import {
  type CurvePoint,
  evaluateCurve,
  evaluatePeriodicCurve,
} from '../src/studio/effects/spline.js'

describe('evaluateCurve', () => {
  it('is the identity for the neutral curve', () => {
    for (const v of [0, 0.2, 0.5, 0.93, 1])
      expect(
        evaluateCurve(
          [
            [0, 0],
            [1, 1],
          ],
          v,
        ),
      ).toBe(v)
  })

  it('passes through every point, never overshoots, and is flat past the ends', () => {
    const points: CurvePoint[] = [
      [0.1, 0.05],
      [0.4, 0.6],
      [0.6, 0.62],
      [0.9, 0.95],
    ]
    for (const [x, y] of points) expect(evaluateCurve(points, x)).toBeCloseTo(y, 12)
    for (let v = 0.1; v <= 0.9; v += 0.01) {
      const y = evaluateCurve(points, v)
      expect(y).toBeGreaterThanOrEqual(0.05)
      expect(y).toBeLessThanOrEqual(0.95)
    }
    expect(evaluateCurve(points, 0)).toBe(0.05)
    expect(evaluateCurve(points, 1)).toBe(0.95)
  })
})

describe('evaluatePeriodicCurve', () => {
  const bump: CurvePoint[] = [
    [0, 0.5],
    [0.3, 0.9],
    [0.7, 0.2],
    [1, 0.5],
  ]

  it('passes through every point and wraps x', () => {
    for (const [x, y] of bump) expect(evaluatePeriodicCurve(bump, x)).toBeCloseTo(y, 12)
    expect(evaluatePeriodicCurve(bump, 1.3)).toBeCloseTo(0.9, 12)
    expect(evaluatePeriodicCurve(bump, -0.3)).toBeCloseTo(0.2, 12)
  })

  it('meets itself smoothly at the seam', () => {
    const step = 1e-6
    const slopeBefore =
      (evaluatePeriodicCurve(bump, 1 - step) - evaluatePeriodicCurve(bump, 1 - 2 * step)) / step
    const slopeAfter =
      (evaluatePeriodicCurve(bump, 2 * step) - evaluatePeriodicCurve(bump, step)) / step
    expect(slopeAfter).toBeCloseTo(slopeBefore, 3)
  })

  it('stays flat for the neutral curve', () => {
    for (const x of [0, 0.25, 0.5, 0.99])
      expect(
        evaluatePeriodicCurve(
          [
            [0, 0.5],
            [1, 0.5],
          ],
          x,
        ),
      ).toBe(0.5)
  })
})
