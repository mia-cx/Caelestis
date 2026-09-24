import { count, log } from './debug.js'
import { pageWindow } from './page-world.js'
import { isWplacePatchEnabled, type PatchableMap } from './wplace-patches.js'

const SOURCE = 'pixel-art-layer'
const FULL_REFRESH_INTERVAL = 10
const MAX_FULL_REFRESH_AGE_MS = 90_000
const FRAME_FALLBACK_MS = 100

type Tile = { x: number; y: number; z: number }
type Preview = Map<string, Set<string>>

interface TapState {
  preview: Preview
  applied: Preview
  draftPending: boolean
  passThrough: boolean
}

const taps = new WeakMap<object, TapState>()

const tileKey = (tile: Tile): string => `${tile.z}/${tile.x}/${tile.y}`
const previewTileKey = (x: number, y: number, season: number): string => `${season}/${x}/${y}`

const previewFrom = (data: unknown): Preview => {
  if (!Array.isArray(data)) throw new Error('Invalid preview data')
  const preview: Preview = new Map()
  for (const item of data) {
    const pixel = item as {
      tile?: readonly number[]
      pixel?: readonly number[]
      season?: number
      color?: { r: number; g: number; b: number; a: number }
    }
    if (
      !Array.isArray(pixel.tile) ||
      !Array.isArray(pixel.pixel) ||
      pixel.tile.length !== 2 ||
      pixel.pixel.length !== 2 ||
      !pixel.tile.every(Number.isInteger) ||
      !pixel.pixel.every(Number.isInteger) ||
      !Number.isInteger(pixel.season) ||
      pixel.color === undefined ||
      ![pixel.color.r, pixel.color.g, pixel.color.b, pixel.color.a].every(Number.isFinite)
    ) {
      throw new Error('Invalid preview pixel')
    }
    const key = previewTileKey(
      pixel.tile[0] as number,
      pixel.tile[1] as number,
      pixel.season as number,
    )
    const pixels = preview.get(key) ?? new Set<string>()
    pixels.add(
      `${pixel.pixel[0]},${pixel.pixel[1]}:${pixel.color.r},${pixel.color.g},${pixel.color.b},${pixel.color.a}`,
    )
    preview.set(key, pixels)
  }
  return preview
}

/**
 * Tiles whose draft pixels differ, at the source's tile zoom.
 *
 * Preview keys carry the season, which is not a zoom level: MapLibre matches `refreshTiles` ids on
 * their canonical `z/x/y`, so a season in `z` would match no tile and the draft would never show.
 */
const changedPreviewTiles = (before: Preview, after: Preview, zoom: number): Tile[] => {
  const changed = new Map<string, Tile>()
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(key) ?? new Set<string>()
    const next = after.get(key) ?? new Set<string>()
    if (previous.size === next.size && [...previous].every((pixel) => next.has(pixel))) continue
    const [, x, y] = key.split('/').map(Number)
    const tile = { x: x as number, y: y as number, z: zoom }
    changed.set(tileKey(tile), tile)
  }
  return [...changed.values()]
}

const samePreview = (a: Preview, b: Preview): boolean => {
  if (a.size !== b.size) return false
  for (const [key, pixels] of a) {
    const other = b.get(key)
    if (other === undefined || other.size !== pixels.size) return false
    for (const pixel of pixels) if (!other.has(pixel)) return false
  }
  return true
}

/** Wplace's art source has one zoom level (minzoom = maxzoom), which is the zoom of every tile. */
const sourceZoom = (source: unknown): number => {
  const zoom = (source as { maxzoom?: unknown } | undefined)?.maxzoom
  if (typeof zoom !== 'number' || !Number.isInteger(zoom))
    throw new Error('Wplace tile zoom unavailable')
  return zoom
}

/**
 * Watch the page's worker messages before Wplace installs its own listener. The worker sends no
 * tile list with its refresh, so this is the only point where draft changes can be attributed to
 * tiles. The original postMessage runs first with the same receiver and arguments; observation
 * errors remain ours and cannot break painting.
 */
