import { count } from './debug.js'
import { getMap, onMapAttached, type PatchableMap } from './map-handle.js'
import { isWplacePatchEnabled, onWplacePatchChange } from './wplace-switches.js'
import { patchTileRefresh } from './wplace-tile-refresh.js'

/**
 * Performance patches for Wplace's own client, applied from inside the page.
 *
 * Wplace's map renders every frame while nobody touches it, and it re-downloads tiles that have not
 * changed. None of it is visible: the patches below remove the waste without changing anything a
 * Wplace user can see. Each one has its own switch (`wplace-switches.ts`), so a patch that turns out
 * to break something can be turned off from the console without a new release.
 *
 * Nothing here touches Wplace's anti-cheat: pawtect, the bot check, the fetch wrapper, the storage
 * sync, and Turnstile run exactly as they would without Caelestis.
 *
 * Painting input is handled elsewhere. Wplace flags untrusted events reaching its paint handlers
 * on the account, so by default Caelestis only filters the painter's real events (shift-paint,
 * the paint-target guard). Simulating input on Wplace's controls is opt-in, one switch per feature,
 * each naming the flags it trips (`SIMULATED_INPUT` in the shared package).
 */

/** Test seam: forget which maps and sources these patches touched. */
export const resetWplacePatches = (): void => {
  patchedMaps = new WeakSet()
  pausedByUs = new WeakSet()
  markerStyle?.remove()
  markerStyle = null
}

interface CanvasSourceLike {
  getCanvas(): unknown
  play(): void
  pause(): void
  _playing?: boolean
}

const HOVER_SOURCE = 'pixel-hover'

const isCanvasSource = (value: unknown): value is CanvasSourceLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as CanvasSourceLike).getCanvas === 'function' &&
  typeof (value as CanvasSourceLike).play === 'function' &&
  typeof (value as CanvasSourceLike).pause === 'function'

let pausedByUs = new WeakSet<object>()

/**
 * P1: pause the hover crosshair's canvas source.
 *
 * Wplace adds `pixel-hover` as a MapLibre canvas source without `animate: false`. A playing canvas
 * source reports a transition forever, so MapLibre renders the whole map every frame and re-uploads
 * the crosshair texture each time. The crosshair is drawn into its canvas once; hovering only calls
 * `setCoordinates`, which already asks for a frame, and a paused source still creates its texture on
 * the first `prepare`.
 *
 * Only this source. Wplace's draft layers are canvas sources too, and they draw placed pixels
 * straight into the canvas, so they need to keep playing to show them.
 */
const syncHoverCanvas = (map: PatchableMap): void => {
  const source = map.getSource?.(HOVER_SOURCE)
  if (!isCanvasSource(source)) return
  if (isWplacePatchEnabled('hover-canvas')) {
    if (source._playing === false) return
    source.pause()
    pausedByUs.add(source)
    count('wplace-patch:paused the hover canvas')
  } else if (pausedByUs.has(source)) {
    pausedByUs.delete(source)
    source.play()
    count('wplace-patch:resumed the hover canvas')
  }
}

const HIGHLIGHT_LAYER = /^highlight-area-(fill|line-white|line-color|image-layer)-(.+)$/

/** The order Wplace's `styledata` listener moves its top highlight layers in, last on top. */
const TOP_RANK: Readonly<Record<string, number>> = {
  'line-white': 0,
  'line-color': 1,
  'image-layer': 2,
}

/**
 * Whether a highlight-area move would leave the layer where Wplace's listener wants it anyway.
 *
 * Wplace listens to `styledata` and moves its highlight layers on every style update, and each move
 * is itself a style update. A plain "would this change the order" check does not end it: moving the
 * white line to the top always changes the order while the colour line is above it, and the colour
 * line's move then puts it back. So a move to the top counts as satisfied when everything above the
 * layer is a sibling from the same highlight that the listener moves after it. A move with a `before`
 * id counts as satisfied when the layer already sits directly below that id.
 */
const highlightMoveIsSatisfied = (
  order: readonly string[],
  id: string,
  before?: string,
): boolean => {
  const layer = HIGHLIGHT_LAYER.exec(id)
  if (layer === null) return false
  const at = order.indexOf(id)
  if (at < 0) return false
  if (before !== undefined) {
    const target = order.indexOf(before)
    return target >= 0 && at === target - 1
  }
  const rank = TOP_RANK[layer[1] as string]
  if (rank === undefined) return false
  for (let i = at + 1; i < order.length; i++) {
    const above = HIGHLIGHT_LAYER.exec(order[i] as string)
    if (above === null || above[2] !== layer[2]) return false
    const aboveRank = TOP_RANK[above[1] as string]
    if (aboveRank === undefined || aboveRank <= rank) return false
  }
  return true
}

let patchedMaps = new WeakSet<object>()

/**
 * P2: skip highlight-area moves that are already satisfied.
 *
 * MapLibre also restarts its sky transition on every style change, so the listener above kept the
 * map dirty at 60 fps whenever anything changed the style once: the art opacity slider, a theme
 * switch, or Caelestis adding a layer. Every other `moveLayer` call, ours included, goes straight
 * through.
 */
const guardHighlightMoves = (map: PatchableMap): void => {
  const original = map.moveLayer
  if (typeof original !== 'function') return
  const guarded = function (this: PatchableMap, id: string, before?: string): unknown {
    if (
      isWplacePatchEnabled('highlight-order') &&
      highlightMoveIsSatisfied(this.style?._order ?? [], id, before)
    ) {
      count('wplace-patch:skipped a satisfied highlight move')
      return this
    }
    return original.call(this, id, before)
  }
  try {
    Object.defineProperty(map, 'moveLayer', {
      value: guarded,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  } catch {
    count('wplace-patch:could not guard moveLayer')
  }
}

let markerStyle: HTMLStyleElement | null = null

/**
 * P6: pause Wplace's marker animations while the marker is hidden.
 *
 * The event marker is set to `opacity: 0` once zoomed in, but its float and two ping animations
 * keep running. MapLibre writes the opacity as an inline style, which serialises with a trailing
 * semicolon, so `opacity: 0;` cannot match `opacity: 0.5`.
 */
const syncMarkerAnimations = (): void => {
  if (!isWplacePatchEnabled('marker-animations')) {
    markerStyle?.remove()
    markerStyle = null
    return
  }
  if (markerStyle?.isConnected || typeof document === 'undefined' || document.head === null) return
  markerStyle = document.createElement('style')
  markerStyle.textContent =
    '.maplibregl-marker[style*="opacity: 0;"] .wplace-marker-root,' +
    '.maplibregl-marker[style*="opacity: 0;"] .wplace-marker-ping' +
    '{animation-play-state:paused}'
  document.head.append(markerStyle)
}

/** Apply every map patch. Idempotent: it runs on each map attach and each patch switch. */
export const applyWplacePatches = (map: PatchableMap | null): void => {
  syncMarkerAnimations()
  if (map === null) return
  if (!patchedMaps.has(map)) {
    patchedMaps.add(map)
    guardHighlightMoves(map)
    patchTileRefresh(map)
    // Pause a re-created hover source as soon as it loads, rather than up to a second later.
    map.on?.('sourcedata', (event) => {
      if (event.sourceId === HOVER_SOURCE) syncHoverCanvas(map)
    })
  }
  syncHoverCanvas(map)
}

/** Keep the patches on whichever map Wplace shows, and in step with their switches. */
export const installWplacePatches = (): void => {
  onMapAttached(applyWplacePatches)
  onWplacePatchChange(() => applyWplacePatches(getMap()))
}
