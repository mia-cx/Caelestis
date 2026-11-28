import { log, warn } from './debug.js'
import { notifyListeners } from './listeners.js'
import { pageWindow } from './page-world.js'

/**
 * A live reference to Wplace's MapLibre `Map`.
 *
 * It is on no global, on no DOM node and in no module export. What does work: **the Map assigns
 * distinctive private fields to itself while it is being built.** A setter on `Object.prototype`
 * for one of those names sees the assignment, and `this` at that moment *is* the Map. The trap comes
 * off as soon as it succeeds, and goes back on only once the captured map's canvas leaves the
 * document.
 *
 * This is a deliberate piece of nastiness, so it is fenced in:
 *
 * - It only claims an object that actually looks like a Map, so an unrelated assignment is ignored.
 * - Every intercepted assignment is immediately materialised as the same ordinary own property the
 *   engine would have created, so nothing downstream can tell.
 * - Everything that depends on it degrades: without a Map we fall back to the URL, which reloads.
 *
 * It belongs at `document-start`, ahead of everything, where it catches the map as it is built.
 * Some userscript managers inject later than that (Edge and Firefox on Android, iOS Userscripts),
 * after the map exists. The map then still gains a few fields the first time it eases, so a late
 * start catches it on the painter's first fling or the first programmatic move. A slow drag or a
 * wheel zoom assigns none of them.
 */

/**
 * Names the Map first assigns itself: during `_setupContainer` (measured: `_canvasContainer` fires),
 * and, for a script that starts after that, on its first ease, rotate or pitch (measured on Wplace's
 * map: none of these exist once it has loaded, and all of them once it has moved).
 */
const WITNESS_PROPERTIES = [
  '_canvasContainer',
  '_controlContainer',
  '_canvas',
  '_easeOptions',
  '_easeStart',
  '_padding',
  '_rotating',
  '_pitching',
  '_rolling',
] as const

/** A MapLibre custom layer, as `addLayer` takes it. */
export interface CustomLayer {
  readonly id: string
  readonly type: 'custom'
}

type MapEvent = 'move' | 'moveend' | 'style.load' | 'sourcedata'

/** What a map event carries that we read: the input behind a move, the source of a `sourcedata`. */
interface MapEventData {
  readonly originalEvent?: Event
  readonly sourceId?: string
}

/**
 * The part of MapLibre's `Map` we use. `style` and `painter` are MapLibre-private: read them
 * defensively, since a MapLibre update can change their shape without notice.
 */
export interface MapLike {
  flyTo(options: Record<string, unknown>): unknown
  easeTo(options: Record<string, unknown>): unknown
  jumpTo(options: Record<string, unknown>): unknown
  getZoom(): number
  getCenter(): { lng: number; lat: number }
  panBy(offset: [number, number], options?: Record<string, unknown>): unknown
  setStyle(style: string): unknown
  getCanvas(): HTMLCanvasElement
  unproject(point: [number, number]): { lng: number; lat: number }
  project(lngLat: [number, number]): { x: number; y: number }
  on(type: MapEvent, listener: (event: MapEventData) => void): unknown
  off(type: MapEvent, listener: (event: MapEventData) => void): unknown
  /** MapLibre-private: re-request some or all tiles of a source. */
  refreshTiles?(id: string, tiles?: readonly { x: number; y: number; z: number }[]): unknown
  cameraForBounds?(
    bounds: [[number, number], [number, number]],
    options?: Record<string, unknown>,
  ): { center: { lng: number; lat: number } | [number, number]; zoom: number } | undefined
  triggerRepaint(): void
  isMoving(): boolean
  addLayer(layer: CustomLayer, before?: string): unknown
  getLayer(id: string): unknown
  moveLayer(id: string, before?: string): unknown
  getSource(id: string): unknown
  readonly style?: {
    /** MapLibre's draw order, custom layers included; `getStyle` leaves those out. */
    readonly _order?: readonly string[]
    /** Whether the style can take layers. */
    readonly _loaded?: boolean
    /** Style layers by id; a custom layer's `implementation` is the object its owner added. */
    readonly _layers?: Readonly<Record<string, { readonly implementation?: object }>>
    /** Per source; MapLibre has used both a `Map` and a plain record here. */
    readonly tileManagers?: Record<string, unknown>
  }
  readonly painter?: {
    /** Index into `style._order` of the layer being drawn. */
    readonly currentLayer?: number
    readonly options?: { readonly moving?: boolean }
    readonly transform?: {
      calculatePosMatrix?(
        coordinate: unknown,
        aligned?: boolean,
        asFloat32?: boolean,
      ): ArrayLike<number>
    }
  }
}

let captured: MapLike | null = null
/** The captured map, once its style has taken layers at least once. */
let attached: MapLike | null = null
const attachListeners = new Set<(map: MapLike) => void>()

const looksLikeMap = (value: unknown): value is MapLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as MapLike).flyTo === 'function' &&
  typeof (value as MapLike).getZoom === 'function'

/**
 * The page's `Object.prototype`, which in a separate-realm sandbox is not this one.
 *
 * MapLibre's objects inherit from the page's. Trapping the local prototype means the assignment this
 * is waiting for never reaches a setter, and `getMap()` stays null for the session.
 */
const pageProto = (realm: Window & typeof globalThis = pageWindow()): object =>
  (realm as unknown as { Object: ObjectConstructor }).Object.prototype

