import type { TileCoord } from '@caelestis/shared'
import type { TileFrame, TileQuad } from './coordinates.js'
import { count, isEnabled, logRender } from './debug.js'
import { getMap } from './map-handle.js'
import { notifyEach } from './page-hooks.js'
import { PIXEL_ART_LAYER } from './wplace-raster.js'

/**
 * Which Wplace tile is on screen, where, right now?
 *
 * MapLibre already knows where, and uploads the answer to the GPU every frame. Rather than
 * reimplement the projection, which drifts, `gl-observer.ts` reads MapLibre's own matrix back out
 * of the WebGL context and records each tile draw here. This module turns those draws into one
 * frame of tile quads and hands it to whoever draws over Wplace's tiles.
 */

/** MapLibre's tile coordinate extent. Tile-local `(0,0)`..`(EXTENT,EXTENT)` spans one whole tile. */
const MAPLIBRE_TILE_EXTENT = 8192

/** How square a quad must be to be believed, as a fraction of its width. */
const SQUARENESS_TOLERANCE = 0.02

/**
 * Bounds on a believable tile, in device pixels.
 *
 * The upper one is a sanity check against a nonsense matrix and nothing more, which is why it is so
 * loose: one tile spans 131,072 px at zoom 19 and 514,976 px at zoom 21. The real filtering is done
 * by requiring the texture to be a tile we attributed and the quad to be square.
 */
const MIN_TILE_SCREEN_WIDTH = 4
const MAX_TILE_SCREEN_WIDTH = 1e9

/**
 * How much rotation in the projection matrix is tolerated before a quad is refused.
 *
 * A `TileQuad` is an axis-aligned rectangle, which cannot describe a rotated tile. Wplace has
 * rotation off today: measured across 234,574 matrix uploads, including a two-finger twist under
 * touch emulation, the off-diagonal terms were exactly zero. That is a product decision of theirs,
 * not a guarantee, so it is checked rather than assumed. Failing the check draws nothing, which is
 * a visible absence rather than a silent misplacement.
 */
const ROTATION_TOLERANCE = 1e-6

type FrameListener = (frame: TileFrame) => void

const listeners: FrameListener[] = []
let mapCanvas: HTMLCanvasElement | null = null
let pending: TileQuad[] = []
let scheduled = false
let lastQuads: readonly TileQuad[] = []
let frameDraws = 0
let frameTileDraws = 0
/** Whether the overlay currently has anything painted on it, so a clear is worth doing once. */
let overlayHasContent = false
let drawingTiles = false

/** Column-major 4x4, the layout WebGL uses. */
const project = (m: ArrayLike<number>, x: number, y: number): readonly [number, number] => {
  const at = (index: number): number => m[index] ?? 0
  const clipX = at(0) * x + at(4) * y + at(12)
  const clipY = at(1) * x + at(5) * y + at(13)
  const clipW = at(3) * x + at(7) * y + at(15)
  return [clipX / clipW, clipY / clipW]
}

const quadFromMatrix = (
  m: ArrayLike<number>,
  tile: TileCoord,
  canvas: HTMLCanvasElement,
): TileQuad | null => {
  const e = MAPLIBRE_TILE_EXTENT
  // Clip space is -1..1 with y up; the canvas is 0..size with y down.
  const toScreenX = (clip: number) => (clip * 0.5 + 0.5) * canvas.width
  const toScreenY = (clip: number) => (1 - (clip * 0.5 + 0.5)) * canvas.height
  const corner = (u: number, v: number): readonly [number, number] => {
    const [cx, cy] = project(m, u, v)
    return [toScreenX(cx), toScreenY(cy)]
  }
  // All four, not just the diagonal. A pitched or perspective transform turns a tile into a
  // trapezoid whose diagonal still measures square.
  const [topLeft, topRight, bottomLeft, bottomRight] = [
    corner(0, 0),
    corner(e, 0),
    corner(0, e),
    corner(e, e),
  ]
  const x = topLeft[0]
  const y = topLeft[1]
  const width = topRight[0] - x
  const height = bottomLeft[1] - y

  const reject = (why: string, data: unknown): null => {
    logRender('quad', `rejected ${tile.x}/${tile.y}: ${why}`, data)
    return null
  }
  const finite = [topLeft, topRight, bottomLeft, bottomRight].flat().every(Number.isFinite)
  if (!finite) return reject('non-finite', { topLeft, bottomRight })
  // Axis alignment measured on the screen quad itself: opposite edges must be parallel to the axes
  // and to each other, which is what a rotation, a pitch or a skew breaks.
  const span = Math.max(Math.abs(width), Math.abs(height)) || 1
  const skew =
    Math.max(
      Math.abs(topRight[1] - topLeft[1]),
      Math.abs(bottomRight[1] - bottomLeft[1]),
      Math.abs(bottomLeft[0] - topLeft[0]),
      Math.abs(bottomRight[0] - topRight[0]),
    ) / span
  if (skew > ROTATION_TOLERANCE) return reject('map is rotated or pitched', { skew })
  if (width < MIN_TILE_SCREEN_WIDTH) return reject('too small', { width })
  if (width > MAX_TILE_SCREEN_WIDTH) return reject('too large', { width })
  // Refused, not normalised: a y-inverted quad would be drawn a whole tile below the tile it names.
  if (height <= 0) return reject('y-inverted', { height })
  if (Math.abs(height - width) > width * SQUARENESS_TOLERANCE)
    return reject('not square', { width, height })
  return { tile, x, y, width, height }
}

