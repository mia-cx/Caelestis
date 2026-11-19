import {
  encodeIndexedPng,
  MAX_TEMPLATE_PIXELS,
  type TemplateSurface,
  templateSurfaceKey,
} from '@caelestis/shared'
import { log, warn } from '../debug.js'
import { registerProfileMemorySource } from '../profile.js'
import {
  catalogEntries,
  deleteCatalogEntry,
  isCurrentTemplate,
  isPendingImage,
  isServerTemplate,
  isTemplateVisible,
  localTemplates,
  notifyLocalChange,
  type PlacedTemplate,
  setCatalogEntry,
  type TemplateArtwork,
  templateById,
} from './catalog.js'
import { joinPixels, type SparsePixels, storedArea } from './sparse-pixels.js'
import type { TemplateRecord } from './template-record.js'

/**
 * Which templates keep their pixels in memory.
 *
 * Every catalog entry holds its artwork's painted area against one budget. Over budget, hidden
 * templates are evicted first, then the least recently used; on-screen ones and unsaved placements
 * never are. Evicted artwork reloads on demand from whoever owns it: `restore.ts` for Local
 * templates, `server-copies.ts` for copies.
 */

/** Pixels held in memory across every resident template, by painted chunk area. Disk holds the rest. */
export const MAX_RESIDENT_PIXELS = MAX_TEMPLATE_PIXELS

let retainedIndexPixels = 0
let pendingIndexPixels = 0

/** A template's bounding box, which dense pixels fill. */
export const areaOf = (template: Pick<TemplateRecord, 'width' | 'height'>): number =>
  template.width * template.height

/**
 * Each artwork's painted chunk area, which is what it holds against the resident budget.
 *
 * Remembered while evicted, so loading can make room before reading. Until first known it is
 * assumed to be the whole bounding box, which only ever evicts too much.
 */
const artworkAreas = new WeakMap<TemplateArtwork, number>()

const expectedArea = (template: PlacedTemplate): number =>
  artworkAreas.get(template.artwork) ?? areaOf(template)

/** What a template currently holds against the resident budget. */
export const residentArea = (template: PlacedTemplate): number =>
  template.artwork.pixels === null ? 0 : expectedArea(template)

/** A new artwork, so caches keyed on the previous one see the change. */
export const newArtwork = (pixels: SparsePixels | null, area?: number): TemplateArtwork => {
  const artwork = { pixels }
  const known = pixels === null ? area : storedArea(pixels)
  if (known !== undefined) artworkAreas.set(artwork, known)
  return artwork
}

/** Install or drop a template's pixels. This module owns every artwork, so it alone writes them. */
const setPixels = (template: PlacedTemplate, pixels: SparsePixels | null): void => {
  retainedIndexPixels -= residentArea(template)
  if (pixels !== null) {
    artworkAreas.set(template.artwork, storedArea(pixels))
    retainedIndexPixels += expectedArea(template)
  }
  ;(template.artwork as { pixels: SparsePixels | null }).pixels = pixels
}

/** Evict one template's pixels, for a writer about to replace its artwork. */
export const dropPixels = (template: PlacedTemplate): void => setPixels(template, null)

/** Write a catalog entry, moving the budget from the entry it replaces to this one. */
export const installEntry = (template: PlacedTemplate): void => {
  const previous = templateById(template.id)
  if (previous !== undefined) retainedIndexPixels -= residentArea(previous)
  setCatalogEntry(template)
  retainedIndexPixels += residentArea(template)
}

/** Remove a catalog entry and release what it held against the budget. */
export const removeEntry = (template: PlacedTemplate): void => {
  retainedIndexPixels -= residentArea(template)
  deleteCatalogEntry(template.id)
}

/** Count pixels an add holds before its entry exists. Returns the release. */
export const holdPendingPixels = (area: number): (() => void) => {
  pendingIndexPixels += area
  return () => {
    pendingIndexPixels -= area
  }
}

/** When each template was last needed, so eviction can take the least recently used first. */
const lastUsed = new Map<string, number>()
let useClock = 0
export const touchTemplate = (id: string): void => {
  lastUsed.set(id, ++useClock)
}