const installed = new Set<string>()
const ours = new Map<string, PropertyDescriptor>()
let installedPrototype: object | null = null

/**
 * The traps come off when the map is caught, and not on a clock: this setter is the only way the
 * map is ever found, so a MapLibre that constructs late would otherwise be missed for the session.
 */
const removeTraps = (): void => {
  const prototype = installedPrototype
  for (const property of installed) {
    if (prototype === null) continue
    const current = Object.getOwnPropertyDescriptor(prototype, property)
    // Only if it is still ours. Someone else's setter under this name is theirs to remove.
    if (current === undefined || current.set !== ours.get(property)?.set) continue
    delete (prototype as Record<string, unknown>)[property]
  }
  installed.clear()
  ours.clear()
  installedPrototype = null
}

/** Release the map once its canvas leaves the document, and wait for its replacement. */
const watchDetach = (map: MapLike): void => {
  const canvas = map.getCanvas()
  const document = canvas.ownerDocument
  const observer = new (document.defaultView?.MutationObserver ?? MutationObserver)(() => {
    if (canvas.isConnected) return
    observer.disconnect()
    if (captured !== map) return
    releaseMapCapture()
    installMapCapture()
  })
  observer.observe(document, { childList: true, subtree: true })
}

/**
 * Announce the map whenever its style can take layers: once it first loads, and again after each
 * style swap, which drops custom layers.
 */
const announceWhenReady = (map: MapLike): void => {
  const announce = (): void => {
    if (captured !== map) return
    attached = map
    notifyListeners(attachListeners, 'map attach listener failed', map)
  }
  map.on('style.load', announce)
  if (map.style?._loaded === true) announce()
}

export const installMapCapture = (realm: Window & typeof globalThis = pageWindow()): void => {
  const prototype = pageProto(realm)
  // One capture window owns one realm. A second install cannot safely move traps that page code may
  // already be executing through; release first if a caller deliberately wants another realm.
  if (installedPrototype !== null && installedPrototype !== prototype) return
  if (installedPrototype === prototype && installed.size > 0) return
  installedPrototype = prototype
  for (const property of WITNESS_PROPERTIES) {
    try {
      const original = Object.getOwnPropertyDescriptor(prototype, property)
      // An inherited descriptor already has page-visible assignment semantics. Replacing it, even
      // temporarily, can suppress a setter or turn a rejected write into an own property. The other
      // witness names are enough; an occupied one belongs to whoever installed it first.
      if (original !== undefined) continue
      const descriptor: PropertyDescriptor = {
        configurable: true,
        get() {
          return undefined
        },
        set(this: object, value: unknown) {
          // Materialise the inherited assignment as the ordinary own property it was trying to
          // create. Reflect reports a non-extensible receiver without throwing through page code.
          // Everything beyond completing the assignment is wrapped, because it runs inside someone
          // else's assignment statement: a throw here would abort whatever was initialising, which
          // for MapLibre is the map itself.
          try {
            if (
              !Reflect.defineProperty(this, property, {
                value,
                writable: true,
                configurable: true,
                enumerable: true,
              })
            )
              return
            if (looksLikeMap(this) && captured === null) {
              captured = this
              log(`captured the map via ${property}`)
              removeTraps()
              // The Map is mid-construction; listen once its constructor has returned. A map Wplace
              // removes before its style ever loads must still give way to its replacement.
              queueMicrotask(() => {
                try {
                  watchDetach(this)
                } catch (error) {
                  warn('could not watch the map for its removal', String(error))
                }
                try {
                  announceWhenReady(this)
                } catch (error) {
                  warn('could not watch the map for its style', String(error))
                }
              })
            }
          } catch {
            // Detection is best-effort; a failure here must not become the page's problem.
          }
        },
      }
      Object.defineProperty(prototype, property, descriptor)
      installed.add(property)
      ours.set(property, descriptor)
    } catch {
      // A property already defined non-configurably is not worth fighting over; the others remain.
    }
  }
}

export const getMap = (): MapLike | null => captured

/**
 * Whether Wplace's map is on the page but was built before Caelestis started, so it has not been
 * captured yet: a late userscript manager. What needs the map waits for a capture on the painter's
 * first fling; what doesn't should go ahead without it.
 */
export const mapCaptureMissed = (): boolean =>
  captured === null && pageWindow().document.querySelector('canvas.maplibregl-canvas') !== null

/** Remove the capture traps and release a disconnected map before capturing its replacement. */
export const releaseMapCapture = (): void => {
  removeTraps()
  captured = null
  attached = null
}

/**
 * Run `listener` with the map each time its style can take layers: when a map is captured and
 * loaded, after a style swap, and for a replacement map. A map already attached is passed at once.
 */
export const onMapAttached = (listener: (map: MapLike) => void): (() => void) => {
  attachListeners.add(listener)
  if (attached !== null) listener(attached)
  return () => attachListeners.delete(listener)
}

/**
 * The slice of the map the Wplace performance patches use. Every member is optional, so a patch
 * still applies, partly, to a MapLibre that lacks one, and a test can stand in for the map with less.
 */
export type PatchableMap = Partial<
  Pick<MapLike, 'getSource' | 'refreshTiles' | 'moveLayer' | 'on' | 'style'>
> & {
  /** Only whether the canvas is still in the document. */
  getCanvas?(): { readonly isConnected: boolean }
}
