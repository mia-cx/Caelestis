import { latLngToCanvasPixel, TILE_SIZE } from '@caelestis/shared'
import { registerDebugEntry } from './console-api.js'
import {
  canvasPixelAtIn,
  createScreenProjectionCache,
  cssPixelsPerCanvasPixelIn,
  type ScreenProjection,
  screenPointForIn,
  type TileFrame,
  viewportCentreIn,
} from './coordinates.js'
import { warn } from './debug.js'
import { getMap } from './map-handle.js'
import { measureProfile } from './profile.js'
import { onTileFrame } from './tile-frame.js'

/**
 * The map view: the last frame Wplace drew, what follows it, and the questions asked of it.
 *
 * Templates are drawn by GL layers inside Wplace's own canvas. Each frame carries the rects Wplace
 * drew its tiles at, and those are the only reference anything needs to turn a canvas pixel into a
 * screen position or back.
 */

let lastFrame: TileFrame | null = null

interface Follower {
  /** Called with `null` when an alliance artboard pans. */
  readonly run: (frame: TileFrame | null) => void
  readonly name: string
  /** Also runs when an alliance artboard pans, which draws no world frame. */
  readonly followsArtboard: boolean
}

/** Run in registration order on every world frame. */
const followers: Follower[] = []
const redrawTargets: (() => void)[] = []

const runFollower = ({ run, name }: Follower, frame: TileFrame | null): void => {
  try {
    measureProfile(name, () => run(frame))
  } catch (error) {
    warn('install', 'frame hook failed', String(error))
  }
}

/** Run on every world frame that carries tiles, after the frame has been recorded. */
export const onMapFrame = (hook: (frame: TileFrame) => void, name: string): void => {
  followers.push({
    run: (frame) => {
      if (frame !== null) hook(frame)
    },
    name,
    followsArtboard: false,
  })
}

/** Run whenever the visible view moves: every world frame, and every alliance artboard pan. */
export const onViewChange = (listener: () => void, name: string): void => {
  followers.push({ run: () => listener(), name, followsArtboard: true })
}

/** Report an alliance artboard viewport change. The world map's frames never run while one pans. */
export const notifyArtboardViewChange = (): void => {
  for (const follower of followers) if (follower.followsArtboard) runFollower(follower, null)
}

/** Repaint something that draws from our state outside the world map's frame, on every `redraw`. */
export const onRedraw = (repaint: () => void): void => {
  redrawTargets.push(repaint)
}

/** A draw is on the stack; synchronous repaint requests become a later pass, never recursion. */
let drawing = false
let drawAgain = false
const MAX_DRAW_PASSES = 3

const draw = (frame: TileFrame): void => {
  if (drawing) {
    drawAgain = true
    return
  }
  drawing = true
  try {
    let passes = 0
    do {
      drawAgain = false
      lastFrame = frame
      for (const follower of followers) runFollower(follower, frame)
      passes++
    } while (drawAgain && passes < MAX_DRAW_PASSES)
  } finally {
    drawing = false
    drawAgain = false
  }
}

/** Re-run the frame followers against the last frame, for when our state changed, not the map's. */
export const repaint = (): void => {
  if (lastFrame !== null) draw(lastFrame)
}

/** Ask MapLibre to repaint custom GL layers without rerunning screen-space controls immediately. */
export const requestMapFrame = (): void => {
  getMap()?.triggerRepaint()
}

/** Redraw everything after a change of ours: the frame followers, the GL layers, and the artboard. */
export const redraw = (): void => {
  repaint()
  requestMapFrame()
  for (const target of redrawTargets) target()
}

/**
 * Where the middle of the viewport is, in canvas pixels — used to place an image on import. Zoomed
 * out past Wplace's pixels no tile frame measures the view, so the map's own centre answers.
 */
export const viewportCentre = (): { x: number; y: number } | null => {
  const measured = lastFrame === null ? null : viewportCentreIn(lastFrame)
  if (measured !== null) return measured
  const map = getMap()
  return map === null ? null : latLngToCanvasPixel(map.getCenter())
}

/** Canvas pixel under a screen point, for centring something on the cursor. */
export const canvasPixelAt = (clientX: number, clientY: number): { x: number; y: number } | null =>
  lastFrame === null ? null : canvasPixelAtIn(lastFrame, clientX, clientY)

/** Whether a captured page event actually originated inside the active map surface. */
export const isMapInteractionTarget = (target: EventTarget | null): boolean => {
  if (lastFrame === null || target === null) return false
  const mapCanvas = lastFrame.canvas
  const mapContainer = mapCanvas.parentElement
  if (target === mapCanvas || target === mapContainer) return true
  if (mapContainer === null) return false
  try {
    return mapContainer.contains(target as Node)
  } catch {
    // A non-Node target, such as the window, from another realm where `instanceof Node` fails.
    return false
  }
}

export const screenPointFor = (x: number, y: number): { x: number; y: number } | null =>
  lastFrame === null ? null : screenPointForIn(lastFrame, x, y)

/** How many CSS pixels one canvas pixel currently occupies. */
export const cssPixelsPerCanvasPixel = (): { x: number; y: number } =>
  cssPixelsPerCanvasPixelIn(lastFrame)

/** One cached canvas-layout measurement shared by every map-following control. */
const projection = createScreenProjectionCache()
export const screenProjection = (): ScreenProjection | null => projection.project(lastFrame)

/** Follow Wplace's tile frames. Install after every frame follower that must see the first frame. */
export const installMapView = (): void => {
  onTileFrame(draw)
  /** The captured MapLibre Map, for poking at its style and layers from the console. */
  registerDebugEntry('map', () => getMap())
  /** The tiles Wplace drew on the last frame, and where. How much work a frame actually is. */
  registerDebugEntry('quads', () =>
    lastFrame === null
      ? null
      : {
          count: lastFrame.quads.length,
          canvas: `${lastFrame.canvas.width}x${lastFrame.canvas.height}`,
          cellPixels: (lastFrame.quads[0]?.width ?? 0) / TILE_SIZE,
          tiles: lastFrame.quads.map((quad) => `${quad.tile.x}/${quad.tile.y}`),
        },
  )
}
