import { type PresenceRect, rectsIntersect } from './presence.js'
import {
  cubicPoint,
  insideRing,
  MAX_RASTER_BITS,
  MAX_REGION_SHAPE_EXTENT,
  type PathNode,
  type PathShape,
  type Point,
  type RasterShape,
  type RegionShape,
  type RegionShapePixels,
  rasterShapeFrom,
  regionShapeBounds,
  regionShapeOutline,
  regionShapePixels,
  segmentParameter,
} from './region-shape.js'
import { WORLD_PIXELS } from './tiles.js'

/**
 * The editing maths behind claim mode: shape transforms, selection hit tests, path anchors, and
 * the pencil's and eraser's pixel sets. Pure functions over `RegionShape`; the editor owns the
 * state. Membership is always the shared rasteriser's, by pixel centre.
 */

/** Two corners of a box, in either order: a marquee or a bounding box as dragged. */
export interface CornerBox {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/** The bezier control distance that makes four cubic segments a near-perfect ellipse. */
const ELLIPSE_KAPPA = 0.5522847498

const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)))

/** Whether a point lies inside a rect, its left and top edges included. */
export const rectContains = (rect: PresenceRect, point: Point): boolean =>
  point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.w && point.y < rect.y + rect.h

/** The whole world pixel a fractional canvas coordinate falls in, kept on the canvas. */
export const worldPixel = (value: number): number =>
  Math.min(WORLD_PIXELS - 1, Math.max(0, Math.floor(value)))

