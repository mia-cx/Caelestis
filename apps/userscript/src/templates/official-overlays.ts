import { latLngToCanvasPixel } from '@caelestis/shared'
import { warn } from '../debug.js'
import { forgetServerTemplate, hasRoomForServerTemplate, putServerTemplate } from './local-store.js'
import type { TemplateProgress } from './mismatch.js'
import { findWplaceModules, paletteIndices } from './native-store.js'
import { rememberNodes } from './server-nodes.js'
import { OFFICIAL_OVERLAY_OWNER } from './wplace-owned.js'

/**
 * Wplace's official event overlays, listed and drawn by Caelestis.
 *
 * Wplace's event module knows every fragment: where it sits, when it opens, and how far the
 * community has painted it. That module feeds the read-only Events folder.
 *
 * Wplace draws each open fragment near the viewport as its own custom map layer, outside its
 * template store. That layer already holds the quantised art, so Caelestis mirrors exactly what
 * Wplace would draw, for as long as Wplace would draw it, and hides Wplace's copy. The art then
 * appears once, in Caelestis's styling and with its interactions, while memory stays bounded to
 * the fragments in view.
 */

export const OFFICIAL_EVENTS_TREE_KEY = 'official-events'
const SEAL_LAYER = /^seven-seals-template-(\d+)$/
const REFRESH_MS = 5 * 60_000
/** Longer `setTimeout` delays overflow and fire at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

export interface OfficialGroup {
  /** Folder id, unique across events. */
  readonly id: string
  readonly name: string
}

export interface OfficialFragment {
  readonly index: number
  /** The Caelestis template id its pixels mirror into. */
  readonly templateId: string
  readonly name: string
  /** Its name inside its group's folder. */
  readonly shortName: string
  readonly group: OfficialGroup
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly opensAt: number
}

export interface OfficialEvent {
  /** Folder id. */
  readonly id: string
  readonly name: string
  readonly groups: readonly OfficialGroup[]
  /** Every fragment, opened or not. */
  readonly fragments: readonly OfficialFragment[]
}

interface ProgressStore {
  copyState(fragment: { index: number }): {
    readonly paintedPixels: number
    readonly totalPixels: number
  } | null
  refresh(): Promise<void>
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const templateIdOf = (index: number): string =>
  `srv:${encodeURIComponent(OFFICIAL_OVERLAY_OWNER)}:seven-seals-template-${index}`

let event: OfficialEvent | null = null
let progressStore: ProgressStore | null = null
const listeners = new Set<() => void>()
const notify = (): void => {
  for (const listener of listeners) listener()
}

/** Called when fragments open, progress refreshes, or the event first loads. */
export const onOfficialOverlaysChange = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The current event with only its opened fragments, or null outside an event. */
export const officialEvent = (now = Date.now()): OfficialEvent | null =>
  event === null
    ? null
    : { ...event, fragments: event.fragments.filter((fragment) => fragment.opensAt <= now) }

/** Wplace's own count of correct pixels kept on a fragment. */
export const officialProgress = (fragment: OfficialFragment): TemplateProgress | undefined => {
  const state = progressStore?.copyState(fragment)
  if (
    !record(state) ||
    !Number.isSafeInteger(state.paintedPixels) ||
    !Number.isSafeInteger(state.totalPixels)
  )
    return undefined
  const painted = Math.min(state.paintedPixels, state.totalPixels)
  return {
    completed: painted,
    known: painted,
    mismatched: 0,
    unpainted: 0,
    total: state.totalPixels,
  }
}

/** Validate Wplace's event module: an `id`/`titleEn` record and a list of placed fragments. */
const readEvent = (module: Record<string, unknown>): OfficialEvent | null => {
  const exports = Object.values(module)
  const info = exports.find(
    (value): value is { id: string; titleEn: string } =>
      record(value) && typeof value.id === 'string' && typeof value.titleEn === 'string',
  )
  const copies = exports.find(
    (value): value is unknown[] =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => record(item) && 'bounds' in item),
  )
  if (info === undefined || copies === undefined) return null
  const groups = new Map<number, OfficialGroup>()
  const fragments: OfficialFragment[] = []
  for (const copy of copies) {
    if (!record(copy) || !record(copy.bounds) || !record(copy.seal)) return null
    const { index, number, opensAt } = copy
    const { x, y, width, height } = copy.bounds
    const { index: sealIndex, numeral } = copy.seal
    if (
      ![index, number, opensAt, x, y, width, height, sealIndex].every(Number.isSafeInteger) ||
      typeof numeral !== 'string'
    )
      return null
    let group = groups.get(sealIndex as number)
    if (group === undefined) {
      group = { id: `${info.id}:seal-${sealIndex}`, name: `Seal ${numeral}` }
      groups.set(sealIndex as number, group)
    }
    fragments.push({
      index: index as number,
      templateId: templateIdOf(index as number),
      name: `${group.name} · Fragment ${number}`,
      shortName: `Fragment ${number}`,
      group,
      x: x as number,
      y: y as number,
      width: width as number,
      height: height as number,
      opensAt: opensAt as number,
    })
  }
  return { id: info.id, name: info.titleEn, groups: [...groups.values()], fragments }
}

