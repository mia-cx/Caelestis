import {
  type Point,
  type PresenceRect,
  quantiseRect,
  TILE_SIZE,
  type TileCoord,
  WORLD_PIXELS,
} from '@caelestis/shared'

/** Where Wplace drew one tile this frame, as an axis-aligned rectangle. */
export interface TileQuad {
  readonly tile: TileCoord
  /** Screen position of the tile's top-left corner, in canvas device pixels. */
  readonly x: number
  readonly y: number
  /** Screen size of the whole tile, in canvas device pixels. */
  readonly width: number
  readonly height: number
}

export interface TileFrame {
  readonly canvas: HTMLCanvasElement
  /**
   * Every wplace tile drawn this frame. Empty when the map is showing none — zoomed out past the
   * point where wplace serves them, for instance — which is the signal to clear the overlay rather
   * than leave the last frame's squares stranded on screen.
   */
  readonly quads: readonly TileQuad[]
}

const wrapWorldX = (x: number): number => ((x % WORLD_PIXELS) + WORLD_PIXELS) % WORLD_PIXELS

/** The nearest wrapped copy of a canonical x coordinate relative to an on-screen reference. */
const wrappedXDelta = (x: number, reference: number): number => {
  const delta = wrapWorldX(x) - wrapWorldX(reference)
  return (
    ((((delta + WORLD_PIXELS / 2) % WORLD_PIXELS) + WORLD_PIXELS) % WORLD_PIXELS) - WORLD_PIXELS / 2
  )
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

export interface ScreenProjection {
  readonly canvasBox: CanvasBox
  pointFor(x: number, y: number): { x: number; y: number }
  readonly pixelsPerCanvasPixel: { x: number; y: number }
}

interface CanvasBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * Snapshot the frame-to-screen transform once for callers that project many points.
 *
 * Reading the canvas rectangle can force layout. Keeping it behind this small value object lets a
 * whole overlay-control frame share one read instead of repeating it for every visible template.
 */
export const screenProjectionIn = (
  frame: TileFrame | null,
  knownBox?: CanvasBox,
): ScreenProjection | null => {
  const reference = frame === null ? null : frameReference(frame)
  if (reference === null || frame === null) return null
  const box = knownBox ?? frame.canvas.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0 || frame.canvas.width <= 0 || frame.canvas.height <= 0) {
    return null
  }
  const ratioX = frame.canvas.width / box.width
  const ratioY = frame.canvas.height / box.height
  const scaleX = reference.width / TILE_SIZE
  const scaleY = reference.height / TILE_SIZE
  const originX = reference.tile.x * TILE_SIZE
  const originY = reference.tile.y * TILE_SIZE
  return {
    canvasBox: box,
    pointFor: (x, y) => ({
      x: box.left + (reference.x + wrappedXDelta(x, originX) * scaleX) / ratioX,
      y: box.top + (reference.y + (y - originY) * scaleY) / ratioY,
    }),
    pixelsPerCanvasPixel: {
      x: scaleX / ratioX,
      y: scaleY / ratioY,
    },
  }
}

export interface ScreenProjectionCache {
  project(frame: TileFrame | null): ScreenProjection | null
  invalidate(): void
  dispose(): void
}

/**
 * Reuse the map canvas bounds while only its pixels are moving.
 *
 * Overlay controls write dozens of positions during a pan. Reading the canvas rectangle on the
 * next frame then forces the browser to lay all of them out before it can answer, even though the
 * canvas itself did not move. ResizeObserver invalidates the cached box when its layout really does
 * change; a scroll listener invalidates movement and cheap scalar keys cover browser zoom and
 * backing-store replacement.
 */