const degrees = (dx: number, dy: number): number =>
  ((Math.round((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360

/** Whether a shape is inside a marquee: its bounding box touches the box, as in Illustrator. */
export const inMarquee = (shape: RegionShape, box: CornerBox): boolean => {
  const bounds = regionShapeBounds(shape)
  return (
    bounds.x <= Math.max(box.x0, box.x1) &&
    bounds.x + bounds.w >= Math.min(box.x0, box.x1) &&
    bounds.y <= Math.max(box.y0, box.y1) &&
    bounds.y + bounds.h >= Math.min(box.y0, box.y1)
  )
}

const orient = (a: Point, b: Point, c: Point): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

const segmentsCross = (a: Point, b: Point, c: Point, d: Point): boolean =>
  orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0

/**
 * Whether a shape is caught by a lasso: a point of its outline lies inside the loop, the loop
 * lies inside the shape, or an outline edge crosses the loop. The last case is what catches a
 * narrow loop drawn across the middle of an edge.
 */
export const inLasso = (shape: RegionShape, ring: readonly Point[]): boolean => {
  if (ring.length < 3) return false
  const outline = regionShapeOutline(shape)
  if (outline.some((point) => insideRing(ring, point.x, point.y))) return true
  const closed = shape.kind !== 'path' || shape.closed
  if (closed && ring.some((point) => insideRing(outline, point.x, point.y))) return true
  const edges = closed ? outline.length : outline.length - 1
  for (let i = 0; i < edges; i++) {
    const a = outline[i] as Point
    const b = outline[(i + 1) % outline.length] as Point
    for (let j = 0; j < ring.length; j++) {
      if (segmentsCross(a, b, ring[j] as Point, ring[(j + 1) % ring.length] as Point)) return true
    }
  }
  return false
}

/** A rectangle or ellipse from two pixels, inclusive of both, capped at the largest allowed side. */
export const boxShape = (
  kind: 'rectangle' | 'ellipse',
  anchor: Point,
  pointer: Point,
): RegionShape => {
  // The moving corner is capped relative to the anchor, so a box dragged too far still
  // contains the pixel the gesture started on.
  const reach = MAX_REGION_SHAPE_EXTENT - 1
  const cx = Math.max(anchor.x - reach, Math.min(anchor.x + reach, pointer.x))
  const cy = Math.max(anchor.y - reach, Math.min(anchor.y + reach, pointer.y))
  return {
    kind,
    x: Math.min(anchor.x, cx),
    y: Math.min(anchor.y, cy),
    w: Math.abs(cx - anchor.x) + 1,
    h: Math.abs(cy - anchor.y) + 1,
  }
}

/** What a new polygon or star takes when there is no shape to keep its counts from. */
export interface RoundShapeOptions {
  readonly sides: number
  readonly points: number
  /** A star's inner radius as a percentage of its outer one. */
  readonly inner: number
}

/**
 * A polygon or star centred on `centre` reaching `pointer`, turned to face it. A resize keeps the
 * counts and inner ratio of `base`; a new shape takes them from `options`.
 */
export const roundShape = (
  kind: 'polygon' | 'star',
  centre: Point,
  pointer: Point,
  options: RoundShapeOptions,
  base?: RegionShape,
): RegionShape => {
  const dx = pointer.x - centre.x
  const dy = pointer.y - centre.y
  // A star's inner radius must sit strictly inside its outer one, so a star is never smaller
  // than two pixels; a polygon can be one.
  const r = clampInt(Math.hypot(dx, dy), kind === 'star' ? 2 : 1, MAX_REGION_SHAPE_EXTENT / 2)
  const rotation = degrees(dx, dy)
  if (kind === 'polygon')
    return {
      kind,
      cx: centre.x,
      cy: centre.y,
      r,
      sides: base?.kind === 'polygon' ? base.sides : options.sides,
      rotation,
    }
  const ratio = base?.kind === 'star' ? base.inner / base.r : options.inner / 100
  return {
    kind,
    cx: centre.x,
    cy: centre.y,
    r,
    inner: starInner(r, r * ratio),
    points: base?.kind === 'star' ? base.points : options.points,
    rotation,
  }
}

/** A star's inner radius, whole and strictly inside its outer radius `r`. */
export const starInner = (r: number, inner: number): number =>
  clampInt(inner, 1, Math.max(1, r - 1))

/**
 * A parametric shape as a closed path with the same pixels, so its anchors can be edited one by
 * one: corners for a rectangle, polygon, or star; four smooth anchors with bezier handles for an
 * ellipse. This is what Illustrator does too: a rectangle is a path with four anchors.
 */
export const toPath = (shape: RegionShape): PathShape => {
  if (shape.kind === 'path') return shape
  if (shape.kind === 'ellipse') {
    const cx = shape.x + shape.w / 2
    const cy = shape.y + shape.h / 2
    const rx = shape.w / 2
    const ry = shape.h / 2
    const kx = rx * ELLIPSE_KAPPA
    const ky = ry * ELLIPSE_KAPPA
    return {
      kind: 'path',
      closed: true,
      width: 0,
      nodes: [
        { x: cx, y: cy - ry, in: { x: cx - kx, y: cy - ry }, out: { x: cx + kx, y: cy - ry } },
        { x: cx + rx, y: cy, in: { x: cx + rx, y: cy - ky }, out: { x: cx + rx, y: cy + ky } },
        { x: cx, y: cy + ry, in: { x: cx + kx, y: cy + ry }, out: { x: cx - kx, y: cy + ry } },
        { x: cx - rx, y: cy, in: { x: cx - rx, y: cy + ky }, out: { x: cx - rx, y: cy - ky } },
      ],
    }
  }
  return {
    kind: 'path',
    closed: true,
    width: 0,
    nodes: regionShapeOutline(shape).map((point) => ({ x: point.x, y: point.y })),
  }
}

/** The anchors the direct-selection tool shows for a shape. */
export const anchorsOf = (shape: RegionShape): readonly Point[] => toPath(shape).nodes

/** Every anchor and handle of a path moved through `move`. */
const mapNodes = (path: PathShape, move: (point: Point) => Point): PathShape => ({
  ...path,
  nodes: path.nodes.map((node) => ({
    ...move(node),
    ...(node.in === undefined ? {} : { in: move(node.in) }),
    ...(node.out === undefined ? {} : { out: move(node.out) }),
  })),
})

const rotatePoint = (point: Point, centre: Point, radians: number): Point => {
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const dx = point.x - centre.x
  const dy = point.y - centre.y
  return { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos }
}

/**
 * A shape turned by `radians` about `centre`. Polygons and stars turn in place, in whole
 * degrees; anything else becomes a path first, since a rectangle or ellipse has no angle.
 */
export const rotateShape = (shape: RegionShape, centre: Point, radians: number): RegionShape => {
  if (shape.kind === 'polygon' || shape.kind === 'star') {
    const turned = Math.round((radians * 180) / Math.PI)
    return { ...shape, rotation: (((shape.rotation + turned) % 360) + 360) % 360 }
  }
  return mapNodes(toPath(shape), (point) => rotatePoint(point, centre, radians))
}

/** The box the selection tool's scale handles sit on: the geometry itself, no stroke padding. */
const scaleBox = (shape: RegionShape): CornerBox => {
  if (shape.kind !== 'path') {
    const bounds = regionShapeBounds(shape)
    return { x0: bounds.x, y0: bounds.y, x1: bounds.x + bounds.w, y1: bounds.y + bounds.h }
  }
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const node of shape.nodes) {
    for (const point of [node, node.in, node.out]) {
      if (point === undefined) continue
      x0 = Math.min(x0, point.x)
      y0 = Math.min(y0, point.y)
      x1 = Math.max(x1, point.x)
      y1 = Math.max(y1, point.y)
    }
  }
  return { x0, y0, x1, y1 }
}

/** The scale box's corners, clockwise from the top left. */
export const scaleBoxCorners = (shape: RegionShape): Point[] => {
  const { x0, y0, x1, y1 } = scaleBox(shape)
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]
}

/**
 * A path or raster scaled about a fixed point, Illustrator's bounding-box handles. Paths scale
 * their anchors and handles; a raster is resampled nearest-neighbour into its new box, so its
 * pixels stay crisp. Null when the raster would grow past what one may hold.
 */
export const scaleShape = (
  shape: PathShape | RasterShape,
  anchor: Point,
  sx: number,
  sy: number,
): RegionShape | null => {
  if (shape.kind === 'path')
    return mapNodes(shape, (point) => ({
      x: anchor.x + (point.x - anchor.x) * sx,
      y: anchor.y + (point.y - anchor.y) * sy,
    }))
  const source = regionShapePixels(shape)
  const left = anchor.x + (shape.x - anchor.x) * sx
  const right = anchor.x + (shape.x + shape.w - anchor.x) * sx
  const top = anchor.y + (shape.y - anchor.y) * sy
  const bottom = anchor.y + (shape.y + shape.h - anchor.y) * sy
  const x = Math.max(0, Math.round(Math.min(left, right)))
  const y = Math.max(0, Math.round(Math.min(top, bottom)))
  const w = Math.max(1, Math.round(Math.abs(right - left)))
  const h = Math.max(1, Math.round(Math.abs(bottom - top)))
  if (w * h > MAX_RASTER_BITS) return null
  const mask = new Uint8Array(w * h)
  let count = 0
  for (let row = 0; row < h; row++) {
    const sy0 = Math.min(shape.h - 1, Math.floor(((row + 0.5) / h) * shape.h))
    const srcRow = sy < 0 ? shape.h - 1 - sy0 : sy0
    for (let column = 0; column < w; column++) {
      const sx0 = Math.min(shape.w - 1, Math.floor(((column + 0.5) / w) * shape.w))
      const srcColumn = sx < 0 ? shape.w - 1 - sx0 : sx0
      if (source.mask[srcRow * shape.w + srcColumn] === 1) {
        mask[row * w + column] = 1
        count++
      }
    }
  }
  return rasterShapeFrom({ rect: { x, y, w, h }, mask, count })
}

/* Paths: the pen, the anchor-point tool, and adding or deleting anchors. */

/** Samples per segment when looking for the closest point on a path. */
const SEGMENT_SAMPLES = 48
/** Halvings of the sample step around the best sample. */
const REFINE_ROUNDS = 12

/** The control points of the segment from node `index` to the next, straight or curved. */
const controls = (
  nodes: readonly PathNode[],
  index: number,
): { from: PathNode; to: PathNode; c1: Point; c2: Point; curved: boolean } => {
  const from = nodes[index] as PathNode
  const to = nodes[(index + 1) % nodes.length] as PathNode
  return {
    from,
    to,
    c1: from.out ?? from,
    c2: to.in ?? to,
    curved: from.out !== undefined || to.in !== undefined,
  }
}

/** The rubber band the pen shows from its last anchor towards the pointer. */
export const rubberBand = (last: PathNode, pointer: Point, steps = 16): Point[] =>
  Array.from({ length: steps + 1 }, (_, step) =>
    cubicPoint(last, last.out ?? last, pointer, pointer, step / steps),
  )

export interface PathHit {
  /** The segment: from node `index` to the next. */
  readonly index: number
  readonly t: number
  readonly at: Point
  readonly distance: number
}

/** The closest point of one segment to `point`: exact on a straight one, sampled on a curve. */
const nearestOnSegment = (nodes: readonly PathNode[], index: number, point: Point): PathHit => {
  const { from, to, c1, c2, curved } = controls(nodes, index)
  const hit = (t: number, at: Point): PathHit => ({
    index,
    t,
    at,
    distance: Math.hypot(at.x - point.x, at.y - point.y),
  })
  if (!curved) {
    const t = segmentParameter(point, from, to)
    return hit(t, lerp(from, to, t))
  }
  let best = hit(0, cubicPoint(from, c1, c2, to, 0))
  for (let step = 1; step <= SEGMENT_SAMPLES; step++) {
    const t = step / SEGMENT_SAMPLES
    const candidate = hit(t, cubicPoint(from, c1, c2, to, t))
    if (candidate.distance < best.distance) best = candidate
  }
  // Refine around the best sample: halve the step and keep whichever side comes closer.
  let span = 1 / SEGMENT_SAMPLES
  for (let round = 0; round < REFINE_ROUNDS; round++) {
    span /= 2
    for (const t of [best.t - span, best.t + span]) {
      if (t < 0 || t > 1) continue
      const candidate = hit(t, cubicPoint(from, c1, c2, to, t))
      if (candidate.distance < best.distance) best = candidate
    }
  }
  return best
}

/** The closest point on a path to `point`, or null for a path with no segments. */
export const nearestOnPath = (
  nodes: readonly PathNode[],
  closed: boolean,
  point: Point,
): PathHit | null => {
  const count = closed ? nodes.length : nodes.length - 1
  let best: PathHit | null = null
  for (let index = 0; index < count; index++) {
    const hit = nearestOnSegment(nodes, index, point)
    if (best === null || hit.distance < best.distance) best = hit
  }
  return best
}

/**
 * The path with an anchor inserted on segment `index` at `t`, the curve unchanged: de Casteljau
 * splits a curved segment into two with their own handles; a straight one just gains a corner.
 */
export const insertAnchor = (nodes: readonly PathNode[], index: number, t: number): PathNode[] => {
  const { from, to, c1, c2, curved } = controls(nodes, index)
  const nextIndex = (index + 1) % nodes.length
  if (!curved) {
    const at = lerp(from, to, t)
    const out = [...nodes]
    out.splice(index + 1, 0, { x: at.x, y: at.y })
    return out
  }
  const a = lerp(from, c1, t)
  const b = lerp(c1, c2, t)
  const c = lerp(c2, to, t)
  const d = lerp(a, b, t)
  const e = lerp(b, c, t)
  const at = lerp(d, e, t)
  const out = nodes.map((node, held) =>
    held === index ? { ...node, out: a } : held === nextIndex ? { ...node, in: c } : node,
  )
  out.splice(index + 1, 0, { x: at.x, y: at.y, in: d, out: e })
  return out
}

/** The path without one anchor; its neighbours keep their handles. */
export const removeAnchor = (nodes: readonly PathNode[], index: number): PathNode[] =>
  nodes.filter((_, held) => held !== index)

/** A smooth anchor whose handles point at `towards` and its mirror. */
export const smoothAnchor = (node: Point, towards: Point): PathNode => ({
  x: node.x,
  y: node.y,
  out: towards,
  in: { x: 2 * node.x - towards.x, y: 2 * node.y - towards.y },
})

/** A corner anchor: no handles at all. */
export const cornerAnchor = (node: PathNode): PathNode => ({ x: node.x, y: node.y })

export const isSmooth = (node: PathNode): boolean => node.in !== undefined || node.out !== undefined

/**
 * One part of a path's anchor dragged to `to`. The anchor carries its handles along; a handle
 * mirrors the other one, Illustrator's smooth anchor. `base` is the path as the drag began.
 */
export const moveNode = (
  path: PathShape,
  index: number,
  part: 'anchor' | 'in' | 'out',
  to: Point,
  base: PathShape,
): PathShape => ({
  ...path,
  nodes: path.nodes.map((node, at) => {
    if (at !== index) return node
    const original = base.nodes[index] as PathNode
    if (part === 'anchor') {
      const dx = to.x - original.x
      const dy = to.y - original.y
      return {
        x: to.x,
        y: to.y,
        ...(original.in === undefined
          ? {}
          : { in: { x: original.in.x + dx, y: original.in.y + dy } }),
        ...(original.out === undefined
          ? {}
          : { out: { x: original.out.x + dx, y: original.out.y + dy } }),
      }
    }
    const mirror = { x: 2 * node.x - to.x, y: 2 * node.y - to.y }
    return part === 'in'
      ? { ...node, in: { x: to.x, y: to.y }, out: mirror }
      : { ...node, out: { x: to.x, y: to.y }, in: mirror }
  }),
})

/**
 * An open path turned so that the anchor at `end` (its first or last) is last, ready for the
 * pen to continue from it. Reversing swaps every anchor's in and out handles.
 */
export const orientToContinue = (nodes: readonly PathNode[], end: number): PathNode[] => {
  if (end === nodes.length - 1) return [...nodes]
  return [...nodes].reverse().map((node) => ({
    x: node.x,
    y: node.y,
    ...(node.out === undefined ? {} : { in: node.out }),
    ...(node.in === undefined ? {} : { out: node.in }),
  }))
}

/* Rasters: what the pencil paints and the eraser removes. */

/** Whether `point` lies within `radius` of the segment `a` to `b`. Allocation-free: hot loops. */
const withinSegment = (point: Point, a: Point, b: Point, radius: number): boolean => {
  const t = segmentParameter(point, a, b)
  const dx = a.x + t * (b.x - a.x) - point.x
  const dy = a.y + t * (b.y - a.y) - point.y
  return dx * dx + dy * dy <= radius * radius
}

/**
 * A growing set of canvas pixels, keyed by row-major index over the whole world.
 *
 * A pencil stroke is a set of whole pixels, stamped along the pointer's path with a round tip,
 * and becomes a `pixels` shape. The eraser uses the same stamping to know which pixels to clear.
 */
export class PixelSet {
  private readonly held = new Set<number>()
  private left = Number.POSITIVE_INFINITY
  private top = Number.POSITIVE_INFINITY
  private right = Number.NEGATIVE_INFINITY
  private bottom = Number.NEGATIVE_INFINITY
  /** Set once a stamp would grow the box past what a raster may hold; nothing more is stamped. */
  tooLarge = false

  get size(): number {
    return this.held.size
  }

  /** Whether a tip swept between two pixels keeps the bounding box within the raster limit. */
  private fitsBox(x0: number, y0: number, x1: number, y1: number, reach: number): boolean {
    // The tip is clamped to the world first: pixels past the edge are never kept, so they must
    // not count against the box either.
    const left = Math.min(this.left, Math.max(0, Math.min(x0, x1) - reach))
    const top = Math.min(this.top, Math.max(0, Math.min(y0, y1) - reach))
    const right = Math.max(this.right, Math.min(WORLD_PIXELS - 1, Math.max(x0, x1) + reach))
    const bottom = Math.max(this.bottom, Math.min(WORLD_PIXELS - 1, Math.max(y0, y1) + reach))
    return (right - left + 1) * (bottom - top + 1) <= MAX_RASTER_BITS
  }

  has(x: number, y: number): boolean {
    return this.held.has(y * WORLD_PIXELS + x)
  }

  add(x: number, y: number): void {
    // A wide tip at the canvas edge reaches past it; those pixels do not exist.
    if (x < 0 || y < 0 || x >= WORLD_PIXELS || y >= WORLD_PIXELS) return
    this.held.add(y * WORLD_PIXELS + x)
    if (x < this.left) this.left = x
    if (x > this.right) this.right = x
    if (y < this.top) this.top = y
    if (y > this.bottom) this.bottom = y
  }

  /** Stamp a round tip of `width` pixels centred on a pixel. Width one is the pixel itself. */
  stamp(x: number, y: number, width: number): void {
    // The box is checked before the tip is stamped, so a long stroke with a wide tip stops
    // doing work the moment it would no longer fit, instead of stamping millions of pixels
    // that a raster could never hold.
    if (this.tooLarge) return
    const radius = width / 2
    const reach = width <= 1 ? 0 : Math.ceil(radius)
    if (!this.fitsBox(x, y, x, y, reach)) {
      this.tooLarge = true
      return
    }
    if (width <= 1) {
      this.add(x, y)
      return
    }
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        // Pixel-centre membership, like the shared rasteriser: the disc is measured from centres.
        if (dx * dx + dy * dy <= radius * radius) this.add(x + dx, y + dy)
      }
    }
  }

  /**
   * Stamp along the straight line between two pixels. A one-pixel tip walks the line; a wider
   * tip fills every pixel whose centre lies within half the width of the segment, visiting only
   * the segment's box, so the work is the stroke's area rather than a disc per step.
   */
  line(from: Point, to: Point, width: number): void {
    if (this.tooLarge) return
    const start = { x: Math.floor(from.x), y: Math.floor(from.y) }
    const end = { x: Math.floor(to.x), y: Math.floor(to.y) }
    if (width <= 1) {
      const steps = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y))
      for (let step = 0; step <= steps; step++) {
        const at = lerp(start, end, steps === 0 ? 0 : step / steps)
        this.stamp(Math.round(at.x), Math.round(at.y), width)
      }
      return
    }
    const radius = width / 2
    const reach = Math.ceil(radius)
    if (!this.fitsBox(start.x, start.y, end.x, end.y, reach)) {
      this.tooLarge = true
      return
    }
    const left = Math.max(0, Math.min(start.x, end.x) - reach)
    const right = Math.min(WORLD_PIXELS - 1, Math.max(start.x, end.x) + reach)
    const top = Math.max(0, Math.min(start.y, end.y) - reach)
    const bottom = Math.min(WORLD_PIXELS - 1, Math.max(start.y, end.y) + reach)
    const probe = { x: 0, y: 0 }
    for (probe.y = top; probe.y <= bottom; probe.y++) {
      for (probe.x = left; probe.x <= right; probe.x++)
        if (withinSegment(probe, start, end, radius)) this.add(probe.x, probe.y)
    }
  }

  bounds(): PresenceRect | null {
    if (this.held.size === 0) return null
    return {
      x: this.left,
      y: this.top,
      w: this.right - this.left + 1,
      h: this.bottom - this.top + 1,
    }
  }

  /** The set as a raster shape, or null when empty or too large for one. */
  shape(): RasterShape | null {
    const rect = this.bounds()
    // A long diagonal stroke has a huge box for few pixels; refuse before allocating it.
    if (rect === null || this.tooLarge || rect.w * rect.h > MAX_RASTER_BITS) return null
    const mask = new Uint8Array(rect.w * rect.h)
    for (const key of this.held) {
      const y = Math.floor(key / WORLD_PIXELS)
      const x = key - y * WORLD_PIXELS
      mask[(y - rect.y) * rect.w + (x - rect.x)] = 1
    }
    return rasterShapeFrom({ rect, mask, count: this.held.size })
  }
}

