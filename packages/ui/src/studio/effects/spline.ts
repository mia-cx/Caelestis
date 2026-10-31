/** A curve control point: `[input, output]`, each from 0 through 1. */
export type CurvePoint = readonly [number, number]

/** The smallest x step between control points the package accepts. */
export const MIN_CURVE_POINT_GAP = 0.001
export const MAX_CURVE_POINTS = 16

/** A value from a list the caller has already bounded; the fallback is never reached. */
const read = (list: readonly number[], index: number): number => list[index] ?? 0

/**
 * Evaluate the monotone cubic Hermite spline the curves effect applies, with Fritsch–Butland
 * tangents, as Ditherette's `spec/effects/curves.md` defines it. The studio draws with this;
 * Ditherette applies it.
 */
export function evaluateCurve(points: readonly CurvePoint[], value: number): number {
  const last = points.length - 1
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const v = Math.min(read(xs, last), Math.max(read(xs, 0), value))
  if (v === xs[last]) return read(ys, last)
  const h = xs.slice(1).map((x, k) => x - read(xs, k))
  const d = h.map((width, k) => (read(ys, k + 1) - read(ys, k)) / width)
  const tangentAt = (k: number): number => {
    if (k === 0) return read(d, 0)
    if (k === last) return read(d, last - 1)
    return tangent(read(d, k - 1), read(d, k), read(h, k - 1), read(h, k))
  }
  const k = xs.findIndex((x, index) => index > 0 && x > v) - 1
  const [m0, m1, width, slope] = [tangentAt(k), tangentAt(k + 1), read(h, k), read(d, k)]
  const s = v - read(xs, k)
  const c2 = (3 * slope - 2 * m0 - m1) / width
  const c3 = (m0 + m1 - 2 * slope) / (width * width)
  return read(ys, k) + s * (m0 + s * (c2 + s * c3))
}

/** The Fritsch–Butland tangent between two secants, zero at a turning point. */
export function tangent(before: number, after: number, widthBefore: number, widthAfter: number) {
  if (before * after <= 0) return 0
  const w1 = 2 * widthAfter + widthBefore
  const w2 = widthAfter + 2 * widthBefore
  return (w1 + w2) / (w1 / before + w2 / after)
}

/**
 * Evaluate the cyclic spline an arbitrary XY curve uses on a hue x axis, as Ditherette's
 * `spec/effects/channel_curve.md` defines it. Points run from x 0 to x 1 with the same y at both,
 * the seam's tangent joins the last and first segments, and x wraps.
 */
export function evaluatePeriodicCurve(points: readonly CurvePoint[], value: number): number {
  const last = points.length - 1
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const width = (k: number): number => read(xs, k + 1) - read(xs, k)
  const secant = (k: number): number => (read(ys, k + 1) - read(ys, k)) / width(k)
  const seam = tangent(secant(last - 1), secant(0), width(last - 1), width(0))
  const tangentAt = (k: number): number =>
    k === 0 || k === last ? seam : tangent(secant(k - 1), secant(k), width(k - 1), width(k))
  const x = ((value % 1) + 1) % 1
  let k = xs.findIndex((px, index) => index > 0 && x < px) - 1
  if (k < 0) k = last - 1
  const [m0, m1, h, slope] = [tangentAt(k), tangentAt(k + 1), width(k), secant(k)]
  const s = x - read(xs, k)
  const c2 = (3 * slope - 2 * m0 - m1) / h
  const c3 = (m0 + m1 - 2 * slope) / (h * h)
  return read(ys, k) + s * (m0 + s * (c2 + s * c3))
}

/**
 * Evaluate a closed sequence on a wrapping axis, as a two-input curve's hue axis does:
 * `positions` rise within [0, 1) with no duplicate seam, and the last knot joins the first one turn
 * later. Every tangent uses its wrapped neighbours' secants.
 */
export function evaluateClosedCurve(
  positions: readonly number[],
  values: readonly number[],
  value: number,
): number {
  const n = positions.length
  const at = (k: number): number => read(positions, k % n) + Math.floor(k / n)
  const secant = (k: number): number =>
    (read(values, (k + 1) % n) - read(values, k % n)) / (at(k + 1) - at(k))
  const width = (k: number): number => at(k + 1) - at(k)
  const tangentAt = (k: number): number =>
    tangent(secant((k + n - 1) % n), secant(k % n), width((k + n - 1) % n), width(k % n))
  let x = ((value % 1) + 1) % 1
  if (x < read(positions, 0)) x += 1
  let k = n - 1
  for (let index = 0; index < n - 1; index++) if (x >= at(index) && x < at(index + 1)) k = index
  const [m0, m1, h, slope] = [tangentAt(k), tangentAt(k + 1), width(k), secant(k)]
  const s = x - at(k)
  const c2 = (3 * slope - 2 * m0 - m1) / h
  const c3 = (m0 + m1 - 2 * slope) / (h * h)
  return read(values, k) + s * (m0 + s * (c2 + s * c3))
}