export const createScreenProjectionCache = (): ScreenProjectionCache => {
  let canvas: HTMLCanvasElement | null = null
  let box: CanvasBox | null = null
  let canvasWidth = 0
  let canvasHeight = 0
  let viewportWidth = 0
  let viewportHeight = 0
  let devicePixelRatio = 0
  const onScroll = (): void => {
    box = null
  }
  const layout = typeof MutationObserver === 'function' ? new MutationObserver(onScroll) : null
  const observer =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          box = null
        })
      : null
  if (typeof window !== 'undefined') window.addEventListener('scroll', onScroll, true)
  if (typeof document !== 'undefined') document.fonts?.addEventListener('loadingdone', onScroll)
  if (typeof window !== 'undefined') {
    window.visualViewport?.addEventListener('resize', onScroll)
    window.visualViewport?.addEventListener('scroll', onScroll)
  }

  const invalidate = (): void => {
    box = null
  }

  return {
    project(frame) {
      if (frame === null) return null
      if (canvas !== frame.canvas) {
        observer?.disconnect()
        layout?.disconnect()
        canvas = frame.canvas
        // Ancestor transforms and sibling insertions can move a same-sized canvas. Observe the
        // ancestor chain, not its subtrees, so moving label/control children do not invalidate it.
        for (let element: Element | null = canvas; element; element = element.parentElement) {
          observer?.observe(element)
          layout?.observe(element, {
            attributes: true,
            attributeFilter: ['class', 'style'],
            childList: true,
          })
        }
        box = null
      }
      const nextViewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth
      const nextViewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
      const nextDevicePixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio
      if (
        canvasWidth !== frame.canvas.width ||
        canvasHeight !== frame.canvas.height ||
        viewportWidth !== nextViewportWidth ||
        viewportHeight !== nextViewportHeight ||
        devicePixelRatio !== nextDevicePixelRatio
      ) {
        box = null
        canvasWidth = frame.canvas.width
        canvasHeight = frame.canvas.height
        viewportWidth = nextViewportWidth
        viewportHeight = nextViewportHeight
        devicePixelRatio = nextDevicePixelRatio
      }
      box ??= frame.canvas.getBoundingClientRect()
      return screenProjectionIn(frame, box)
    },
    invalidate,
    dispose() {
      observer?.disconnect()
      layout?.disconnect()
      if (typeof window !== 'undefined') window.removeEventListener('scroll', onScroll, true)
      if (typeof document !== 'undefined')
        document.fonts?.removeEventListener('loadingdone', onScroll)
      if (typeof window !== 'undefined') {
        window.visualViewport?.removeEventListener('resize', onScroll)
        window.visualViewport?.removeEventListener('scroll', onScroll)
      }
      canvas = null
      box = null
    },
  }
}

/** Where the middle of the viewport falls in wplace's global pixel coordinates. */
export const viewportCentreIn = (frame: TileFrame): { x: number; y: number } | null => {
  if (frame.quads.length === 0) return null
  const midX = frame.canvas.width / 2
  const midY = frame.canvas.height / 2
  for (const quad of frame.quads) {
    if (midX < quad.x || midX >= quad.x + quad.width) continue
    if (midY < quad.y || midY >= quad.y + quad.height) continue
    const scaleX = TILE_SIZE / quad.width
    const scaleY = TILE_SIZE / quad.height
    return {
      x: quad.tile.x * TILE_SIZE + (midX - quad.x) * scaleX,
      y: quad.tile.y * TILE_SIZE + (midY - quad.y) * scaleY,
    }
  }
  const first = frame.quads[0]
  if (first === undefined) return null
  return {
    x: wrapWorldX(first.tile.x * TILE_SIZE + ((midX - first.x) * TILE_SIZE) / first.width),
    y: first.tile.y * TILE_SIZE + ((midY - first.y) * TILE_SIZE) / first.height,
  }
}

/** Global canvas pixel under a browser client-coordinate point. */
export const canvasPixelAtIn = (
  frame: TileFrame,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null => {
  const box = frame.canvas.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) return null
  const ratioX = frame.canvas.width / box.width
  const ratioY = frame.canvas.height / box.height
  const px = (clientX - box.left) * ratioX
  const py = (clientY - box.top) * ratioY
  for (const quad of frame.quads) {
    if (px < quad.x || px >= quad.x + quad.width) continue
    if (py < quad.y || py >= quad.y + quad.height) continue
    return {
      x: quad.tile.x * TILE_SIZE + ((px - quad.x) * TILE_SIZE) / quad.width,
      y: quad.tile.y * TILE_SIZE + ((py - quad.y) * TILE_SIZE) / quad.height,
    }
  }
  return null
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

/** Browser client-coordinate position of a global canvas pixel. */
export const screenPointForIn = (
  frame: TileFrame,
  x: number,
  y: number,
): { x: number; y: number } | null => {
  return screenProjectionIn(frame)?.pointFor(x, y) ?? null
}

/** CSS pixels occupied by one wplace pixel in this frame. Pointer events use this coordinate
 * space, so the canvas backing-store/device-pixel ratio must be removed. */
export const cssPixelsPerCanvasPixelIn = (frame: TileFrame | null): { x: number; y: number } => {
  return screenProjectionIn(frame)?.pixelsPerCanvasPixel ?? { x: 1, y: 1 }
}