/** Load the current event from Wplace, then keep its openings and progress current. */
export const installOfficialEvents = async (): Promise<void> => {
  try {
    const found = await findWplaceModules({
      event: (source) => source.includes('/img/seven-seals/') && source.includes('titleEn'),
      progress: (source) => source.includes('/seven-seals/stream'),
    })
    event = found.event === undefined ? null : readEvent(found.event.module)
    if (event === null) return
    progressStore =
      (Object.values(found.progress?.module ?? {}).find(
        (value) =>
          record(value) &&
          typeof value.copyState === 'function' &&
          typeof value.refresh === 'function',
      ) as ProgressStore | undefined) ?? null
    rememberNodes(OFFICIAL_OVERLAY_OWNER, [
      { id: event.id, parentId: null },
      ...event.groups.map((group) => ({ id: group.id, parentId: event?.id ?? null })),
    ])
    for (const map of watched) sync(map)
    notify()
  } catch (error) {
    warn('install', 'official events unavailable', String(error))
    return
  }
  const scheduleOpening = (): void => {
    const next = event?.fragments.find((fragment) => fragment.opensAt > Date.now())
    if (next === undefined) return
    setTimeout(
      () => {
        notify()
        scheduleOpening()
      },
      Math.min(next.opensAt - Date.now(), MAX_TIMEOUT_MS),
    )
  }
  scheduleOpening()
  const refresh = (): void => {
    void progressStore
      ?.refresh()
      .then(notify, (error) =>
        warn('install', 'official event progress unavailable', String(error)),
      )
  }
  refresh()
  setInterval(refresh, REFRESH_MS)
}

interface SealLayer {
  data?: {
    readonly pixels: ImageData
    /** Top-left, top-right, bottom-right, bottom-left, as `[lng, lat]`. */
    readonly coordinates: readonly (readonly [number, number])[]
  }
  setData(data: unknown): void
}

interface OverlayMap {
  getLayersOrder(): string[]
  getLayer(id: string): { implementation?: SealLayer } | undefined
  getLayoutProperty(id: string, name: 'visibility'): unknown
  setLayoutProperty(id: string, name: 'visibility', value: 'none'): void
  on(type: 'styledata', listener: () => void): unknown
}

const isOverlayMap = (map: unknown): map is OverlayMap =>
  record(map) &&
  ['getLayersOrder', 'getLayer', 'getLayoutProperty', 'setLayoutProperty', 'on'].every(
    (method) => typeof map[method] === 'function',
  )

const watched = new Set<OverlayMap>()
const wrapped = new WeakSet<SealLayer>()
/** Every fragment of one seal shares Wplace's image, so they share decoded indices too. */
const decoded = new WeakMap<ImageData, ReturnType<typeof paletteIndices>>()
/** Mirrored layer id to the placement it was mirrored at. */
const mirrored = new Map<string, string>()
let tail: Promise<void> = Promise.resolve()

