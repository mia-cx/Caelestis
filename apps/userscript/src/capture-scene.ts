import {
  type ArenaPixel,
  arenaToWorld,
  type CaptureRun,
  type PresenceRect,
  type RegionShapePixels,
  simulateCapture,
  type TerritoryMap,
  type TerritoryTeam,
  worldToArena,
} from '@caelestis/shared'

/**
 * What a capture run puts on the map, as pure functions of the run and Wplace's territory map:
 *
 * - `mine`: this painter's own line, solid in the team's colour, the colour they paint it in.
 * - `ready` and `pending`: everyone else's line in the team's dark shade, filled once they have
 *   drafted all of it and only outlined before, so the gaps in the wall show at a glance.
 * - `area`: what the wall encloses once it closes, faintly hatched, so the shape reads as a shape.
 * - `anchor`: a dashed box around each guard's anchor, the end of the wall they hold.
 * - `demo`: a short chain crawling from the team's territory to this painter's line, showing how
 *   to draft a line that does not touch the territory yet.
 */

export type CaptureItemKind = 'mine' | 'ready' | 'pending' | 'area' | 'anchor' | 'demo'

export interface CaptureItem {
  readonly kind: CaptureItemKind
  readonly rect: PresenceRect
  /** The pixels for masked kinds; null for `anchor`, which is its rect. */
  readonly pixels: RegionShapePixels | null
  /** Unit RGB to draw it in, from the team's colours; null draws it white. */
  readonly colour: readonly [number, number, number] | null
}

type Pixel = { readonly x: number; readonly y: number }

/** Flat `[x0, y0, x1, y1, …]` world coordinates as pixels. */
export const linePixels = (line: readonly number[]): Pixel[] => {
  const pixels: Pixel[] = []
  for (let at = 0; at + 1 < line.length; at += 2)
    pixels.push({ x: line[at] as number, y: line[at + 1] as number })
  return pixels
}

/** Pixels as a mask over their bounding box, or null for none. */
export const pixelMask = (pixels: readonly Pixel[]): RegionShapePixels | null => {
  if (pixels.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const { x, y } of pixels) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const rect = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
  const mask = new Uint8Array(rect.w * rect.h)
  for (const { x, y } of pixels) mask[(y - rect.y) * rect.w + (x - rect.x)] = 1
  return { rect, mask, count: pixels.length }
}

const toArena = (lines: readonly (readonly number[])[]): ArenaPixel[][] =>
  lines.map((line) =>
    linePixels(line).flatMap((pixel) => {
      const local = worldToArena(pixel)
      return local === null ? [] : [local]
    }),
  )

/** What painting every line would enclose, beyond the lines themselves, in world pixels. */
export const enclosedArea = (
  map: TerritoryMap,
  team: TerritoryTeam,
  lines: readonly (readonly number[])[],
  /** The lines' `simulateCapture` map, when the caller already has it. */
  simulated?: TerritoryMap,
): RegionShapePixels | null => {
  const plan = { lines: toArena(lines) }
  const after = (simulated ?? simulateCapture(map, team, plan).map).owner
  const onLine = new Set(plan.lines.flat().map(({ x, y }) => y * map.size + x))
  const area: Pixel[] = []
  for (let at = 0; at < after.length; at++)
    if (after[at] === team && map.owner[at] !== team && !onLine.has(at))
      area.push(arenaToWorld({ x: at % map.size, y: Math.floor(at / map.size) }))
  return pixelMask(area)
}

/** How far the approach search looks before giving up; a line this far out needs no demo. */
const MAX_APPROACH_PIXELS = 250_000

/**
 * The shortest four-connected path, in world pixels, from a pixel next to the team's territory to
 * `to`, through pixels the team does not hold. Empty when `to` already touches the territory.
 */
export const approachPath = (map: TerritoryMap, team: TerritoryTeam, to: Pixel): Pixel[] => {
  const start = worldToArena(to)
  if (start === null) return []
  const { size, owner } = map
  const from = new Int32Array(size * size).fill(-1)
  const first = start.y * size + start.x
  from[first] = first
  const queue = [first]
  for (let head = 0; head < queue.length && head < MAX_APPROACH_PIXELS; head++) {
    const at = queue[head] as number
    const x = at % size
    const y = (at - x) / size
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const next = ny * size + nx
      if (owner[next] === team) {
        // `at` touches the territory: walk back to the line, nearest the territory first.
        const path: Pixel[] = []
        for (let step = at; step !== first; step = from[step] as number)
          path.push(arenaToWorld({ x: step % size, y: Math.floor(step / size) }))
        return path
      }
      if (from[next] !== -1) continue
      from[next] = at
      queue.push(next)
    }
  }
  return []
}

/** Pixels in the demo chain while it crawls. */
const CHAIN = 5
/** Steps the demo holds its last frame before it starts again. */
const PAUSE_STEPS = 8

/**
 * The demo, frame by frame, each frame the chain's pixels: it grows out of the territory along
 * `path`, crawls to the line by drafting at the head and removing at the tail, pulls its tail onto
 * the line's first pixel, then drafts the rest of the line, and holds there before looping.
 */
export const caterpillarFrames = (path: readonly Pixel[], line: readonly Pixel[]): Pixel[][] => {
  const route = [...path, ...line]
  const start = path.length
  const spans: [number, number][] = []
  let tail = 0
  for (let head = 0; head <= start && head < route.length; head++) {
    tail = Math.max(0, head - CHAIN + 1)
    spans.push([tail, head])
  }
  for (tail += 1; tail <= start; tail++) spans.push([tail, start])
  for (let head = start + 1; head < route.length; head++) spans.push([start, head])
  const last = spans.at(-1)
  if (last !== undefined) for (let pause = 0; pause < PAUSE_STEPS; pause++) spans.push(last)
  return spans.map(([from, to]) => route.slice(from, to + 1))
}

/** A guard's anchor: the strip they paint and the end of the wall it thickens, as one box. */
export const anchorRect = (run: CaptureRun, index: number, strip: number): PresenceRect | null => {
  const wall = run.lines.slice(0, run.painters).flatMap(linePixels)
  const end = index === run.painters ? wall.slice(0, strip) : wall.slice(-strip)
  const box = pixelMask([...linePixels(run.lines[index] ?? []), ...end])?.rect
  // One pixel of margin so the dashed box sits around the pixels, not on them.
  return box === undefined ? null : { x: box.x - 1, y: box.y - 1, w: box.w + 2, h: box.h + 2 }
}
