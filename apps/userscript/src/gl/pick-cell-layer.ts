import { canvasPixelToLatLng, PALETTE_RGB } from '@caelestis/shared'
import { logRender } from '../debug.js'
import { getMap, type MapLike } from '../map-handle.js'
import { LAYER_IDS } from './layer-stack.js'

/**
 * A solid template cell for Wplace's own picker to read, which trips no flag.
 *
 * Both of Wplace's world picks, the picker tool's map click and the middle-click "instant
 * eyedropper" (`paint.pick-hover`), end in the same function: after its own draft and templates,
 * it hides the hover square, waits for the next map render, reads the pixel under the click from
 * the canvas, matches it to a palette colour and selects that colour itself, so no swatch is
 * clicked. Our overlay already draws into that canvas, but blended with the map, and the markers
 * draw over it. While a pick is shown, this layer, on top of every other, clears the picked
 * template cell to its exact palette colour, so the frame Wplace reads holds the template colour.
 */

/**
 * How long the cell stays after the button comes up. Wplace's picker tool reads on the map's
 * `click`, after release, so the cell holds while the button is down and this covers the render
 * that click waits for, short enough to read as a flash.
 */
const SHOWN_AFTER_RELEASE_MS = 500

let shown: { readonly x: number; readonly y: number; readonly rgb: readonly number[] } | null = null
/** Whether the current cell has been drawn yet, so the debug log notes its first frame only. */
let drawn = false
let hide: ReturnType<typeof setTimeout> | undefined

const hideAfterRelease = (): void => {
  window.removeEventListener('pointerup', hideAfterRelease, true)
  window.removeEventListener('pointercancel', hideAfterRelease, true)
  clearTimeout(hide)
  hide = setTimeout(() => {
    shown = null
    getMap()?.triggerRepaint()
  }, SHOWN_AFTER_RELEASE_MS)
}

/**
 * Show the world cell at canvas pixel `x`, `y` solid in palette colour `index` for one pick. Call
 * it from the pick's `pointerdown`: the cell stays until shortly after that button comes up.
 */
export const showPickCell = (x: number, y: number, index: number): void => {
  const rgb = PALETTE_RGB[index]
  if (rgb === undefined) return
  shown = { x: Math.floor(x), y: Math.floor(y), rgb }
  drawn = false
  logRender('draw', 'pick cell shown', { x: shown.x, y: shown.y, index })
  clearTimeout(hide)
  window.addEventListener('pointerup', hideAfterRelease, true)
  window.addEventListener('pointercancel', hideAfterRelease, true)
  getMap()?.triggerRepaint()
}

/**
 * The screen box around the cell in framebuffer pixels, origin bottom-left as `scissor` takes it.
 * It bounds all four projected corners, so a rotated or pitched map still covers the whole cell.
 */
const cellRect = (
  map: MapLike,
  x: number,
  y: number,
): readonly [number, number, number, number] | null => {
  const canvas = map.getCanvas()
  if (canvas.clientWidth === 0) return null
  const scale = canvas.width / canvas.clientWidth
  // The world repeats horizontally; project the copy nearest the camera.
  const centre = map.getCenter().lng
  const corners = [
    [x, y],
    [x + 1, y],
    [x, y + 1],
    [x + 1, y + 1],
  ].map(([cornerX = 0, cornerY = 0]) => {
    const { lat, lng } = canvasPixelToLatLng({ x: cornerX, y: cornerY })
    return map.project([lng + 360 * Math.round((centre - lng) / 360), lat])
  })
  const xs = corners.map((corner) => corner.x)
  const ys = corners.map((corner) => corner.y)
  const left = Math.floor(Math.min(...xs) * scale)
  const right = Math.ceil(Math.max(...xs) * scale)
  const top = Math.floor(Math.min(...ys) * scale)
  const bottom = Math.ceil(Math.max(...ys) * scale)
  return [left, canvas.height - bottom, right - left, bottom - top]
}

export const pickCellLayer = {
  id: LAYER_IDS.pickCell,
  type: 'custom' as const,
  renderingMode: '2d' as const,

  render(gl: WebGL2RenderingContext): void {
    if (shown === null) return
    const map = getMap()
    if (map === null) return
    const rect = cellRect(map, shown.x, shown.y)
    if (rect === null) return
    const [red = 0, green = 0, blue = 0] = shown.rgb
    // MapLibre marks its cached GL state dirty around custom layers, so this needs no restore.
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(...rect)
    gl.clearColor(red / 255, green / 255, blue / 255, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.disable(gl.SCISSOR_TEST)
    if (drawn) return
    drawn = true
    logRender('draw', 'pick cell drawn', { rect })
  },
}