export const fitsResident = (area: number): boolean =>
  retainedIndexPixels + pendingIndexPixels + area <= MAX_RESIDENT_PIXELS

/** Templates each surface's renderer drew last frame, keyed by surface. */
const inView = new Map<string, ReadonlySet<string>>()

const isInView = (id: string): boolean => {
  for (const ids of inView.values()) if (ids.has(id)) return true
  return false
}

/** Templates whose pixels must stay: ones on screen, and unsaved placements with no disk record. */
const isPinned = (template: PlacedTemplate): boolean =>
  isInView(template.id) || isPendingImage(template)

/** Whether `area` could become resident by evicting everything evictable except `keep`. */
const couldFit = (area: number, keep?: string): boolean => {
  let evictable = 0
  for (const template of catalogEntries()) {
    if (template.id !== keep && !isPinned(template)) evictable += residentArea(template)
  }
  return fitsResident(area - evictable)
}

/**
 * Evict until `area` more pixels fit: hidden templates first, then the least recently used.
 *
 * Returns whether the area fits. Evicted templates stay in the catalog and reload on demand.
 */
export const makeRoom = (area: number, keep?: string): boolean => {
  if (fitsResident(area)) return true
  const evictable = [...catalogEntries()]
    .filter(
      (template) => template.id !== keep && template.artwork.pixels !== null && !isPinned(template),
    )
    .sort(
      (a, b) =>
        Number(isTemplateVisible(a)) - Number(isTemplateVisible(b)) ||
        (lastUsed.get(a.id) ?? 0) - (lastUsed.get(b.id) ?? 0),
    )
  let evicted = 0
  for (const template of evictable) {
    if (fitsResident(area)) break
    setPixels(template, null)
    evicted++
  }
  if (evicted > 0) {
    log('install', `evicted ${evicted} templates from memory`)
    notifyLocalChange()
  }
  return fitsResident(area)
}

/**
 * Reads a template's evicted pixels back from where its owner keeps them.
 *
 * Throws when they cannot be read, or when the entry changed while loading.
 */
type PixelLoader = (template: PlacedTemplate) => Promise<SparsePixels>

const pixelLoaders: { local?: PixelLoader; copy?: PixelLoader } = {}

/**
 * Say how to reload one kind of template. The module that admits a kind registers its loader as it
 * loads, so every entry's loader exists before the entry does.
 */
export const registerPixelLoader = (kind: 'local' | 'copy', loader: PixelLoader): void => {
  pixelLoaders[kind] = loader
}

const pixelLoads = new WeakMap<TemplateArtwork, Promise<SparsePixels>>()

/** How long artwork that failed to load waits before automatic loads try it again. */
const LOAD_RETRY_MS = 30_000
/** When each artwork last failed to load, so a broken one is not retried every frame. */
const failedLoads = new WeakMap<TemplateArtwork, number>()
const recentlyFailed = (artwork: TemplateArtwork): boolean =>
  performance.now() - (failedLoads.get(artwork) ?? Number.NEGATIVE_INFINITY) < LOAD_RETRY_MS

/** Read evicted pixels back, keeping them if `evict` or free memory allows; hand them over either way. */
const loadPixels = async (template: PlacedTemplate, evict: boolean): Promise<SparsePixels> => {
  const loader = pixelLoaders[isServerTemplate(template) ? 'copy' : 'local']
  if (loader === undefined) throw new Error('Could not load this template. Try again.')
  const pixels = await loader(template)
  const area = storedArea(pixels)
  if (evict ? makeRoom(area, template.id) : fitsResident(area)) {
    setPixels(template, pixels)
    notifyLocalChange()
  }
  return pixels
}

const residentPixels = async (template: PlacedTemplate, evict: boolean): Promise<SparsePixels> => {
  touchTemplate(template.id)
  const pixels = template.artwork.pixels
  if (pixels !== null) return pixels
  const running = pixelLoads.get(template.artwork)
  if (running !== undefined) return await running
  const load = loadPixels(template, evict)
  pixelLoads.set(template.artwork, load)
  try {
    return await load
  } finally {
    if (pixelLoads.get(template.artwork) === load) pixelLoads.delete(template.artwork)
  }
}

