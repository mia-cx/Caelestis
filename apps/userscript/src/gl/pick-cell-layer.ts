import { canvasPixelToLatLng, PALETTE_RGB } from '@caelestis/shared'
import { log, warn } from '../debug.js'
import { getMap } from '../map-handle.js'

/**
 * A solid template cell for Wplace's own picker to read, which trips no flag.
 *
 * Wplace's picker answers a click from a fresh render of the map canvas: it reads the pixel under
 * the click, matches it to a palette colour and selects that colour itself, so no swatch is
 * clicked. Our overlay already draws into that canvas, but blended with the map, and the markers
 * draw over it. While a pick is shown, this layer, on top of every other, clears the picked
 * template cell to its exact palette colour, so the frame Wplace reads holds the template colour.
 */

export const PICK_CELL_LAYER_ID = 'caelestis-pick-cell'

/** Long enough to cover the render Wplace's picker waits for, short enough to read as a flash. */
const SHOWN_MS = 500

interface ProjectingMap {
  getCanvas(): HTMLCanvasElement
  getCenter(): { lng: number }
  project(lngLat: [number, number]): { x: number; y: number }
  triggerRepaint?(): void
  addLayer?(layer: unknown, before?: string): void
  getLayer?(id: string): unknown
  moveLayer?(id: string, before?: string): void
  style?: { _order?: string[] }
}

let shown: { readonly x: number; readonly y: number; readonly rgb: readonly number[] } | null = null
let hide: ReturnType<typeof setTimeout> | undefined

const projectingMap = (): ProjectingMap | null => getMap() as ProjectingMap | null

/** Show the world cell at canvas pixel `x`, `y` solid in palette colour `index` for one pick. */
export const showPickCell = (x: number, y: number, index: number): void => {
  const rgb = PALETTE_RGB[index]
  if (rgb === undefined) return
  shown = { x: Math.floor(x), y: Math.floor(y), rgb }
  clearTimeout(hide)
  hide = setTimeout(() => {
    shown = null
    projectingMap()?.triggerRepaint?.()
  }, SHOWN_MS)
  projectingMap()?.triggerRepaint?.()
}

/** The cell's rectangle in framebuffer pixels, origin bottom-left as `scissor` takes it. */
const cellRect = (
  map: ProjectingMap,
  x: number,
  y: number,
): readonly [number, number, number, number] | null => {
  const canvas = map.getCanvas()
  if (canvas.clientWidth === 0) return null
  const scale = canvas.width / canvas.clientWidth
  // The world repeats horizontally; project the copy nearest the camera.
  const centre = map.getCenter().lng
  const corner = (cornerX: number, cornerY: number): { x: number; y: number } => {
    const { lat, lng } = canvasPixelToLatLng({ x: cornerX, y: cornerY })
    return map.project([lng + 360 * Math.round((centre - lng) / 360), lat])
  }
  const a = corner(x, y)
  const b = corner(x + 1, y + 1)
  const left = Math.floor(Math.min(a.x, b.x) * scale)
  const right = Math.ceil(Math.max(a.x, b.x) * scale)
  const top = Math.floor(Math.min(a.y, b.y) * scale)
  const bottom = Math.ceil(Math.max(a.y, b.y) * scale)
  return [left, canvas.height - bottom, right - left, bottom - top]
}

export const pickCellLayer = {
  id: PICK_CELL_LAYER_ID,
  type: 'custom' as const,
  renderingMode: '2d' as const,

  render(gl: WebGL2RenderingContext): void {
    if (shown === null) return
    const map = projectingMap()
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
  },
}

/** Add the layer on top of Wplace's style, and move it back on top after a style change. */
export const installPickCellLayer = (): boolean => {
  const map = projectingMap()
  if (map?.addLayer === undefined) return false
  try {
    if (map.getLayer?.(PICK_CELL_LAYER_ID) === undefined) {
      map.addLayer(pickCellLayer)
      log('install', `${PICK_CELL_LAYER_ID} inserted on top`)
      return true
    }
    const order = map.style?._order
    if (order !== undefined && order.at(-1) !== PICK_CELL_LAYER_ID)
      map.moveLayer?.(PICK_CELL_LAYER_ID)
    return true
  } catch (error) {
    warn('install', `could not add ${PICK_CELL_LAYER_ID}`, String(error))
    return false
  }
}