export const installServiceWorkerTap = (realm: Window & typeof globalThis = pageWindow()): void => {
  if (taps.has(realm)) return
  const worker = realm.ServiceWorker?.prototype
  const original = worker?.postMessage
  const container = realm.navigator?.serviceWorker
  if (typeof original !== 'function' || container === undefined) return
  const state: TapState = {
    preview: new Map(),
    applied: new Map(),
    draftPending: false,
    passThrough: false,
  }
  const observed = function (this: ServiceWorker, ...args: unknown[]): unknown {
    const result = Reflect.apply(original, this, args)
    try {
      const message = args[0] as { type?: unknown; data?: unknown } | null
      // Only a change to what the tiles show is a draft refresh. Wplace also posts
      // `clearPixelPreview` every few seconds with nothing drafted; counting that as a change turned
      // every periodic refresh into an empty draft refresh, and tiles stopped updating.
      if (message?.type === 'previewPixels') {
        state.preview = previewFrom(message.data)
        state.draftPending = !samePreview(state.applied, state.preview)
      } else if (message?.type === 'clearPixelPreview') {
        state.preview = new Map()
        state.draftPending = !samePreview(state.applied, state.preview)
      } else if (
        message?.type === 'paintPixels' ||
        message?.type === 'unpaintPixels' ||
        message?.type === 'refreshPixelArt'
      ) {
        state.passThrough = true
      }
    } catch {
      state.passThrough = true
      count('wplace-patch:worker observation failed')
    }
    return result
  }
  try {
    Object.defineProperty(worker, 'postMessage', {
      value: observed,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    container.addEventListener('message', (event) => {
      try {
        const message = event.data as { type?: unknown; id?: unknown } | null
        if (message?.type === 'refreshPixelArt' && message.id === undefined) {
          state.passThrough = true
        }
      } catch {
        state.passThrough = true
      }
    })
    taps.set(realm, state)
  } catch {
    count('wplace-patch:could not tap service worker')
  }
}

/** MapLibre 5's per-source tile manager, which Wplace's pinned version keeps on `style`. */
const managerFor = (map: PatchableMap): unknown => map.style?.tileManagers?.[SOURCE]

const inViewTiles = (manager: unknown): Tile[] => {
  const source = manager as {
    _inViewTiles?: { getAllTiles?: () => unknown }
  }
  const entries = source?._inViewTiles?.getAllTiles?.()
  if (!Array.isArray(entries)) throw new Error('MapLibre in-view tiles unavailable')
  const tiles = entries.map((entry) => {
    const tile = (entry as { tileID?: { canonical?: Tile } }).tileID?.canonical
    if (!tile || ![tile.x, tile.y, tile.z].every(Number.isInteger)) {
      throw new Error('MapLibre tile coordinate unavailable')
    }
    return { x: tile.x, y: tile.y, z: tile.z }
  })
  return [...new Map(tiles.map((tile) => [tileKey(tile), tile])).values()]
}

/**
 * In-view tiles whose last load failed.
 *
 * A HEAD signature is recorded when the reload is requested, not when it succeeds. A reload that
 * then fails (a 429, a dropped connection) would match its signature on every later check and stay
 * broken until the safety refresh; MapLibre marks it `errored`, so those always go back in.
 */
const erroredTiles = (manager: unknown): Set<string> => {
  const entries = (
    manager as { _inViewTiles?: { getAllTiles?: () => unknown } }
  )?._inViewTiles?.getAllTiles?.()
  const errored = new Set<string>()
  if (!Array.isArray(entries)) return errored
  for (const entry of entries) {
    const tile = entry as { state?: unknown; tileID?: { canonical?: Tile } }
    if (tile.state === 'errored' && tile.tileID?.canonical !== undefined)
      errored.add(tileKey(tile.tileID.canonical))
  }
  return errored
}

const resetCache = (manager: unknown): void => {
  const cache = (manager as { _outOfViewCache?: { reset?: () => void } })?._outOfViewCache
  if (typeof cache?.reset !== 'function') throw new Error('MapLibre off-screen cache unavailable')
  cache.reset()
}

const tileUrl = (source: unknown, tile: Tile): string => {
  const template = (source as { tiles?: unknown })?.tiles
  if (!Array.isArray(template) || typeof template[0] !== 'string') {
    throw new Error('Wplace tile URL unavailable')
  }
  const url = template[0]
    .replaceAll('{x}', String(tile.x))
    .replaceAll('{y}', String(tile.y))
    .replaceAll('{z}', String(tile.z))
  if (url.includes('{')) throw new Error('Wplace tile URL unresolved')
  return url
}

/**
 * How long one HEAD may take. `fetch` never times out on its own, and a round only ends when every
 * request settles; one stalled request would otherwise hold `checking` forever and stop every later
 * refresh, the safety full refresh included.
 */
const HEAD_TIMEOUT_MS = 10_000

const signature = async (url: string): Promise<string | null> => {
  let timer: number | undefined
  try {
    // Wplace wraps page fetch for anti-cheat. Resolve it for each request, after its wrapper exists.
    // The signal comes from the same realm as that fetch, which rejects a foreign AbortSignal.
    const realm = pageWindow()
    const deadline = new realm.AbortController()
    timer = realm.setTimeout(() => deadline.abort(), HEAD_TIMEOUT_MS)
    const response = await realm.fetch(url, { method: 'HEAD', signal: deadline.signal })
    if (!response.ok) return null
    const modified = response.headers.get('Last-Modified')
    const length = response.headers.get('Content-Length')
    return modified && length ? `${modified}|${length}` : null
  } catch {
    return null
  } finally {
    if (timer !== undefined) pageWindow().clearTimeout(timer)
  }
}

/** The latest patched map's unconditional refresh; false when that map has left the page. */
let refreshAll: (() => boolean) | null = null
let refreshAllScheduled = false
/**
 * A full refresh no live patched map has taken yet.
 *
 * Capture can widen its scope before the attach loop has patched the current map, or while the last
 * patched one is being replaced. Dropping the request then would leave its stale pixels until the
 * safety refresh, so it waits for the next map instead.
 */
let refreshAllPending = false

const deliverRefreshAll = (): void => {
  refreshAllScheduled = false
  if (!refreshAllPending) return
  try {
    if (refreshAll?.() === true) refreshAllPending = false
  } catch {
    refreshAllPending = false
    count('wplace-patch:full tile refresh failed')
  }
}

const scheduleRefreshAll = (): void => {
  if (refreshAllScheduled) return
  refreshAllScheduled = true
  pageWindow().setTimeout(deliverRefreshAll, 0)
}

/**
 * Re-download every visible Wplace tile once.
 *
 * Caelestis keeps captured pixels while capture is off, on the promise that turning it back on
 * re-reads everything visible. Wplace's six-second re-download used to keep that promise; the
 * conditional refresh above does not, so a tile that changed unread would keep its old pixels. One
 * full refresh when capture starts caring about more tiles restores it. With the patch off, Wplace
 * reloads everything on its own timer anyway.
 */
export const refreshAllWplaceTiles = (): void => {
  if (!isWplacePatchEnabled('tile-refresh')) return
  refreshAllPending = true
  scheduleRefreshAll()
}

/**
 * Watch what tile capture cares about, and re-read every visible tile when that grows.
 *
 * Keys name the reasons capture wants pixels, such as Paint being open or a template at its
 * position. Only a new key widens the scope; a key disappearing never needs fresh pixels.
 */
export const watchCaptureScope = (): ((keys: Iterable<string>) => void) => {
  let scope = new Set<string>()
  return (keys) => {
    const next = new Set(keys)
    for (const key of next) {
      if (scope.has(key)) continue
      count('wplace-patch:capture scope widened')
      refreshAllWplaceTiles()
      break
    }
    scope = next
  }
}

/**
 * P3 and P4: keep MapLibre's off-screen invalidation, but avoid re-downloading unchanged tiles.
 * A full refresh every tenth check bounds the risk from Last-Modified's one-second resolution.
 * Draft messages have exact tile attribution, so they can skip HEAD and merge within one frame.
 */
export const patchTileRefresh = (map: PatchableMap): void => {
  const original = map.refreshTiles
  if (typeof original !== 'function') return
  let periodicCalls = 0
  let lastFullAt = Date.now()
  let checking = false
  let draftScheduled = false
  let refreshRevision = 0
  const signatures = new Map<string, string>()
  const full = (receiver: PatchableMap): unknown => {
    lastFullAt = Date.now()
    refreshRevision++
    const state = taps.get(pageWindow())
    if (state) {
      state.passThrough = false
      state.draftPending = false
      state.applied = state.preview
    }
    return original.call(receiver, SOURCE)
  }
  refreshAll = () => {
    if (map.getCanvas?.().isConnected === false) return false
    count('wplace-patch:full tile refresh for capture')
    full(map)
    return true
  }
  // A scope that widened before this map was patched still owes it one full refresh.
  if (refreshAllPending) scheduleRefreshAll()
  /** The timer's refresh: HEAD every visible tile and reload only those that changed. */
  const periodic = (receiver: PatchableMap): unknown => {
    if (!isWplacePatchEnabled('tile-refresh')) return full(receiver)
    if (checking) {
      count('wplace-patch:dropped overlapping tile check')
      return receiver
    }
    periodicCalls++
    if (
      periodicCalls % FULL_REFRESH_INTERVAL === 0 ||
      Date.now() - lastFullAt > MAX_FULL_REFRESH_AGE_MS
    ) {
      count('wplace-patch:safety full tile refresh')
      return full(receiver)
    }
    const source = receiver.getSource?.(SOURCE)
    const manager = managerFor(receiver)
    if (!source || !manager) return full(receiver)
    const visible = inViewTiles(manager)
    const requests = visible.map((tile) => ({ tile, url: tileUrl(source, tile) }))
    resetCache(manager)
    checking = true
    const checkedRevision = refreshRevision
    void Promise.all(
      requests.map(async ({ tile, url }) => ({ tile, url, value: await signature(url) })),
    )
      .then((results) => {
        checking = false
        if (
          checkedRevision !== refreshRevision ||
          receiver.getSource?.(SOURCE) !== source ||
          managerFor(receiver) !== manager ||
          requests.some(({ tile, url }) => tileUrl(source, tile) !== url)
        )
          return
        const changed: Tile[] = []
        const errored = erroredTiles(manager)
        for (const { tile, url, value } of results) {
          if (value === null || signatures.get(url) !== value || errored.has(tileKey(tile)))
            changed.push(tile)
          if (value === null) signatures.delete(url)
          else signatures.set(url, value)
        }
        const visibleUrls = new Set(requests.map(({ url }) => url))
        for (const url of signatures.keys()) if (!visibleUrls.has(url)) signatures.delete(url)
        count('wplace-patch:checked tiles', visible.length)
        count('wplace-patch:reloaded changed tiles', changed.length)
        if (changed.length > 0) original.call(receiver, SOURCE, changed)
        log('fetch', 'checked Wplace tiles', { checked: visible.length, changed: changed.length })
      })
      .catch(() => {
        checking = false
        if (checkedRevision !== refreshRevision) return
        count('wplace-patch:tile check fallback')
        if (receiver.getSource?.(SOURCE) === source) full(receiver)
      })
    return receiver
  }
  const wrapped = function (
    this: PatchableMap,
    ...args: [id: string, tiles?: readonly Tile[]]
  ): unknown {
    const [id, tiles] = args
    if (id !== SOURCE || tiles !== undefined) return Reflect.apply(original, this, args)
    try {
      const realm = pageWindow()
      const state = taps.get(realm)
      if (
        state?.passThrough ||
        (state?.draftPending && !isWplacePatchEnabled('draft-refresh')) ||
        (!isWplacePatchEnabled('tile-refresh') && !isWplacePatchEnabled('draft-refresh'))
      ) {
        count('wplace-patch:full tile refresh cause')
        return full(this)
      }
      if (state?.draftPending && isWplacePatchEnabled('draft-refresh')) {
        if (draftScheduled) return this
        draftScheduled = true
        let done = false
        let timeout: number | undefined
        const flush = (): void => {
          if (done) return
          done = true
          draftScheduled = false
          if (timeout !== undefined) realm.clearTimeout(timeout)
          try {
            // Wplace follows a paint with its own full refresh once the worker replies.
            if (state.passThrough) return
            // Drafts settled back to what the tiles show, or this was the timer all along: never
            // swallow the call, or the tiles stop updating.
            if (!state.draftPending) {
              periodic(this)
              return
            }
            const changed = changedPreviewTiles(
              state.applied,
              state.preview,
              sourceZoom(this.getSource?.(SOURCE)),
            )
            state.applied = state.preview
            state.draftPending = false
            if (changed.length === 0) {
              periodic(this)
              return
            }
            const manager = managerFor(this)
            resetCache(manager)
            refreshRevision++
            original.call(this, SOURCE, changed)
            log('fetch', 'narrowed draft tile refresh', { tiles: changed.length })
          } catch {
            count('wplace-patch:draft refresh fallback')
            full(this)
          }
        }
        timeout = realm.setTimeout(flush, FRAME_FALLBACK_MS)
        try {
          realm.requestAnimationFrame(flush)
        } catch {
          // The timeout still flushes a background tab or a missing animation-frame API.
        }
        return this
      }
      return periodic(this)
    } catch {
      count('wplace-patch:tile refresh fallback')
      return full(this)
    }
  }
  try {
    Object.defineProperty(map, 'refreshTiles', {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  } catch {
    count('wplace-patch:could not guard refreshTiles')
  }
}