const queue = (task: () => Promise<void>): void => {
  tail = tail
    .then(task)
    .catch((error) => warn('install', 'official overlay unavailable', String(error)))
}

const mirror = async (map: OverlayMap, layerId: string, index: number): Promise<void> => {
  const data = map.getLayer(layerId)?.implementation?.data
  const corner = data?.coordinates[0]
  if (data === undefined || corner === undefined) return
  const { pixels } = data
  const origin = latLngToCanvasPixel({ lng: corner[0], lat: corner[1] })
  const originX = Math.round(origin.x)
  const originY = Math.round(origin.y)
  const fragment = event?.fragments.find((candidate) => candidate.index === index)
  // The event can load after the first mirror; its name and folder then replace the fallback.
  const version = `${originX},${originY},${pixels.width}x${pixels.height},${fragment?.group.id}`
  const id = templateIdOf(index)
  if (mirrored.get(layerId) === version) return
  if (!hasRoomForServerTemplate(id, pixels.width * pixels.height)) {
    warn('install', 'official overlay over the template memory budget', layerId)
    return
  }
  let art = decoded.get(pixels)
  if (art === undefined) {
    art = paletteIndices(pixels)
    decoded.set(pixels, art)
  }
  const stored = await putServerTemplate(
    {
      id,
      name: fragment?.name ?? `Official overlay ${index}`,
      source: 'wplace',
      originX,
      originY,
      width: pixels.width,
      height: pixels.height,
      ...art,
      moved: 0,
      serverUrl: OFFICIAL_OVERLAY_OWNER,
      serverTemplateId: layerId,
      serverNodeId: fragment?.group.id ?? null,
      serverVersion: version,
    },
    () => map.getLayer(layerId) !== undefined,
  )
  if (stored) mirrored.set(layerId, version)
}

/**
 * Wplace's copy never shows, mirrored or not: its mismatch dots and colour picking fight
 * Caelestis's. Wplace's `setData` replaces its own hidden flag, but never touches layout
 * visibility. Setting it is itself a style change, so only set it once.
 */
const hideNative = (map: OverlayMap, layerId: string): void => {
  if (map.getLayoutProperty(layerId, 'visibility') !== 'none')
    map.setLayoutProperty(layerId, 'visibility', 'none')
}

const sync = (map: OverlayMap): void => {
  const present = new Map<string, number>()
  for (const layerId of map.getLayersOrder()) {
    const match = SEAL_LAYER.exec(layerId)
    if (match !== null) present.set(layerId, Number(match[1]))
  }
  for (const [layerId, index] of present) {
    hideNative(map, layerId)
    const layer = map.getLayer(layerId)?.implementation
    // Wplace adds the layer before its art has loaded, then hands the art over through `setData`.
    if (layer !== undefined && !wrapped.has(layer)) {
      wrapped.add(layer)
      const original = layer.setData
      layer.setData = function (this: SealLayer, data: unknown): void {
        original.call(this, data)
        queue(() => mirror(map, layerId, index))
      }
    }
    queue(() => mirror(map, layerId, index))
  }
  for (const [layerId] of mirrored) {
    const match = SEAL_LAYER.exec(layerId)
    if (present.has(layerId) || match === null) continue
    // Forget in queue order: a mirror queued before the removal may still re-mark it as mirrored.
    queue(async () => {
      if (mirrored.delete(layerId)) await forgetServerTemplate(templateIdOf(Number(match[1])))
    })
  }
}

/** Mirror Wplace's official overlays on this map. Safe to call repeatedly with the same map. */
export const syncOfficialOverlays = (map: unknown): void => {
  if (!isOverlayMap(map) || watched.has(map)) return
  watched.add(map)
  // MapLibre reports every added or removed layer as a style change.
  map.on('styledata', () => sync(map))
  sync(map)
}