const forEachPixel = (
  { rect, mask }: RegionShapePixels,
  visit: (x: number, y: number, at: number) => void,
): void => {
  for (let row = 0; row < rect.h; row++)
    for (let column = 0; column < rect.w; column++) {
      const at = row * rect.w + column
      if (mask[at] === 1) visit(rect.x + column, rect.y + row, at)
    }
}

/** Two rasters as one: the union of their pixels. Null when the union is too large for one. */
export const mergeRasters = (base: RasterShape, added: RasterShape): RasterShape | null => {
  const set = new PixelSet()
  for (const shape of [base, added]) forEachPixel(regionShapePixels(shape), (x, y) => set.add(x, y))
  return set.shape()
}

/**
 * A raster with some pixels rubbed out. Null when nothing is left; the same shape when the
 * eraser never touched it.
 */
export const eraseFromRaster = (shape: RasterShape, erased: PixelSet): RasterShape | null => {
  const touched = erased.bounds()
  if (touched === null || !rectsIntersect(regionShapeBounds(shape), touched)) return shape
  const pixels = regionShapePixels(shape)
  let changed = false
  forEachPixel(pixels, (x, y, at) => {
    if (!erased.has(x, y)) return
    pixels.mask[at] = 0
    changed = true
  })
  if (!changed) return shape
  let count = 0
  for (const bit of pixels.mask) if (bit === 1) count++
  return rasterShapeFrom({ rect: pixels.rect, mask: pixels.mask, count })
}

