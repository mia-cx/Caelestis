import {
  latLngToCanvasPixel,
  type Point,
  type PresenceRect,
  quantiseRect,
  TILE_SIZE,
  WORLD_PIXELS,
} from '@caelestis/shared'
import type { TileFrame, TileQuad } from './coordinates.js'
import { getMap } from './map-handle.js'
import { canvasPixelAt, isMapInteractionTarget } from './map-view.js'

/**
 * Where the pointer is on the map: which canvas pixel is under it, whether a press belongs to the
 * map or to page chrome, and eating the click Wplace would otherwise act on after a gesture we
 * took. Also where frame rects land on screen, for what is drawn over the map.
 */

/** Wplace's MapLibre canvas. */
export const MAP_CANVAS_SELECTOR = 'canvas.maplibregl-canvas'

/** CSS pixels a press may travel and still count as a click rather than a drag. */
export const CLICK_SLOP_PX = 4

/** Touch may emit no click after a gesture; a swallow left waiting expires after this long. */
const SWALLOW_CLICK_MS = 400

const PAGE_CONTROLS = 'dialog,[role="dialog"],button,input,select,textarea,a,[role="button"]'

/**
 * The canvas point under a client position, fractional inside its pixel, or null off the rendered
 * tiles. It uses the projection Wplace's own paint listener uses, because rendered tile bounds can
 * be rounded by half a screen pixel and pick the neighbouring row or column at a boundary.
 */
export const mapPointAt = (clientX: number, clientY: number): Point | null => {
  const onTiles = canvasPixelAt(clientX, clientY)
  const map = getMap()
  if (onTiles === null || map === null) return onTiles
  return latLngToCanvasPixel(map.unproject([clientX, clientY]))
}

/** A press outside dialogs and page controls, on the map itself. */
export const isMapPress = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest(PAGE_CONTROLS) === null &&
  isMapInteractionTarget(target)

/**
 * Eat the click that follows a gesture we consumed, so Wplace never treats it as a pixel
 * selection. Only a click `owns` accepts is eaten: when touch emits none, the user's next
 * toolbar action must still land.
 */
export const swallowNextClick = (owns: (target: EventTarget | null) => boolean): void => {
  const types = ['click', 'auxclick'] as const
  const stop = (): void => {
    for (const type of types) window.removeEventListener(type, swallow, true)
    clearTimeout(timer)
  }
  const swallow = (event: Event): void => {
    stop()
    if (!owns(event.target)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const timer = setTimeout(stop, SWALLOW_CLICK_MS)
  for (const type of types) window.addEventListener(type, swallow, true)
}

/**
 * A tile frame's affine reference: any tile quad gives the scale and origin between device pixels
 * on the map canvas and canvas pixels. Nothing here projects through MapLibre, which keeps what is
 * drawn over tiles consistent with the tiles themselves.
 */
const frameReference = (frame: TileFrame): TileQuad | null => {
  const reference = frame.quads[0]
  return reference === undefined || reference.width <= 0 || reference.height <= 0 ? null : reference
}

/**
 * The canvas-pixel rect the whole map canvas covers. A viewport straddling the antimeridian
 * clamps to the canonical world; the far side is rare and not worth a second rect on the wire.
 */
export const viewportRectIn = (frame: TileFrame): PresenceRect | null => {
  const reference = frameReference(frame)
  if (reference === null) return null
  const scaleX = TILE_SIZE / reference.width
  const scaleY = TILE_SIZE / reference.height
  const originX = reference.tile.x * TILE_SIZE - reference.x * scaleX
  const originY = reference.tile.y * TILE_SIZE - reference.y * scaleY
  const left = Math.max(0, Math.floor(originX))
  const top = Math.max(0, Math.floor(originY))
  const right = Math.min(WORLD_PIXELS, Math.ceil(originX + frame.canvas.width * scaleX))
  const bottom = Math.min(WORLD_PIXELS, Math.ceil(originY + frame.canvas.height * scaleY))
  if (right <= left || bottom <= top) return null
  return quantiseRect({ x: left, y: top, w: right - left, h: bottom - top })
}

/** A box on the map canvas, in device pixels. */
export interface DeviceBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Where `rect` lands on the canvas this frame, in device pixels, or null when off screen. */
export const rectOnScreen = (frame: TileFrame, rect: PresenceRect): DeviceBox | null => {
  const reference = frameReference(frame)
  if (reference === null) return null
  const scaleX = reference.width / TILE_SIZE
  const scaleY = reference.height / TILE_SIZE
  const x = reference.x + (rect.x - reference.tile.x * TILE_SIZE) * scaleX
  const y = reference.y + (rect.y - reference.tile.y * TILE_SIZE) * scaleY
  const width = rect.w * scaleX
  const height = rect.h * scaleY
  if (x + width <= 0 || y + height <= 0 || x >= frame.canvas.width || y >= frame.canvas.height)
    return null
  return { x, y, width, height }
}

/** The whole canvas pixel under a device-pixel point on the map canvas, by the frame's tiles. */
export const framePixelAt = (frame: TileFrame, deviceX: number, deviceY: number): Point | null => {
  const reference = frameReference(frame)
  if (reference === null) return null
  return {
    x: Math.floor(
      reference.tile.x * TILE_SIZE + (deviceX - reference.x) * (TILE_SIZE / reference.width),
    ),
    y: Math.floor(
      reference.tile.y * TILE_SIZE + (deviceY - reference.y) * (TILE_SIZE / reference.height),
    ),
  }
}