/**
 * Current pixel-art tile quads from the same MapLibre matrix generator its raster layer uses.
 *
 * Everything below the Map object is private MapLibre state, so callers only learn that a live
 * answer exists or does not. A missing or changed internal returns null and lets the underlay fall
 * back to the last intercepted frame.
 */
const livePixelArtQuads = (canvas: HTMLCanvasElement): readonly TileQuad[] | null => {
  try {
    const map = getMap()
    const managers = map?.style?.tileManagers
    // A page-realm Map fails `instanceof` here, so recognise one by its `get`.
    const lookup = (managers as { get?: unknown } | undefined)?.get
    const manager =
      typeof lookup === 'function'
        ? Reflect.apply(lookup, managers, [PIXEL_ART_LAYER])
        : (managers as Record<string, unknown> | undefined)?.[PIXEL_ART_LAYER]
    const visible = (manager as { getVisibleCoordinates?: () => unknown } | undefined)
      ?.getVisibleCoordinates
    const transform = map?.painter?.transform
    const calculate = transform?.calculatePosMatrix
    if (typeof visible !== 'function' || typeof calculate !== 'function') return null
    const coordinates = visible.call(manager)
    if (!Array.isArray(coordinates)) return null

    const aligned = map?.painter?.options?.moving !== true
    const quads: TileQuad[] = []
    for (const coordinate of coordinates) {
      const canonical = (coordinate as { canonical?: { x?: unknown; y?: unknown } })?.canonical
      if (!Number.isInteger(canonical?.x) || !Number.isInteger(canonical?.y)) continue
      const matrix = calculate.call(transform, coordinate, aligned, true)
      const quad = quadFromMatrix(
        matrix,
        { x: Number(canonical?.x), y: Number(canonical?.y) },
        canvas,
      )
      if (quad !== null) quads.push(quad)
    }
    return quads
  } catch {
    return null
  }
}

/**
 * Whether Wplace drew any canvas tiles on the last frame.
 *
 * Zoom out far enough and they stop serving them entirely. Anything drawing over their canvas has to
 * stop at the same point, or it floats above a map that is no longer showing the thing it annotates.
 */
export const isDrawingTiles = (): boolean => drawingTiles

/**
 * Where Wplace is drawing each tile *right now*, in canvas device pixels.
 *
 * This is the frame currently being built, not the last one that finished. Their raster layer draws
 * before ours in the same frame, so by the time anything in the layer stack below `pixel-hover`
 * renders, every tile quad for this frame has already been recorded.
 *
 * Anything drawing over their tiles wants these rather than a projection of its own. MapLibre snaps
 * raster tiles to whole device pixels when the map is still — `align = !painter.options.moving` —
 * and does not snap while it moves, so a separately projected overlay agrees during a pan and drifts
 * a fraction of a pixel the instant it settles. Taking the placement from their own draw calls makes
 * that unknowable and irrelevant: we land where they landed, aligned or not.
 */
export const currentQuads = (): readonly TileQuad[] => (scheduled ? pending : lastQuads)

/** Current-frame quads for a layer that renders before Wplace art, with a safe stale fallback. */
export const underlayQuads = (): readonly TileQuad[] => {
  let canvas = mapCanvas
  if (canvas === null) {
    try {
      canvas = getMap()?.getCanvas() ?? null
    } catch {
      // A map mid-construction has no canvas to answer with yet.
    }
  }
  return (canvas === null ? null : livePixelArtQuads(canvas)) ?? lastQuads
}