const nearPolyline = (line: readonly Point[], point: Point, radius: number): boolean => {
  for (let i = 0; i + 1 < line.length; i++)
    if (withinSegment(point, line[i] as Point, line[i + 1] as Point, radius)) return true
  return false
}

/**
 * Whether any pixel of a shape lies under the eraser. The eraser's own pixels are few; each is
 * tested against the shape's geometry by its centre, the way the rasteriser decides membership,
 * so a large shape is never rasterised just to answer this.
 */
export const rasterTouches = (shape: RegionShape, erased: PixelSet): boolean => {
  const touched = erased.bounds()
  if (touched === null) return false
  const bounds = regionShapeBounds(shape)
  if (!rectsIntersect(bounds, touched)) return false
  const left = Math.max(bounds.x, touched.x)
  const top = Math.max(bounds.y, touched.y)
  const right = Math.min(bounds.x + bounds.w, touched.x + touched.w)
  const bottom = Math.min(bounds.y + bounds.h, touched.y + touched.h)
  const hit = pixelTest(shape)
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) if (erased.has(x, y) && hit(x, y)) return true
  }
  return false
}

/** Pixel membership by geometry alone, without rasterising a vector shape. */
const pixelTest = (shape: RegionShape): ((x: number, y: number) => boolean) => {
  if (shape.kind === 'rectangle') return () => true
  if (shape.kind === 'pixels') {
    const { rect, mask } = regionShapePixels(shape)
    return (x, y) => mask[(y - rect.y) * rect.w + (x - rect.x)] === 1
  }
  const outline = regionShapeOutline(shape)
  const closed = shape.kind !== 'path' || shape.closed
  const width = shape.kind === 'path' ? shape.width : 0
  const line = closed && width > 0 ? [...outline, outline[0] as Point] : outline
  return (x, y) => {
    const centre = { x: x + 0.5, y: y + 0.5 }
    if (closed && insideRing(outline, centre.x, centre.y)) return true
    return width > 0 && nearPolyline(line, centre, width / 2)
  }
}