/**
 * A template's painted chunks, read back from disk when it was evicted.
 *
 * Loaded pixels become resident, evicting the least recently used templates to make room. Throws
 * when the template changed while loading or can no longer be read.
 */
export const templateChunks = async (template: PlacedTemplate): Promise<SparsePixels> =>
  await residentPixels(template, true)

/**
 * A dense copy of a template's pixels, one palette index per pixel, row-major.
 *
 * For actions that need the whole image at once, such as export or editing; the copy costs the full
 * bounding box for as long as the caller holds it. Loads like {@link templateChunks}.
 */
export const templatePixels = async (template: PlacedTemplate): Promise<Uint8Array> =>
  joinPixels(await residentPixels(template, true))

/**
 * Pixels for a passing look, such as a preview: read without evicting anything, kept only if memory
 * is free. Null when they cannot be read, or failed to a moment ago.
 */
export const peekTemplatePixels = async (
  template: PlacedTemplate,
): Promise<SparsePixels | null> => {
  if (recentlyFailed(template.artwork)) return null
  try {
    return await residentPixels(template, false)
  } catch (error) {
    failedLoads.set(template.artwork, performance.now())
    warn('install', `could not load ${template.name}`, String(error))
    return null
  }
}

/**
 * Load evicted templates while memory allows, visible ones first, without evicting anything.
 *
 * Runs after restore so a catalog that fits in memory behaves as if nothing were ever evicted.
 */
export const fillResidentSet = async (): Promise<void> => {
  const waiting = localTemplates()
    .filter((template) => template.artwork.pixels === null)
    .sort((a, b) => Number(isTemplateVisible(b)) - Number(isTemplateVisible(a)))
  for (const template of waiting) {
    if (!isCurrentTemplate(template) || !fitsResident(expectedArea(template))) continue
    try {
      await residentPixels(template, false)
    } catch (error) {
      warn('install', `could not load ${template.name}`, String(error))
    }
  }
}

/** Templates on screen waiting for their pixels, loaded one at a time. */
const viewLoads = new Set<string>()
let loadingInView = false

const loadInView = async (): Promise<void> => {
  loadingInView = true
  try {
    for (const id of viewLoads) {
      viewLoads.delete(id)
      const template = templateById(id)
      if (
        template === undefined ||
        template.artwork.pixels !== null ||
        recentlyFailed(template.artwork) ||
        !isInView(id) ||
        !couldFit(expectedArea(template), id)
      )
        continue
      try {
        await residentPixels(template, true)
      } catch (error) {
        failedLoads.set(template.artwork, performance.now())
        warn('install', `could not load ${template.name}`, String(error))
      }
    }
  } finally {
    loadingInView = false
  }
}

/**
 * Tell the store which templates a surface drew this frame.
 *
 * Those stay in memory, count as just used, and load if they were evicted. Renderers call this every
 * frame; an unchanged view costs one pass over the drawn templates.
 */
export const noteTemplatesInView = (surface: TemplateSurface, ids: ReadonlySet<string>): void => {
  inView.set(templateSurfaceKey(surface), ids)
  for (const id of ids) {
    touchTemplate(id)
    if (templateById(id)?.artwork.pixels === null) viewLoads.add(id)
  }
  if (viewLoads.size > 0 && !loadingInView) void loadInView()
}

/** Indexed template pixels currently owned by the catalog. */
export const templateIndexMemoryBytes = (): number => retainedIndexPixels
registerProfileMemorySource('Template pixels', templateIndexMemoryBytes)

/**
 * A template as an indexed PNG, ready to upload.
 *
 * The server quantises on ingest anyway, but sending the already-quantised pixels means what was
 * previewed locally is byte-identical to what is stored — no second opinion from a second
 * quantiser on the way through.
 */
export const templateAsPng = async (template: PlacedTemplate): Promise<Blob | null> => {
  if (!isCurrentTemplate(template)) return null
  const encoded = await encodeIndexedPng(
    template.width,
    template.height,
    await templatePixels(template),
  )
  if (!isCurrentTemplate(template)) return null
  return new Blob([Uint8Array.from(encoded)], { type: 'image/png' })
}