const emit = (quads: readonly TileQuad[]): void => {
  if (mapCanvas === null) return
  const frame: TileFrame = { canvas: mapCanvas, quads }
  notifyEach(listeners, (listener) => listener(frame), 'frame:listener-failed')
}

const flush = (): void => {
  scheduled = false
  if (mapCanvas === null) return
  const quads = pending
  pending = []
  if (quads.length > 0) lastQuads = quads

  logRender(
    'frame',
    'rendered',
    isEnabled()
      ? {
          draws: frameDraws,
          tileTextureDraws: frameTileDraws,
          quads: quads.length,
          tiles: quads.map((q) => `${q.tile.x}/${q.tile.y}`).join(' ') || '(none)',
        }
      : undefined,
  )
  const drewAnything = frameDraws > 0
  frameDraws = 0
  frameTileDraws = 0

  // "No tiles" only means Wplace has stopped serving them when they actually rendered a frame and
  // no tile was in it. A frame that drew nothing at all says nothing either way — MapLibre skips
  // work constantly — and treating that as the cutoff would switch the overlay off while sitting
  // still.
  if (quads.length > 0) drawingTiles = true
  else if (drewAnything) drawingTiles = false

  if (quads.length > 0) {
    if (!overlayHasContent) logRender('clear', 'overlay has content again')
    overlayHasContent = true
    emit(quads)
    return
  }

  // Once cleared, stay cleared until tiles return, so a run of tile-less frames clears only once.
  if (!overlayHasContent) {
    count('clear:already-empty')
    return
  }

  // No tiles this frame, and the overlay has ink on it: clear now, in this same browser frame.
  logRender('clear', 'no tiles this frame — clearing now')
  emit([])
  overlayHasContent = false
}

/**
 * Notified once per MapLibre frame with every Wplace tile drawn in it — including frames that draw
 * none, so a listener can clear rather than leaving a stale overlay behind.
 */
export const onTileFrame = (listener: FrameListener): void => {
  listeners.push(listener)
}

/** The canvas whose WebGL context the frames are read from, if one has been instrumented. */
export const frameCanvas = (): HTMLCanvasElement | null => mapCanvas

/** Read frames from this canvas from now on. */
export const setFrameCanvas = (canvas: HTMLCanvasElement | null): void => {
  mapCanvas = canvas
}

/**
 * Flush the frame being recorded at the end of the current task, unless one is already queued.
 * `isCurrent` lets a retired context's queued flush stand down.
 */
export const scheduleFrame = (isCurrent: () => boolean): void => {
  if (scheduled) return
  scheduled = true
  // A microtask, deliberately, not requestAnimationFrame.
  //
  // MapLibre renders from inside its own rAF callback, so an rAF scheduled from here does not run
  // until the *next* frame: the overlay lands one frame behind, and during a pan it visibly swims
  // against the tiles it is supposed to be pinned to. Measured over a real drag, 37 of 57 samples
  // were a whole task late that way.
  //
  // A microtask runs at the end of MapLibre's current task — after every draw call in the frame,
  // so the quad set is complete, but before the browser paints. Same frame, 57 of 57. This is also
  // why the overlay needs no motion prediction: there is no lag left to predict away.
  queueMicrotask(() => {
    if (isCurrent()) flush()
  })
}

/** Forget the draws recorded so far this frame, as a full clear or a lost context does. */
export const discardFrameDraws = (): void => {
  pending = []
  frameDraws = 0
  frameTileDraws = 0
}

/**
 * Start over on a newly instrumented context. A flush queued by the retired one must neither paint
 * its quads onto this canvas nor consume draws this context records before it runs.
 */
export const restartFrame = (): void => {
  discardFrameDraws()
  scheduled = false
}

/** Count one draw call of the frame, whatever it drew. */
export const recordDraw = (): void => {
  frameDraws++
}

/** Record one draw of a Wplace tile under MapLibre's projection matrix for it. */
export const recordTileDraw = (
  matrix: ArrayLike<number>,
  tile: TileCoord,
  canvas: HTMLCanvasElement,
): void => {
  frameTileDraws++
  const quad = quadFromMatrix(matrix, tile, canvas)
  if (quad !== null) pending.push(quad)
}
