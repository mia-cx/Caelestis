import { latLngToCanvasPixel, type Point } from '@caelestis/shared'
import { getMap } from './map-handle.js'
import { canvasPixelAt, isMapInteractionTarget } from './map-view.js'
import { ANY_DIALOG } from './wplace-dom.js'

/**
 * Where the pointer is on the map: which canvas pixel is under it, whether a press belongs to the
 * map or to page chrome, and eating the click Wplace would otherwise act on after a gesture we
 * took.
 */

/** CSS pixels a press may travel and still count as a click rather than a drag. */
export const CLICK_SLOP_PX = 4

/** Touch may emit no click after a gesture; a swallow left waiting expires after this long. */
const SWALLOW_CLICK_MS = 400

const PAGE_CONTROLS = `${ANY_DIALOG},button,input,select,textarea,a,[role="button"]`

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
 * toolbar action must still land. A release's own click arrives before the next task, so a
 * gesture that is sure of its click can expire the swallow at once (`expiresAfter` 0).
 */
export const swallowNextClick = (
  owns: (target: EventTarget | null) => boolean,
  expiresAfter = SWALLOW_CLICK_MS,
): void => {
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
  const timer = setTimeout(stop, expiresAfter)
  for (const type of types) window.addEventListener(type, swallow, true)
}
