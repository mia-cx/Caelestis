import { count, log } from './debug.js'
import { patchTileRefresh } from './wplace-tile-refresh.js'

/**
 * Performance patches for Wplace's own client, applied from inside the page.
 *
 * Wplace's map renders every frame while nobody touches it, and it re-downloads tiles that have not
 * changed. None of it is visible: the patches below remove the waste without changing anything a
 * Wplace user can see. Each one has its own switch, so a patch that turns out to break something can
 * be turned off from the console without a new release.
 *
 * Nothing here touches Wplace's anti-cheat: pawtect, the bot check, the fetch wrapper, the storage
 * sync, and Turnstile run exactly as they would without Caelestis.
 */
export const WPLACE_PATCHES = {
  'hover-canvas': "Stop Wplace's pixel-hover canvas source from rendering the map every frame",
  'highlight-order': "Skip Wplace's highlight-area layer moves that are already satisfied",
  'tile-refresh': 'Reload only the Wplace tiles that changed since they were last fetched',
  'draft-refresh': 'Reload only the tiles whose draft pixels changed',
  'capture-dedupe': "Skip Caelestis's tile pixel capture when a tile's bytes are unchanged",
  'marker-animations': "Pause Wplace's marker animations while the marker is hidden",
} as const

export type WplacePatch = keyof typeof WPLACE_PATCHES

const STORAGE_KEY = 'caelestis.wplace-patches.v1'

// biome-ignore lint/suspicious/noExplicitAny: userscript-manager APIs exist only in their sandbox
const gm = globalThis as any

const isPatch = (value: unknown): value is WplacePatch =>
  typeof value === 'string' && Object.hasOwn(WPLACE_PATCHES, value)

/** The stored value is the list of patches switched off, so a new patch starts on. */
const readDisabled = (): Set<WplacePatch> => {
  try {
    const raw =
      typeof gm.GM_getValue === 'function'
        ? gm.GM_getValue(STORAGE_KEY, '[]')
        : (globalThis.localStorage?.getItem(STORAGE_KEY) ?? '[]')
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter(isPatch) : [])
  } catch {
    return new Set()
  }
}

const writeDisabled = (disabled: ReadonlySet<WplacePatch>): void => {
  try {
    const raw = JSON.stringify([...disabled])
    if (typeof gm.GM_setValue === 'function') gm.GM_setValue(STORAGE_KEY, raw)
    else globalThis.localStorage?.setItem(STORAGE_KEY, raw)
  } catch {
    // The switch still applies for this session.
  }
}

let disabled: Set<WplacePatch> | null = null
const listeners = new Set<(patch: WplacePatch, enabled: boolean) => void>()

const disabledPatches = (): Set<WplacePatch> => {
  disabled ??= readDisabled()
  return disabled
}

export const isWplacePatchEnabled = (patch: WplacePatch): boolean => !disabledPatches().has(patch)

export const setWplacePatchEnabled = (patch: WplacePatch, enabled: boolean): void => {
  const current = disabledPatches()
  if (current.has(patch) === !enabled) return
  if (enabled) current.delete(patch)
  else current.add(patch)
  writeDisabled(current)
  log('install', `Wplace patch ${patch} ${enabled ? 'on' : 'off'}`)
  for (const listener of listeners) {
    try {
      listener(patch, enabled)
    } catch {
      count('wplace-patch:listener failed')
    }
  }
}

/** Notified when a patch is switched on or off, so it can apply or undo itself immediately. */
export const onWplacePatchChange = (
  listener: (patch: WplacePatch, enabled: boolean) => void,
): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const wplacePatchStates = (): Record<WplacePatch, { enabled: boolean; what: string }> =>
  Object.fromEntries(
    (Object.keys(WPLACE_PATCHES) as WplacePatch[]).map((patch) => [
      patch,
      { enabled: isWplacePatchEnabled(patch), what: WPLACE_PATCHES[patch] },
    ]),
  ) as Record<WplacePatch, { enabled: boolean; what: string }>

/** Test seam. */
export const resetWplacePatches = (): void => {
  disabled = null
  listeners.clear()
  patchedMaps = new WeakSet()
  pausedByUs = new WeakSet()
  markerStyle?.remove()
  markerStyle = null
}

/** The slice of MapLibre's `Map` these patches use. */
export interface PatchableMap {
  getSource?(id: string): unknown
  refreshTiles?(id: string, tiles?: readonly { x: number; y: number; z: number }[]): unknown
  moveLayer?(id: string, before?: string): unknown
  on?(type: string, listener: (event: { sourceId?: string }) => void): unknown
  style?: {
    _order?: readonly string[]
    tileManagers?: ReadonlyMap<string, unknown> | Record<string, unknown>
    sourceCaches?: ReadonlyMap<string, unknown> | Record<string, unknown>
  }
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
export const highlightMoveIsSatisfied = (
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
  const enabled = isWplacePatchEnabled('marker-animations')
  if (markerStyle === null) {
    if (!enabled || typeof document === 'undefined' || document.head === null) return
    markerStyle = document.createElement('style')
    markerStyle.dataset.caelestis = 'wplace-marker-animations'
    markerStyle.textContent =
      '.maplibregl-marker[style*="opacity: 0;"] .wplace-marker-root,' +
      '.maplibregl-marker[style*="opacity: 0;"] .wplace-marker-ping' +
      '{animation-play-state:paused}'
    document.head.append(markerStyle)
  }
  markerStyle.disabled = !enabled
}

/**
 * Apply every map patch. Idempotent, and cheap enough for the one-second attach loop, which also
 * catches the hover source being re-created after a theme switch.
 */
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
