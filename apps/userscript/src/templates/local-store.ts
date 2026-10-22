import {
  encodeIndexedPng,
  sameTemplateSurface,
  type TemplateSurface,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  templateSurface,
  templateSurfaceBounds,
  templateSurfaceKey,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
  WPLACE_PALETTE,
} from '@caelestis/shared'
import { log, warn } from '../debug.js'
import { leaseLocalFolder, localFolderChainVisible } from '../local-folders.js'
import { isUint8Array, pageWindow } from '../page-world.js'
import {
  type ConnectedServer,
  getState,
  getSurfaceAppearance,
  isCurrentServerConnection,
  isScopeVisible,
  type LocalFolder,
  serverTemplatePreference,
  setScopeVisible,
  setServerTemplatePreference,
} from '../state.js'
import {
  APPEARANCE_GROUPS,
  type Appearance,
  type AppearanceGroup,
  GROUP_FIELDS,
  legacyAppearanceGroups,
  normaliseAppearance,
} from './appearance.js'
import { storedAuthoring, type TemplateAuthoring } from './authoring.js'
import {
  type ImportedTemplate,
  MAX_TEMPLATE_ID_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
} from './import.js'
import {
  catalogTileKeys,
  deleteTemplate,
  discardTemplate,
  hydrateStoredTemplate,
  loadTemplate,
  loadTemplateCatalog,
  type SaveResult,
  type StoredRecord,
  type StoredTemplate,
  saveTemplate,
  saveTemplateFolders,
  saveTemplateTileKeys,
} from './personal-store.js'
import { nodeChainVisible, serverNodeParents, serverNodesRevision } from './server-nodes.js'
import { forgetServerPixels, readServerPixels, saveServerPixels } from './server-pixel-cache.js'

/**
 * Indexed template pixels shared by rendering, mismatch scans, colour picking and local editing.
 *
 * The WebGL renderer uploads the indices directly. Local templates retain only the painted world
 * tile keys needed by mismatch scans and navigation; server templates receive those keys from the
 * manifest.
 */

/**
 * A template's pixels, held in memory only while the template is resident.
 *
 * Its identity changes only when the pixels do, so caches keyed on it (progress, colour totals)
 * survive eviction and reload. Read `indices` for synchronous work that may skip an evicted template;
 * await {@link templatePixels} for work that needs the pixels.
 */
export interface TemplateArtwork {
  /** One palette index per pixel, row-major; null while evicted. */
  readonly indices: Uint8Array | null
}

export interface PlacedTemplate extends Omit<ImportedTemplate, 'indices'> {
  readonly artwork: TemplateArtwork
  readonly native?: NonNullable<StoredTemplate['native']>
  /** Wplace's alliance opacity, used until this browser takes ownership of the pixels appearance. */
  readonly sourceOpacity?: number
  /** Last local content or placement edit; absent on legacy records and server render copies. */
  readonly updatedAt?: number
  /** Drawing surface this placement belongs to. Legacy browser-owned templates are world-scoped. */
  readonly surface?: TemplateSurface
  /** Runtime owner for server rows; absent on Local and legacy restored records. */
  readonly serverConnection?: ConnectedServer
  /** Painted world-tile keys (`x/y`) used to bound mismatch and navigation work. */
  readonly tiles: ReadonlySet<string>
  readonly visible: boolean
  /**
   * Whether a placement has ever been applied to this template.
   *
   * A freshly imported image has never been anywhere, so cancelling its first placement should
   * remove it rather than leave it stranded at a position nobody chose.
   */
  readonly everPlaced: boolean
  /**
   * Values this template has set for itself, for whichever groups it owns.
   *
   * Null is not the same as a copy of the default. A template that has never been adjusted should
   * track the global sliders as they move; one that has been adjusted must keep what was set on it.
   * Storing a copy at creation would freeze every new template at whatever the global happened to be
   * that day and quietly stop it following anything.
   */
  readonly appearance: Appearance | null
  /** IndexedDB compare-and-swap token; not part of template identity or rendering. */
  readonly revision: number
  /**
   * Which groups the values above actually govern.
   *
   * Ownership is per group rather than all-or-nothing, so a template can carry its own marker
   * colour while still following the global shape and colour filter. Empty means it follows the
   * defaults in every respect, which is where every template starts.
   */
  readonly owns: readonly AppearanceGroup[]
  /** Which Local folder this sits in, or null for the top level of Local. */
  readonly folderId: string | null
  /**
   * The server publishing this template, or absent for one that only exists in this browser.
   *
   * Server templates live in this same store deliberately. Everything downstream — the renderer, the
   * mismatch scan, the colour picker, the per-overlay menu — takes a `PlacedTemplate` and does not
   * care where it came from, and keeping a second parallel store would have meant teaching all of
   * them the difference for no gain. What *is* different is ownership: these are not persisted here,
   * because the server is where they live and a stale copy in IndexedDB would outlive a delete.
   */
  readonly serverUrl?: string
  /** Its id on that server, which is what the admin routes address. */
  readonly serverTemplateId?: string
  /** The folder it hangs off on that server, or null when it sits at the server root. */
  readonly serverNodeId?: string | null
  /** The version these pixels came from, so a sync knows whether to re-download them. */
  readonly serverVersion?: string
  /**
   * An unpublished copy, which only an admin token can read. Wplace's own scripts can read this
   * page's IndexedDB and Cache Storage, so nothing of it is written there.
   */
  readonly serverUnpublished?: boolean
  /** The source continues at x=0 after reaching the world's east edge. Server templates only. */
  readonly wrapX?: boolean
  /** Painted world tiles advertised by the server manifest. Server templates only. */
  readonly serverTileKeys?: readonly string[]
}

/** A placement with its pixels in hand, for work that reads them. */
export type PlacedPixels = Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height'> & {
  readonly indices: Uint8Array
}

/** Whether this template is a copy of something a server publishes. */
export const isServerTemplate = (template: PlacedTemplate): boolean =>
  template.serverUrl !== undefined

const templates = new Map<string, PlacedTemplate>()
const reconciliationObservers = new Map<string, Set<() => void>>()
const previewOrigins = new Map<string, { x: number; y: number }>()
const deleting = new Set<string>()
const deletionLeases = new Map<string, number>()
const pendingAdds = new Set<string>()
const listeners: Array<() => void> = []
const previewListeners: Array<() => void> = []
/** Pixels held in memory across every resident template, by area. Disk holds the rest. */
const MAX_RESIDENT_PIXELS = 64 * 1024 * 1024
const MAX_RESTORE_PASSES = 4
let retainedIndexPixels = 0
let pendingIndexPixels = 0
let restoreInFlight: Promise<void> | null = null
let scheduledRestoreRecovery: Promise<void> | null = null
let reconciliationTail: Promise<void> = Promise.resolve()
let templateRevision = 0
let orderedCacheRevision = -1
let orderedCache: readonly PlacedTemplate[] = []

/** When each template was last needed, so eviction can take the least recently used first. */
const lastUsed = new Map<string, number>()
let useClock = 0
const touch = (id: string): void => {
  lastUsed.set(id, ++useClock)
}

const fitsResident = (area: number): boolean =>
  retainedIndexPixels + pendingIndexPixels + area <= MAX_RESIDENT_PIXELS

/** Install or drop a template's pixels. This module owns every artwork, so it alone writes them. */
const setPixels = (template: PlacedTemplate, indices: Uint8Array | null): void => {
  retainedIndexPixels += (indices === null ? 0 : areaOf(template)) - residentArea(template)
  ;(template.artwork as { indices: Uint8Array | null }).indices = indices
}

/** Templates whose pixels must stay: unsaved placements and server copies, which have no disk record. */
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
  for (const template of templates.values()) {
    if (template.id !== keep && !isPinned(template)) evictable += residentArea(template)
  }
  return fitsResident(area - evictable)
}

/**
 * Evict until `area` more pixels fit: hidden templates first, then the least recently used.
 *
 * Returns whether the area fits. Evicted templates stay in the catalog and reload on demand.
 */
const makeRoom = (area: number, keep?: string): boolean => {
  if (fitsResident(area)) return true
  const evictable = [...templates.values()]
    .filter(
      (template) =>
        template.id !== keep && template.artwork.indices !== null && !isPinned(template),
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
    notify()
  }
  return fitsResident(area)
}

export const onLocalReconciliation = (id: string, observer: () => void): (() => void) => {
  const observers = reconciliationObservers.get(id) ?? new Set<() => void>()
  observers.add(observer)
  reconciliationObservers.set(id, observers)
  return () => {
    observers.delete(observer)
    if (observers.size === 0) reconciliationObservers.delete(id)
  }
}

const noteReconciliation = (id: string): void => {
  for (const observer of reconciliationObservers.get(id) ?? []) {
    try {
      observer()
    } catch (error) {
      warn('install', 'local reconciliation observer failed', String(error))
    }
  }
}

const orderedTemplates = (): readonly PlacedTemplate[] => {
  if (orderedCacheRevision === templateRevision) return orderedCache
  orderedCache = [...templates.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  orderedCacheRevision = templateRevision
  return orderedCache
}

const customOrdered = <T extends { readonly key: string }>(
  items: readonly T[],
  rank: ReadonlyMap<string, number>,
): readonly T[] => {
  const ranked: Array<T & { readonly rank: number }> = []
  const unranked: T[] = []
  for (const item of items) {
    const itemRank = rank.get(item.key)
    if (itemRank === undefined) unranked.push(item)
    else ranked.push({ ...item, rank: itemRank })
  }
  ranked.sort((a, b) => a.rank - b.rank)
  return [...ranked, ...unranked]
}

const serverTreeIdentity = (serverUrl: string): string => {
  const verified = getState().servers.find((server) => server.url === serverUrl)?.lastVerified
  return verified == null ? 'unknown:unknown' : `${verified.serverId}:${verified.season}`
}

/** Flatten one tree in the same custom sibling order the panel shows. */
const flattenTree = (
  rows: readonly PlacedTemplate[],
  folders: readonly (readonly [id: string, parentId: string | null])[],
  folderKey: (id: string) => string,
  templateKey: (template: PlacedTemplate) => string,
  templateParent: (template: PlacedTemplate) => string | null,
  rank: ReadonlyMap<string, number>,
): readonly PlacedTemplate[] => {
  const result: PlacedTemplate[] = []
  const seenFolders = new Set<string>()
  const seenTemplates = new Set<string>()
  const foldersByParent = new Map<string | null, string[]>()
  const templatesByParent = new Map<string | null, PlacedTemplate[]>()
  for (const [id, parentId] of folders) {
    const siblings = foldersByParent.get(parentId) ?? []
    siblings.push(id)
    foldersByParent.set(parentId, siblings)
  }
  for (const template of rows) {
    const parentId = templateParent(template)
    const siblings = templatesByParent.get(parentId) ?? []
    siblings.push(template)
    templatesByParent.set(parentId, siblings)
  }
  const childrenOf = (parentId: string | null) =>
    customOrdered(
      [
        ...(foldersByParent.get(parentId) ?? []).map((id) => ({
          key: folderKey(id),
          kind: 'folder' as const,
          id,
        })),
        ...(templatesByParent.get(parentId) ?? []).map((template) => ({
          key: templateKey(template),
          kind: 'template' as const,
          template,
        })),
      ],
      rank,
    )
  const stack = [...childrenOf(null)].reverse()
  while (stack.length > 0) {
    const child = stack.pop()
    if (child === undefined) break
    if (child.kind === 'template') {
      if (seenTemplates.has(child.template.id)) continue
      seenTemplates.add(child.template.id)
      result.push(child.template)
    } else if (!seenFolders.has(child.id)) {
      seenFolders.add(child.id)
      stack.push(...[...childrenOf(child.id)].reverse())
    }
  }
  // Invalid or temporarily incomplete parent data must not make an otherwise valid overlay vanish.
  for (const template of rows) {
    if (!seenTemplates.has(template.id)) result.push(template)
  }
  return result
}

const displayOrder = (): readonly PlacedTemplate[] => {
  const ordered = orderedTemplates()
  const state = getState()
  const rank = new Map(state.customOrder.map((key, index) => [key, index]))
  const categories = [
    {
      key: 'local',
      rows: flattenTree(
        ordered.filter((template) => !isServerTemplate(template)),
        state.localFolders.map((folder) => [folder.id, folder.parentId] as const),
        (id) => `lf:${id}`,
        (template) => `local:${template.id}`,
        (template) => template.folderId,
        rank,
      ),
    },
    ...state.servers.map((server) => {
      const identity = serverTreeIdentity(server.url)
      return {
        key: `server:${server.url}`,
        rows: flattenTree(
          ordered.filter((template) => template.serverUrl === server.url),
          serverNodeParents(server.url),
          (id) => `node:${encodeURIComponent(server.url)}:${identity}:${id}`,
          (template) =>
            `st:${encodeURIComponent(server.url)}:${identity}:${template.serverTemplateId ?? ''}`,
          (template) => template.serverNodeId ?? null,
          rank,
        ),
      }
    }),
  ]
  const result = customOrdered(categories, rank).flatMap(({ rows }) => rows)
  const included = new Set(result.map((template) => template.id))
  return [...result, ...ordered.filter((template) => !included.has(template.id))]
}

export const onLocalChange = (listener: () => void): void => {
  listeners.push(listener)
}
export const onLocalPreviewChange = (listener: () => void): void => {
  previewListeners.push(listener)
}

const notifyListeners = (subscribers: readonly (() => void)[], what: string): void => {
  for (const listener of subscribers) {
    try {
      listener()
    } catch (error) {
      try {
        warn('install', `${what} listener failed`, String(error))
      } catch {}
    }
  }
}

const notify = (): void => {
  templateRevision++
  // Mirror a summary onto the window so the dev harness can assert on placement without reaching
  // into module state. Metadata only — never the pixels.
  try {
    ;(pageWindow() as unknown as Record<string, unknown>).__caelestisLocal = orderedTemplates().map(
      (t) => ({
        id: t.id,
        name: t.name,
        source: t.source,
        originX: t.originX,
        originY: t.originY,
        width: t.width,
        height: t.height,
        tiles: t.tiles.size,
        folderId: t.folderId,
      }),
    )
  } catch (error) {
    try {
      warn('install', 'could not update local template diagnostics', String(error))
    } catch {}
  }
  notifyListeners(listeners, 'local template')
}

const notifyPreview = (): void => notifyListeners(previewListeners, 'local preview')

export const localTemplates = (): readonly PlacedTemplate[] => orderedTemplates()

/** Current catalog entry for one template id, without allocating or sorting the collection. */
export const templateById = (id: string): PlacedTemplate | undefined => templates.get(id)

/** Ordered template ids directly inside one Local folder. */
export const templateIdsInLocalFolder = (folderId: string): readonly string[] =>
  orderedTemplates()
    .filter((template) => !isServerTemplate(template) && template.folderId === folderId)
    .map((template) => template.id)

const pixelLoads = new WeakMap<TemplateArtwork, Promise<Uint8Array>>()

/** How long artwork that failed to load waits before automatic loads try it again. */
const LOAD_RETRY_MS = 30_000
/** When each artwork last failed to load, so a broken one is not retried every frame. */
const failedLoads = new WeakMap<TemplateArtwork, number>()
const recentlyFailed = (artwork: TemplateArtwork): boolean =>
  performance.now() - (failedLoads.get(artwork) ?? Number.NEGATIVE_INFINITY) < LOAD_RETRY_MS

type ServerPixelSource = (template: PlacedTemplate) => Promise<Uint8Array | null>
let serverPixelSource: ServerPixelSource | null = null

/** Server sync registers how to download a template again when its disk copy is gone. */
export const setServerPixelSource = (source: ServerPixelSource): void => {
  serverPixelSource = source
}

/** Keep loaded pixels if `evict` or free memory allows; hand them over either way. */
const installLoaded = (template: PlacedTemplate, indices: Uint8Array, evict: boolean): void => {
  const area = areaOf(template)
  if (!(evict ? makeRoom(area, template.id) : fitsResident(area))) return
  setPixels(template, indices)
  notify()
}

/** Reload a server copy from its disk cache, or download it again. */
const loadServerPixels = async (template: PlacedTemplate, evict: boolean): Promise<Uint8Array> => {
  const version = template.serverVersion ?? ''
  const area = areaOf(template)
  let indices = await readServerPixels(template.id, version, area)
  const downloaded = indices === null
  indices ??= (await serverPixelSource?.(template)) ?? null
  if (indices === null || indices.length !== area) {
    throw new Error('Could not load this server template. Try again.')
  }
  if (templates.get(template.id)?.artwork !== template.artwork) {
    throw new Error('That template changed while it was loading. Try again.')
  }
  // Queued behind metadata updates and judged by the live row, so a download that started while
  // the template was public cannot write it back after unpublishing cleared the disk.
  if (downloaded) {
    const loaded = indices
    void writeInOrder(template.id, async () => {
      if (templates.get(template.id)?.serverUnpublished === true) return
      await saveServerPixels(template.id, version, loaded, template.opaque)
    })
  }
  installLoaded(template, indices, evict)
  return indices
}

/** Read evicted pixels back from disk, keeping them if `evict` or free memory allows. */
const loadPixels = async (template: PlacedTemplate, evict: boolean): Promise<Uint8Array> => {
  if (isServerTemplate(template)) return await loadServerPixels(template, evict)
  const loaded = await loadTemplate(template.id, MAX_RESIDENT_PIXELS)
  if (loaded.status === 'unavailable') {
    throw new Error('Could not read this template from browser storage. Try again.')
  }
  const current = templates.get(template.id)
  const stored = loaded.status === 'loaded' ? storedOrNull(loaded.template) : null
  if (stored !== null && current?.artwork === template.artwork) {
    if (stored.revision === current.revision) {
      installLoaded(current, stored.indices, evict)
      return stored.indices
    }
  }
  // Disk no longer holds what this tab shows: another tab or Wplace changed it. Take the winner.
  await reconcileConflict(template.id)
  throw new Error('That template changed while it was loading. Try again.')
}

const residentPixels = async (template: PlacedTemplate, evict: boolean): Promise<Uint8Array> => {
  touch(template.id)
  const indices = template.artwork.indices
  if (indices !== null) return indices
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
 * A template's pixels, read back from disk when it was evicted.
 *
 * Loaded pixels become resident, evicting the least recently used templates to make room. Throws
 * when the template changed while loading or can no longer be read.
 */
export const templatePixels = async (template: PlacedTemplate): Promise<Uint8Array> =>
  await residentPixels(template, true)

/**
 * Pixels for a passing look, such as a preview: read without evicting anything, kept only if memory
 * is free. Null when they cannot be read, or failed to a moment ago.
 */
export const peekTemplatePixels = async (template: PlacedTemplate): Promise<Uint8Array | null> => {
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
const fillResidentSet = async (): Promise<void> => {
  const waiting = orderedTemplates()
    .filter((template) => template.artwork.indices === null)
    .sort((a, b) => Number(isTemplateVisible(b)) - Number(isTemplateVisible(a)))
  for (const template of waiting) {
    if (!isCurrentTemplate(template) || !fitsResident(areaOf(template))) continue
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
      const template = templates.get(id)
      if (
        template === undefined ||
        template.artwork.indices !== null ||
        recentlyFailed(template.artwork) ||
        !isInView(id) ||
        !couldFit(areaOf(template), id)
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
    touch(id)
    if (templates.get(id)?.artwork.indices === null) viewLoads.add(id)
  }
  if (viewLoads.size > 0 && !loadingInView) void loadInView()
}

/** Indexed template pixels currently owned by the catalog. */
export const templateIndexMemoryBytes = (): number => retainedIndexPixels

/** Whether this exact snapshot is still the installed version of its template. */
export const isCurrentTemplate = (template: PlacedTemplate): boolean =>
  templateById(template.id) === template

/** Keep a browser-owned template from being deleted while another copy is still being committed. */
export const leaseLocalTemplate = (id: string): (() => void) | null => {
  const template = templates.get(id)
  if (template === undefined || isServerTemplate(template) || deleting.has(id)) return null
  deletionLeases.set(id, (deletionLeases.get(id) ?? 0) + 1)
  let active = true
  return () => {
    if (!active) return
    active = false
    const remaining = (deletionLeases.get(id) ?? 1) - 1
    if (remaining === 0) deletionLeases.delete(id)
    else deletionLeases.set(id, remaining)
  }
}

let displayOrderCache:
  | {
      readonly customOrder: readonly string[]
      readonly localFolders: readonly LocalFolder[]
      readonly servers: readonly ConnectedServer[]
      readonly nodeRevision: number
      readonly templateRevision: number
      readonly templates: readonly PlacedTemplate[]
    }
  | undefined
/** Templates as the canvas and its interactions currently present them: custom order plus previews. */
export const displayTemplates = (): readonly PlacedTemplate[] => {
  const state = getState()
  const nodeRevision = serverNodesRevision()
  if (
    displayOrderCache === undefined ||
    displayOrderCache.customOrder !== state.customOrder ||
    displayOrderCache.localFolders !== state.localFolders ||
    displayOrderCache.servers !== state.servers ||
    displayOrderCache.nodeRevision !== nodeRevision ||
    displayOrderCache.templateRevision !== templateRevision
  ) {
    displayOrderCache = {
      customOrder: state.customOrder,
      localFolders: state.localFolders,
      servers: state.servers,
      nodeRevision,
      templateRevision,
      templates: displayOrder(),
    }
  }
  if (previewOrigins.size === 0) return displayOrderCache.templates
  return displayOrderCache.templates.map((template) => {
    const preview = previewOrigins.get(template.id)
    return preview === undefined
      ? template
      : { ...template, originX: preview.x, originY: preview.y }
  })
}

/** The renderer and editor menu for one canvas must never see templates from another surface. */
export const displayTemplatesForSurface = (surface: TemplateSurface): readonly PlacedTemplate[] =>
  displayTemplates().filter((template) =>
    sameTemplateSurface(template.surface ?? WORLD_TEMPLATE_SURFACE, surface),
  )

/** Transient placement never touches IndexedDB or rebuilds tiles; the renderer translates them. */
export const previewLocalTemplate = (id: string, originX: number, originY: number): boolean => {
  const existing = templates.get(id)
  if (existing === undefined || deleting.has(id)) return false
  const x = Math.round(originX)
  const y = Math.round(originY)
  validatePlacement(existing, x, y)
  previewOrigins.set(id, { x, y })
  notifyPreview()
  return true
}

export const previewOriginFor = (id: string): { x: number; y: number } | null =>
  previewOrigins.get(id) ?? null

export const clearLocalPreview = (id: string): boolean => {
  if (!previewOrigins.delete(id)) return templates.has(id)
  notifyPreview()
  return true
}

/**
 * Whether this template actually draws.
 *
 * Its own switch *and* every folder above it. A template inside a hidden folder keeps saying it is
 * visible, because it is — within a group that is not — and that is what makes turning the group
 * back on restore the arrangement instead of flattening it.
 */
export const isTemplateVisible = (template: PlacedTemplate): boolean => {
  if (!template.visible) return false
  // A server's template answers to that server's switch, not to Local's. Sharing this store meant
  // it inherited the local chain by default, so switching Local off hid every server's templates
  // too, and a server's own switch did nothing to them.
  //
  // And to the folders it sits in, the same way a Local template answers to its own. A server's
  // folders had no chain here at all, so their switches fell through to a set the renderer never
  // read: the box moved, and nothing else did.
  if (template.serverUrl !== undefined) {
    if (
      template.serverConnection !== undefined &&
      !isCurrentServerConnection(template.serverConnection)
    )
      return false
    if (!isScopeVisible(`server:${template.serverUrl}`)) return false
    return nodeChainVisible(
      template.serverUrl,
      template.serverNodeId ?? null,
      template.surface ?? WORLD_TEMPLATE_SURFACE,
    )
  }
  return localFolderChainVisible(template.folderId)
}

/**
 * How this template is actually drawn: its own appearance, or the global default it inherits.
 *
 * The global colour filter lives beside the global appearance rather than inside it — the colour
 * grid writes `hiddenColours` on the state directly — so the inherited object has to be completed
 * from both. Without this an overlay showed an empty filter while following defaults that hid half
 * the palette, and switching "use defaults" off copied that empty filter over the top, quietly
 * turning every hidden colour back on at the moment of detaching.
 */
export const appearanceOf = (template: PlacedTemplate): Appearance => {
  const global = getSurfaceAppearance(template.surface ?? WORLD_TEMPLATE_SURFACE)
  const own = template.appearance
  const nativeOpacity =
    template.native?.status === 'linked' && template.native.opacityOverride === true
      ? template.native.opacity
      : undefined
  const inherited =
    template.sourceOpacity === undefined ? global : { ...global, opacity: template.sourceOpacity }
  if (own === null || template.owns.length === 0)
    return nativeOpacity === undefined ? inherited : { ...inherited, opacity: nativeOpacity }

  // Field by field, from whichever side owns that field's group. A template that has taken over its
  // markers still follows the global sliders for its shape, which is the whole point of splitting
  // the switch: wanting one's own marker colour used to mean freezing everything else as well.
  const composed: Record<string, unknown> = { ...inherited }
  for (const group of template.owns) {
    for (const field of GROUP_FIELDS[group]) composed[field] = own[field]
  }
  if (nativeOpacity !== undefined) composed.opacity = nativeOpacity
  return composed as unknown as Appearance
}

/** Whether this template answers for itself on one group, or follows the defaults. */
export const ownsGroup = (template: PlacedTemplate, group: AppearanceGroup): boolean =>
  template.owns.includes(group)

const yieldToBrowser = async (): Promise<void> => {
  const browserScheduler = (
    globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }
  ).scheduler
  if (browserScheduler?.yield !== undefined) {
    await browserScheduler.yield()
    return
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** Where a template sits, without its pixels. */
type Placement = Pick<ImportedTemplate, 'originX' | 'originY' | 'width' | 'height'> & {
  readonly surface?: TemplateSurface
  readonly wrapX?: boolean
  readonly serverUrl?: string
}

/** Pixels in memory count against the resident budget by area, transparent ones included. */
const areaOf = (template: Pick<ImportedTemplate, 'width' | 'height'>): number =>
  template.width * template.height

/** What a template currently holds against the resident budget. */
const residentArea = (template: PlacedTemplate): number =>
  template.artwork.indices === null ? 0 : areaOf(template)

/** A new artwork for these pixels, so caches keyed on the previous one see the change. */
const withArtwork = <T extends { readonly indices: Uint8Array }>({
  indices,
  ...rest
}: T): Omit<T, 'indices'> & { readonly artwork: TemplateArtwork } => ({
  ...rest,
  artwork: { indices },
})

const validatePlacement = (
  template: Placement & { readonly indices?: Uint8Array },
  originX = template.originX,
  originY = template.originY,
): void => {
  if (!Number.isSafeInteger(originX) || !Number.isSafeInteger(originY)) {
    throw new RangeError('template origin must be whole canvas pixels')
  }
  if (
    !Number.isSafeInteger(template.width) ||
    !Number.isSafeInteger(template.height) ||
    template.width <= 0 ||
    template.height <= 0 ||
    (template.indices !== undefined && template.indices.length !== areaOf(template))
  ) {
    throw new RangeError('template dimensions do not match its pixels')
  }
  const surface = template.surface ?? WORLD_TEMPLATE_SURFACE
  if (surface.kind !== 'world') {
    const bounds = templateSurfaceBounds(surface)
    if (
      bounds === null ||
      originX < bounds.minX ||
      originY < bounds.minY ||
      originX + template.width > bounds.maxX ||
      originY + template.height > bounds.maxY
    ) {
      throw new RangeError(`template is outside the ${surface.kind} canvas`)
    }
    return
  }
  if (originX < 0 || originY < 0) throw new RangeError('template origin is outside the canvas')
  if (originX + template.width > WORLD_PIXELS) {
    if (
      template.wrapX !== true ||
      typeof template.serverUrl !== 'string' ||
      template.width >= WORLD_PIXELS ||
      originX + template.width > WORLD_PIXELS * 2
    ) {
      throw new RangeError('template runs past the east edge')
    }
  }
  if (originY + template.height > WORLD_PIXELS)
    throw new RangeError('template runs past the south edge')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isAppearance = (value: unknown): value is Appearance => {
  if (!isRecord(value)) return false
  const {
    size,
    radius,
    translateX,
    translateY,
    rotation,
    opacity,
    contrastOutline,
    contrastOutlineSize,
    hiddenColours,
  } = value
  return (
    typeof size === 'number' &&
    Number.isFinite(size) &&
    size >= 0.05 &&
    size <= 2 &&
    typeof radius === 'number' &&
    Number.isFinite(radius) &&
    radius >= 0 &&
    radius <= 1 &&
    typeof translateX === 'number' &&
    Number.isFinite(translateX) &&
    translateX >= -1 &&
    translateX <= 1 &&
    typeof translateY === 'number' &&
    Number.isFinite(translateY) &&
    translateY >= -1 &&
    translateY <= 1 &&
    typeof rotation === 'number' &&
    Number.isFinite(rotation) &&
    rotation >= 0 &&
    rotation <= 360 &&
    typeof opacity === 'number' &&
    Number.isFinite(opacity) &&
    opacity >= 0.05 &&
    opacity <= 1 &&
    typeof contrastOutline === 'boolean' &&
    typeof contrastOutlineSize === 'number' &&
    Number.isFinite(contrastOutlineSize) &&
    contrastOutlineSize >= 0.25 &&
    contrastOutlineSize <= 2 &&
    Array.isArray(hiddenColours) &&
    hiddenColours.length <= WPLACE_PALETTE.length &&
    hiddenColours.every(
      (index) => Number.isSafeInteger(index) && index >= 0 && index < WPLACE_PALETTE.length,
    ) &&
    new Set(hiddenColours).size === hiddenColours.length
  )
}

type StoredMetadata = Omit<StoredTemplate, 'indices'>

/** Validate a stored record's metadata; its pixels stay wherever they are. */
const normaliseStoredMetadata = (value: unknown): StoredMetadata => {
  if (!isRecord(value)) throw new RangeError('template record is not an object')
  const {
    id,
    name,
    source,
    sortOrder,
    originX,
    originY,
    width,
    height,
    moved,
    opaque,
    visible,
    everPlaced,
    surface: storedSurface,
    appearance,
    owns,
    revision,
    folderId,
    updatedAt,
    native,
    authoring: rawAuthoring,
  } = value
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_TEMPLATE_ID_LENGTH) {
    throw new RangeError('template id is invalid')
  }
  if (typeof name !== 'string' || name.length > MAX_TEMPLATE_NAME_LENGTH) {
    throw new RangeError('template name is invalid')
  }
  if (typeof source !== 'string' || !['wplace', 'marble', 'image'].includes(source)) {
    throw new RangeError('template source is invalid')
  }
  if (sortOrder !== undefined && !Number.isSafeInteger(sortOrder)) {
    throw new RangeError('template sort order is invalid')
  }
  if (
    !Number.isSafeInteger(moved) ||
    !Number.isSafeInteger(opaque) ||
    (moved as number) < 0 ||
    ((opaque as number) <= 0 && !((opaque as number) === 0 && native !== undefined)) ||
    (moved as number) > (opaque as number) ||
    (opaque as number) > Number(width) * Number(height)
  ) {
    throw new RangeError('template pixel counts are invalid')
  }
  if (typeof visible !== 'boolean' || typeof everPlaced !== 'boolean') {
    throw new RangeError('template state is invalid')
  }
  const surface =
    storedSurface === undefined
      ? WORLD_TEMPLATE_SURFACE
      : isRecord(storedSurface)
        ? templateSurface(storedSurface.kind, storedSurface.allianceId)
        : null
  if (surface === null) throw new RangeError('template surface is invalid')
  if (
    revision !== undefined &&
    (!Number.isSafeInteger(revision) ||
      (revision as number) < 0 ||
      (revision as number) >= Number.MAX_SAFE_INTEGER)
  ) {
    throw new RangeError('template revision is invalid')
  }
  if (folderId !== undefined && folderId !== null && typeof folderId !== 'string') {
    throw new RangeError('template folder is invalid')
  }
  if (
    native !== undefined &&
    (!isRecord(native) ||
      typeof native.id !== 'string' ||
      native.id.length === 0 ||
      !['pending', 'linked'].includes(String(native.status)) ||
      (native.status === 'linked' && typeof native.token !== 'string') ||
      (native.opacity !== undefined &&
        (typeof native.opacity !== 'number' ||
          !Number.isFinite(native.opacity) ||
          native.opacity < 0 ||
          native.opacity > 1)))
  )
    throw new RangeError('native template link is invalid')
  if (
    owns !== undefined &&
    (!Array.isArray(owns) ||
      owns.some((group) => !APPEARANCE_GROUPS.includes(group as AppearanceGroup)) ||
      new Set(owns).size !== owns.length)
  ) {
    throw new RangeError('template appearance ownership is invalid')
  }
  const authoring = storedAuthoring(rawAuthoring, { width, height })
  // The artwork is still good; only the inputs behind it are unusable.
  if (rawAuthoring !== undefined && authoring === null)
    warn('install', `dropping unreadable source and recipe of ${name}`)
  const normalised: StoredMetadata = {
    ...(native === undefined ? {} : { native: native as NonNullable<StoredTemplate['native']> }),
    id,
    name,
    source: source as StoredTemplate['source'],
    originX: originX as number,
    originY: originY as number,
    width: width as number,
    height: height as number,
    moved: moved as number,
    opaque: opaque as number,
    visible,
    everPlaced,
    surface,
    revision: revision === undefined ? 0 : (revision as number),
    folderId: typeof folderId === 'string' ? folderId : null,
    ...(typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt >= 0
      ? { updatedAt }
      : {}),
    appearance: normaliseAppearance(appearance),
    // "It has an appearance, so it chose one" holds for a record written by this model. A record
    // from before it carries `shape`, and every template got one whether or not anyone touched it,
    // so reading that as a deliberate choice would detach it from the global sliders for good.
    owns:
      owns === undefined
        ? appearance == null
          ? []
          : legacyAppearanceGroups(appearance)
        : (owns as AppearanceGroup[]),
    ...(sortOrder === undefined ? {} : { sortOrder: sortOrder as number }),
    ...(authoring === null ? {} : { authoring }),
  }
  validatePlacement(normalised)
  return normalised
}

const normaliseStoredTemplate = (value: unknown): StoredTemplate => {
  const metadata = normaliseStoredMetadata(value)
  const indices = isRecord(value) ? value.indices : undefined
  if (!isUint8Array(indices) || indices.length !== areaOf(metadata)) {
    throw new RangeError('template pixels are invalid')
  }
  return { ...metadata, indices }
}

/** A loaded record, or null when it is invalid; reconciliation then discards it with a warning. */
const storedOrNull = (value: unknown): StoredTemplate | null => {
  try {
    return normaliseStoredTemplate(value)
  } catch {
    return null
  }
}

/** Validate indexed pixels and retain only the painted world-tile keys downstream work needs. */
const paintedTileKeys = async (
  template: Placement & Pick<ImportedTemplate, 'indices' | 'opaque'>,
): Promise<ReadonlySet<string>> => {
  validatePlacement(template)
  await yieldToBrowser()
  let opaque = 0
  const tiles = new Set<string>()
  const worldTilesWide = Math.ceil(WORLD_PIXELS / TILE_SIZE)
  let sourceX = 0
  let sourceY = 0
  let lastPaintedTile = -1
  for (let pixel = 0; pixel < template.indices.length; pixel++) {
    const index = template.indices[pixel] ?? TRANSPARENT_INDEX
    if (index !== TRANSPARENT_INDEX) {
      if (index >= WPLACE_PALETTE.length) throw new RangeError('template palette index is invalid')
      opaque++
      if ((template.surface ?? WORLD_TEMPLATE_SURFACE).kind === 'world') {
        const unwrappedX = template.originX + sourceX
        const worldX = unwrappedX >= WORLD_PIXELS ? unwrappedX - WORLD_PIXELS : unwrappedX
        const tileX = Math.floor(worldX / TILE_SIZE)
        const tileY = Math.floor((template.originY + sourceY) / TILE_SIZE)
        const tile = tileY * worldTilesWide + tileX
        if (tile !== lastPaintedTile) {
          lastPaintedTile = tile
          tiles.add(`${tileX}/${tileY}`)
        }
      }
    }
    sourceX++
    if (sourceX === template.width) {
      sourceX = 0
      sourceY++
    }
    if ((pixel + 1) % 250_000 === 0) await yieldToBrowser()
  }
  if (opaque !== template.opaque) throw new RangeError('template opaque count is invalid')
  return tiles
}

const writeTails = new Map<string, Promise<unknown>>()

const writeInOrder = <T>(id: string, write: () => Promise<T>): Promise<T> => {
  const previous = writeTails.get(id) ?? Promise.resolve()
  const next = previous.then(write, write)
  writeTails.set(id, next)
  const release = (): void => {
    if (writeTails.get(id) === next) writeTails.delete(id)
  }
  // Give the cleanup chain both handlers so a failed write cannot create a second, unobserved
  // rejected promise through `finally`.
  void next.then(release, release)
  return next
}

const writeManyInOrder = <T>(ids: readonly string[], write: () => Promise<T>): Promise<T> => {
  const unique = [...new Set(ids)].sort()
  const previous = Promise.all(
    unique.map(async (id) => {
      try {
        await (writeTails.get(id) ?? Promise.resolve())
      } catch {}
    }),
  )
  const next = previous.then(write)
  for (const id of unique) writeTails.set(id, next)
  const release = (): void => {
    for (const id of unique) {
      if (writeTails.get(id) === next) writeTails.delete(id)
    }
  }
  void next.then(release, release)
  return next
}

const persist = async (placed: PlacedTemplate): Promise<SaveResult> => {
  if (isServerTemplate(placed)) {
    return setServerTemplatePreference(placed.id, placed.appearance, placed.owns)
      ? { status: 'saved', revision: placed.revision }
      : { status: 'limit' }
  }
  const { tiles, artwork, ...rest } = placed
  // A new record has nothing stored yet, so its pixels are always the ones just imported.
  const indices = artwork.indices
  if (indices === null) throw new RangeError('a new template has no pixels in memory')
  return await writeInOrder(
    placed.id,
    async () => await saveTemplate({ ...rest, tileKeys: [...tiles], indices }, null),
  )
}

const savePlaced = async (
  placed: PlacedTemplate,
  expectedRevision: number | null = placed.revision,
  visible: boolean = placed.visible,
): Promise<SaveResult> => {
  if (isServerTemplate(placed)) {
    return setServerTemplatePreference(placed.id, placed.appearance, placed.owns)
      ? { status: 'saved', revision: placed.revision }
      : { status: 'limit' }
  }
  // A metadata change on a stored record keeps its pixels, so it never needs them in memory.
  const { tiles, artwork, ...rest } = placed
  return await saveTemplate(
    {
      ...rest,
      visible,
      tileKeys: [...tiles],
      indices: expectedRevision === null ? artwork.indices : null,
    },
    expectedRevision,
  )
}

// A plain image has no meaningful position until its first placement is applied. Keep it local
// until then so a second tab restoring IndexedDB cannot mistake an active placement for crash
// residue and delete it underneath the owner.
const isPendingImage = (template: PlacedTemplate): boolean =>
  template.source === 'image' && !template.everPlaced

/** A catalog entry for a stored record. The caller accounts for any pixels it installs. */
const placedFromStored = (
  stored: StoredMetadata,
  tiles: ReadonlySet<string>,
  indices: Uint8Array | null,
): PlacedTemplate => ({
  ...stored,
  artwork: { indices },
  surface: stored.surface ?? WORLD_TEMPLATE_SURFACE,
  appearance: stored.appearance ?? null,
  owns: stored.owns ?? (stored.appearance != null ? APPEARANCE_GROUPS : []),
  folderId: stored.folderId ?? null,
  visible: stored.visible,
  tiles,
})

const removeStaleLocalState = (existing: PlacedTemplate): void => {
  retainedIndexPixels -= residentArea(existing)
  previewOrigins.delete(existing.id)
  templates.delete(existing.id)
  noteReconciliation(existing.id)
  notify()
}

/** Replace stale process-local state with the durable winner after an IndexedDB CAS conflict. */
const reconcileConflictExclusive = async (id: string): Promise<void> => {
  const MAX_RECONCILIATION_ATTEMPTS = 4
  for (let attempt = 0; attempt < MAX_RECONCILIATION_ATTEMPTS; attempt++) {
    const existing = templates.get(id)
    if (existing === undefined) return
    const loaded = await loadTemplate(id, MAX_RESIDENT_PIXELS)
    if (loaded.status === 'unavailable') return
    if (loaded.status === 'missing') {
      removeStaleLocalState(existing)
      return
    }
    if (loaded.status === 'invalid') {
      const deleted = await discardTemplate(id, loaded.revision)
      if (deleted.status === 'saved') {
        removeStaleLocalState(existing)
        return
      }
      if (deleted.status === 'conflict') continue
      warn('install', `could not remove invalid conflict winner for ${existing.name}`)
      return
    }
    let winner: StoredTemplate
    try {
      winner = normaliseStoredTemplate(loaded.template)
      if (winner.id !== id || (winner.source === 'image' && !winner.everPlaced)) {
        throw new RangeError('winning template state is invalid')
      }
    } catch (error) {
      const raw = isRecord(loaded.template) ? loaded.template : {}
      const revision =
        Number.isSafeInteger(raw.revision) && Number(raw.revision) >= 0 ? Number(raw.revision) : 0
      const deleted = await discardTemplate(id, revision)
      if (deleted.status === 'saved') {
        removeStaleLocalState(existing)
        return
      }
      if (deleted.status === 'conflict') continue
      warn(
        'install',
        `could not remove invalid conflict winner for ${existing.name}`,
        String(error),
      )
      return
    }
    // Unchanged on disk: keep this artwork, so progress and textures keyed on it survive.
    if (winner.revision === existing.revision) return
    let tiles: ReadonlySet<string>
    try {
      tiles = await paintedTileKeys(winner)
    } catch (error) {
      const deleted = await discardTemplate(id, winner.revision)
      if (deleted.status === 'saved') {
        removeStaleLocalState(existing)
        return
      }
      if (deleted.status === 'conflict') continue
      warn(
        'install',
        `could not remove invalid conflict winner for ${existing.name}`,
        String(error),
      )
      return
    }
    if (templates.get(id) !== existing) continue
    previewOrigins.delete(id)
    // The winner stays in memory only where the stale copy was, or where it fits for free.
    const wasResident = existing.artwork.indices !== null
    setPixels(existing, null)
    // Split the pixels off, so the catalog entry holds them only through its artwork.
    const { indices, ...metadata } = winner
    const area = indices.length
    const resident = wasResident ? makeRoom(area, id) : fitsResident(area)
    templates.set(id, placedFromStored(metadata, tiles, resident ? indices : null))
    if (resident) retainedIndexPixels += area
    noteReconciliation(id)
    notify()
    return
  }
  warn('install', `could not reconcile ${id}: conflict retry limit reached`)
}

const reconcileConflict = async (id: string): Promise<void> => {
  const running = reconciliationTail.then(
    async () => await reconcileConflictExclusive(id),
    async () => await reconcileConflictExclusive(id),
  )
  reconciliationTail = running.then(
    () => undefined,
    () => undefined,
  )
  await running
}

const committedRevision = (result: SaveResult): number | null =>
  result.status === 'saved' ? result.revision : null

/**
 * Is there room for this server template, before anything is downloaded for it?
 *
 * Copies that do not fit beside the others wait on disk, so the only refusal is a template too large
 * to ever be in memory, or an id a Local template already holds. Asked before downloading, so a
 * server advertising such a template costs no transfer.
 */
export const hasRoomForServerTemplate = (id: string, nextPixels: number): boolean => {
  if (!Number.isSafeInteger(nextPixels) || nextPixels < 0) return false
  const existing = templates.get(id)
  if (existing !== undefined && !isServerTemplate(existing)) return false
  return nextPixels <= MAX_RESIDENT_PIXELS
}

/**
 * Put a template published by a server into the store, replacing any earlier copy of it.
 *
 * Its local switches survive the replacement: whether it is showing and how it is drawn are this
 * browser's opinions about someone else's template, and re-syncing pixels is no reason to discard
 * them. Everything else — the name, where it sits, the pixels — comes from the server.
 *
 * Downloaded pixels are cached on disk and stay in memory if they fit. Null indices install a copy
 * whose pixels are already cached at this version, without reading them.
 */
export const putServerTemplate = async (
  template: Omit<ImportedTemplate, 'indices'> & {
    indices: Uint8Array | null
    surface?: TemplateSurface
    serverUrl: string
    serverTemplateId: string
    serverNodeId: string | null
    serverVersion: string
    serverUnpublished?: boolean
    sourceOpacity?: number
    serverConnection?: ConnectedServer
    serverTileKeys?: readonly string[]
    wrapX?: boolean
  },
  /** Checked after every awaited step, immediately before the live row may change. */
  isCurrent: () => boolean = () => true,
): Promise<boolean> => {
  const restoring = restoreInFlight
  if (restoring !== null) await restoring
  return await writeInOrder(template.id, async () => {
    if (!isCurrent()) return false
    const existing = templates.get(template.id)
    if (existing !== undefined && !isServerTemplate(existing)) {
      throw new RangeError('server template id collides with a local template')
    }
    const visible = existing?.visible ?? isScopeVisible(template.id)
    const preference = existing === undefined ? serverTemplatePreference(template.id) : undefined
    const { indices, ...metadata } = template
    // Without server-reported coverage, colour navigation and full progress scans need the tiles.
    let tiles: ReadonlySet<string> = new Set<string>()
    if (template.serverTileKeys === undefined) {
      if (indices === null) throw new RangeError('a cached server template needs its painted tiles')
      tiles = await paintedTileKeys({ ...template, indices })
    }
    // On disk before it can be evicted, so dropping it from memory never loses it. A draft stays off
    // disk and downloads again instead.
    if (template.serverUnpublished === true) await forgetServerPixels([template.id])
    else if (indices !== null) {
      await saveServerPixels(template.id, template.serverVersion, indices, template.opaque)
    }
    if (!isCurrent()) return false
    if (existing !== undefined) setPixels(existing, null)
    const resident = indices !== null && makeRoom(indices.length, template.id)
    templates.set(template.id, {
      ...metadata,
      artwork: { indices: resident ? indices : null },
      surface: template.surface ?? WORLD_TEMPLATE_SURFACE,
      tiles,
      // Whether someone else's template is on *your* canvas is your decision and nobody else's, so
      // it is read back from this browser's own record rather than defaulted.
      visible,
      everPlaced: true,
      appearance: existing !== undefined ? existing.appearance : (preference?.appearance ?? null),
      revision: existing?.revision ?? 0,
      owns: existing !== undefined ? existing.owns : (preference?.owns ?? []),
      folderId: null,
    })
    if (resident) retainedIndexPixels += indices.length
    notify()
    return true
  })
}

/** Refresh server-owned metadata without rebuilding unchanged pixels. */
export const updateServerTemplateMetadata = async (
  id: string,
  name: string,
  serverNodeId: string | null,
  serverUnpublished: boolean,
  serverConnection?: ConnectedServer,
): Promise<boolean> =>
  await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || !isServerTemplate(existing)) return false
    if (name.length === 0 || name.length > MAX_TEMPLATE_NAME_LENGTH) return false
    if (
      existing.name === name &&
      existing.serverNodeId === serverNodeId &&
      (existing.serverUnpublished === true) === serverUnpublished &&
      (serverConnection === undefined || existing.serverConnection === serverConnection)
    )
      return true
    // Unpublished since its pixels were saved: take them back off disk.
    if (serverUnpublished && existing.serverUnpublished !== true) await forgetServerPixels([id])
    templates.set(id, {
      ...existing,
      name,
      serverNodeId,
      serverUnpublished,
      ...(serverConnection === undefined ? {} : { serverConnection }),
    })
    notify()
    return true
  })

/** Drop a server template we hold, because the server has stopped publishing it. */
export const forgetServerTemplate = async (id: string): Promise<void> =>
  await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || !isServerTemplate(existing)) return
    retainedIndexPixels -= residentArea(existing)
    previewOrigins.delete(id)
    templates.delete(id)
    notify()
    await forgetServerPixels([id])
  })

/**
 * Forget everything one server published, and free its decoded indices with it.
 *
 * For disconnecting. The ordinary sync removes templates a server has stopped publishing, but a
 * disconnected server is never synced again — so its templates stayed in this store forever, drawn
 * on the canvas, belonging to a server that is no longer in the list and with no row anywhere to
 * switch them off from.
 */
export const forgetServerTemplates = async (serverUrl: string): Promise<void> => {
  const ids = [...templates.values()]
    .filter((template) => template.serverUrl === serverUrl)
    .map(({ id }) => id)
  if (ids.length === 0) return
  await writeManyInOrder(ids, async () => {
    let removed = false
    for (const id of ids) {
      const template = templates.get(id)
      if (template === undefined || template.serverUrl !== serverUrl) continue
      retainedIndexPixels -= residentArea(template)
      previewOrigins.delete(template.id)
      templates.delete(template.id)
      removed = true
    }
    if (removed) notify()
    await forgetServerPixels(ids)
  })
}

/** Forget one server's rows on one drawing surface while preserving its other canvases. */
export const forgetServerSurfaceTemplates = async (
  serverUrl: string,
  surface: TemplateSurface,
): Promise<void> => {
  const ids = [...templates.values()]
    .filter(
      (template) =>
        template.serverUrl === serverUrl &&
        sameTemplateSurface(template.surface ?? WORLD_TEMPLATE_SURFACE, surface),
    )
    .map(({ id }) => id)
  await Promise.all(ids.map(async (id) => await forgetServerTemplate(id)))
}

/** Admit an import, optionally committing an existing placement in the same initial write. */
export const addLocalTemplate = async (
  template: ImportedTemplate,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
  everPlaced = false,
): Promise<PlacedTemplate> => {
  const restoring = restoreInFlight
  if (restoring !== null) await restoring
  const scoped = { ...template, surface }
  validatePlacement(scoped)
  if (
    typeof template.id !== 'string' ||
    typeof template.name !== 'string' ||
    template.id.length === 0 ||
    template.id.length > MAX_TEMPLATE_ID_LENGTH ||
    template.name.length > MAX_TEMPLATE_NAME_LENGTH
  ) {
    throw new RangeError('local template metadata is too large')
  }
  if (templates.has(template.id) || pendingAdds.has(template.id)) {
    throw new RangeError('local template id already exists')
  }
  // A new template is being placed, so it needs its pixels in memory.
  if (!makeRoom(template.indices.length)) {
    throw new RangeError('templates in memory exceed the pixel budget')
  }
  touch(template.id)
  pendingAdds.add(template.id)
  pendingIndexPixels += template.indices.length
  try {
    const tiles = await paintedTileKeys(scoped)
    const placed: PlacedTemplate = {
      ...withArtwork(template),
      updatedAt: Date.now(),
      surface,
      tiles,
      visible: true,
      everPlaced,
      // Follows the global appearance until someone touches this one's own controls.
      appearance: null,
      owns: [],
      revision: 0,
      folderId: null,
    }
    let revision = 0
    if (!isPendingImage(placed)) {
      const saved = await persist(placed)
      if (saved.status !== 'saved') {
        throw new Error('local template could not be saved')
      }
      revision = saved.revision
    }
    const admitted = { ...placed, revision }
    templates.set(template.id, admitted)
    retainedIndexPixels += template.indices.length
    log('install', `placed ${template.name}`, { tiles: tiles.size })
    notify()
    return admitted
  } finally {
    pendingAdds.delete(template.id)
    pendingIndexPixels -= template.indices.length
  }
}

/**
 * Make a durable local copy without carrying any server-owned identity fields across the boundary.
 *
 * Picking the imported fields explicitly makes a server identity unrepresentable in the copy. An
 * image import is normally pending until its first placement; this copy already has a position, so
 * marking that placement immediately is also what commits it to IndexedDB before its source can be
 * removed. A server source transfers its immutable indices to the Local identity after that commit,
 * so a move at the aggregate pixel budget does not need to retain the same artwork twice.
 */
/** Durable Local placement does not carry the server-only antimeridian representation. */
export const canCopyAsLocalTemplate = (template: PlacedTemplate): boolean =>
  template.wrapX !== true || template.originX + template.width <= WORLD_PIXELS

export const copyAsLocalTemplate = async (
  template: PlacedTemplate,
  id: string,
  /** Server templates keep theirs on the server, so the caller fetches it. */
  authoring: TemplateAuthoring | null = template.authoring ?? null,
): Promise<PlacedTemplate> => {
  if (!canCopyAsLocalTemplate(template)) {
    throw new RangeError('wrapped server templates cannot be copied into Local')
  }
  const restoring = restoreInFlight
  if (restoring !== null) await restoring
  const imported: ImportedTemplate = {
    id,
    name: template.name,
    source: 'image',
    ...(template.sortOrder === undefined ? {} : { sortOrder: template.sortOrder }),
    originX: template.originX,
    originY: template.originY,
    width: template.width,
    height: template.height,
    indices: await templatePixels(template),
    moved: template.moved,
    opaque: template.opaque,
    ...(authoring === null ? {} : { authoring }),
  }
  if (isServerTemplate(template)) {
    const surface = template.surface ?? WORLD_TEMPLATE_SURFACE
    validatePlacement({ ...imported, surface })
    if (
      id.length === 0 ||
      id.length > MAX_TEMPLATE_ID_LENGTH ||
      imported.name.length > MAX_TEMPLATE_NAME_LENGTH ||
      templates.has(id) ||
      pendingAdds.has(id)
    ) {
      throw new RangeError('local template metadata or id is unavailable')
    }
    const source = templates.get(template.id)
    if (source !== template) throw new Error('server template changed while it was being copied')
    // The copy takes over the source's pixels, so only pixels the source did not hold need room.
    if (!makeRoom(imported.indices.length - residentArea(source), template.id)) {
      throw new RangeError('templates in memory exceed the pixel budget')
    }

    pendingAdds.add(id)
    try {
      const tiles = await paintedTileKeys({ ...imported, surface })
      const placed: PlacedTemplate = {
        ...withArtwork(imported),
        updatedAt: Date.now(),
        surface,
        tiles,
        visible: true,
        everPlaced: true,
        appearance: null,
        owns: [],
        revision: 0,
        folderId: null,
      }
      const saved = await persist(placed)
      if (saved.status !== 'saved') {
        throw new Error('local template copy could not be saved')
      }
      if (templates.get(template.id) !== source) {
        await deleteTemplate(id, saved.revision)
        throw new Error('server template changed while it was being copied')
      }

      const copied = { ...placed, revision: saved.revision }
      previewOrigins.delete(template.id)
      templates.delete(template.id)
      templates.set(id, copied)
      retainedIndexPixels += areaOf(copied) - residentArea(source)
      notify()
      return copied
    } finally {
      pendingAdds.delete(id)
    }
  }

  const copied = await addLocalTemplate(imported, template.surface ?? WORLD_TEMPLATE_SURFACE)
  if (await markPlaced(copied.id)) {
    return templates.get(copied.id) ?? copied
  }
  await removeLocalTemplate(copied.id)
  throw new Error('local template copy could not be saved')
}

/** Retry restore once a blocked IndexedDB open settles. */
const scheduleRestoreRecovery = (recovery: Promise<void> | null): void => {
  if (recovery === null || scheduledRestoreRecovery === recovery) return
  scheduledRestoreRecovery = recovery
  void recovery.then(() => {
    if (scheduledRestoreRecovery !== recovery) return
    scheduledRestoreRecovery = null
    const activeRestore = restoreInFlight
    if (activeRestore === null) {
      void restoreLocalTemplates()
      return
    }
    void activeRestore.then(
      () => void restoreLocalTemplates(),
      () => void restoreLocalTemplates(),
    )
  })
}

type RestoreOutcome = 'restored' | 'skipped' | 'retry'

/** Discard a record restore cannot use. A conflict means another tab rewrote it, so look again. */
const discardRecord = async (
  key: IDBValidKey,
  revision: number,
  seen: Map<string, number>,
  error?: unknown,
): Promise<RestoreOutcome> => {
  warn('install', `discarded invalid local template ${String(key)}`, String(error ?? 'invalid'))
  const deleted = await discardTemplate(key, revision)
  if (deleted.status !== 'conflict' || typeof key !== 'string') return 'skipped'
  seen.delete(key)
  return 'retry'
}

/**
 * Add one stored record to the catalog.
 *
 * A record that carries its painted tiles joins without reading its pixels. One written before
 * tiles were stored is read once to count them, and keeps its pixels if they fit.
 */
const restoreRecord = async (
  record: StoredRecord,
  seen: Map<string, number>,
): Promise<RestoreOutcome> => {
  const id = record.id as string
  const recordRevision = Number.isSafeInteger(record.revision) ? Number(record.revision) : 0
  seen.set(id, recordRevision)
  // Restore runs again after every native refresh; templates already here were restored before.
  const present = templates.get(id)
  if (present !== undefined && !isServerTemplate(present)) return 'skipped'
  const tileKeys = catalogTileKeys(record)
  let source: unknown = record
  let indices: Uint8Array | null = null
  if (tileKeys === null) {
    const loaded = await hydrateStoredTemplate(record, MAX_RESIDENT_PIXELS)
    // Unreadable now is environmental, and must never destroy data.
    if (loaded.status === 'unavailable') {
      warn('install', `could not read local template ${id}`)
      return 'skipped'
    }
    const stored = loaded.status === 'loaded' ? storedOrNull(loaded.template) : null
    if (stored === null) return await discardRecord(id, recordRevision, seen)
    source = stored
    indices = stored.indices
  }
  let template: StoredMetadata
  try {
    // Earlier builds could persist 0x0, non-finite, out-of-world, or fully transparent records.
    // Validate each independently so one bad legacy entry cannot prevent every good restore.
    template = normaliseStoredMetadata(source)
  } catch (error) {
    return await discardRecord(id, recordRevision, seen, error)
  }
  if (
    template.folderId != null &&
    !getState().localFolders.some(
      (folder) =>
        folder.id === template.folderId &&
        sameTemplateSurface(
          folder.surface ?? WORLD_TEMPLATE_SURFACE,
          template.surface ?? WORLD_TEMPLATE_SURFACE,
        ),
    )
  ) {
    // Folder state and template records live in different stores. Another tab can delete the
    // folder while this record's assignment commits, so no process-local lease can make the two
    // writes atomic. A missing parent has one deterministic recovery: top-level Local, which is
    // also where deleting a folder promises to move its contents.
    const repaired = await saveTemplateFolders([
      { id, expectedRevision: template.revision, folderId: null },
    ])
    if (repaired.status === 'conflict') {
      seen.delete(id)
      return 'retry'
    }
    const revision =
      repaired.status === 'saved'
        ? (repaired.revisions.get(id) ?? template.revision)
        : template.revision
    if (repaired.status === 'unavailable') {
      warn('install', `could not durably repair missing folder for ${template.name}`)
    }
    template = { ...template, folderId: null, revision }
    seen.set(id, revision)
  }
  let tiles: ReadonlySet<string> = new Set(tileKeys ?? [])
  if (indices !== null) {
    try {
      tiles = await paintedTileKeys({ ...template, indices })
    } catch (error) {
      return await discardRecord(id, template.revision, seen, error)
    }
    void saveTemplateTileKeys(id, template.revision, [...tiles])
  }
  if (templates.has(id) || pendingAdds.has(id)) {
    warn('install', `could not restore ${template.name}: local template id already exists`)
    return 'skipped'
  }
  const resident = indices !== null && fitsResident(areaOf(template))
  templates.set(id, placedFromStored(template, tiles, resident ? indices : null))
  if (resident) retainedIndexPixels += areaOf(template)
  return 'restored'
}

/**
 * Rebuild the catalog on startup from every stored record, reading pixels only where needed.
 *
 * Templates join evicted; {@link fillResidentSet} then loads what fits, visible ones first.
 */
const restoreStoredTemplates = async (): Promise<void> => {
  let restored = 0
  const seenRevisions = new Map<string, number>()
  let retry = false
  let passes = 0
  do {
    passes++
    retry = false
    const catalog = await loadTemplateCatalog(seenRevisions)
    scheduleRestoreRecovery(catalog.retryAfterUnavailable)
    for (const failure of catalog.invalid) {
      const key = 'id' in failure ? failure.id : failure.key
      if ('id' in failure) seenRevisions.set(failure.id, failure.revision)
      if ((await discardRecord(key, failure.revision, seenRevisions)) === 'retry') retry = true
    }
    for (const record of catalog.records) {
      const outcome = await restoreRecord(record, seenRevisions)
      if (outcome === 'restored') restored++
      if (outcome === 'retry') retry = true
    }
  } while (retry && passes < MAX_RESTORE_PASSES)
  if (restored > 0) log('install', `restored ${restored} local templates`)
  notify()
  void fillResidentSet()
}

export const restoreLocalTemplates = (): Promise<void> => {
  if (restoreInFlight !== null) return restoreInFlight
  const restoring = restoreStoredTemplates()
  restoreInFlight = restoring
  void restoring.then(
    () => {
      if (restoreInFlight === restoring) restoreInFlight = null
    },
    () => {
      if (restoreInFlight === restoring) restoreInFlight = null
    },
  )
  return restoring
}

/** Apply native projections through the same serialized reconciliation used by local edit conflicts. */
export const refreshPersonalTemplates = async (): Promise<void> => {
  if (restoreInFlight !== null) await restoreInFlight
  for (const template of [...templates.values()]) {
    if (isServerTemplate(template) || isPendingImage(template)) continue
    if ((template.surface ?? WORLD_TEMPLATE_SURFACE).kind !== 'world') continue
    await writeInOrder(template.id, async () => await reconcileConflict(template.id))
  }
  await restoreLocalTemplates()
}

interface MoveWaiter {
  readonly resolve: (saved: boolean) => void
  readonly reject: (error: unknown) => void
}

interface MoveTarget {
  readonly originX: number
  readonly originY: number
  readonly everPlaced: boolean
  readonly waiters: readonly MoveWaiter[]
}

interface MoveQueue {
  pending: MoveTarget | null
  running: boolean
}

const moveQueues = new Map<string, MoveQueue>()

const resolveMove = (target: MoveTarget, saved: boolean): void => {
  for (const waiter of target.waiters) waiter.resolve(saved)
}

const rejectMove = (target: MoveTarget, error: unknown): void => {
  for (const waiter of target.waiters) waiter.reject(error)
}

const drainMoves = async (id: string, queue: MoveQueue): Promise<void> => {
  queue.running = true
  while (queue.pending !== null) {
    const target = queue.pending
    queue.pending = null
    const existing = templates.get(id)
    if (existing === undefined) {
      resolveMove(target, false)
      continue
    }
    try {
      let tiles = await paintedTileKeys({
        ...existing,
        originX: target.originX,
        originY: target.originY,
        indices: await templatePixels(existing),
      })
      // Pointer events can arrive faster than a large index scan. Do not install stale intermediate
      // work; immediately scan only the newest requested position.
      const pendingAfterScan = queue.pending as MoveTarget | null
      if (pendingAfterScan !== null) {
        queue.pending = {
          ...pendingAfterScan,
          everPlaced: target.everPlaced || pendingAfterScan.everPlaced,
          waiters: [...target.waiters, ...pendingAfterScan.waiters],
        }
        continue
      }
      const current = templates.get(id)
      if (current === undefined || deleting.has(id)) {
        resolveMove(target, false)
        continue
      }
      const saved = await writeInOrder(id, async () => {
        const latest = templates.get(id)
        if (latest === undefined || deleting.has(id)) return false
        validatePlacement(latest, target.originX, target.originY)
        const sourceChanged =
          latest.artwork !== existing.artwork ||
          latest.width !== existing.width ||
          latest.height !== existing.height
        if (sourceChanged) {
          tiles = await paintedTileKeys({
            ...latest,
            originX: target.originX,
            originY: target.originY,
            indices: await templatePixels(latest),
          })
        }
        const next = {
          ...latest,
          updatedAt: Date.now(),
          originX: target.originX,
          originY: target.originY,
          everPlaced: latest.everPlaced || target.everPlaced,
          tiles,
        }
        let revision = latest.revision
        if (!isPendingImage(latest) || target.everPlaced) {
          const result = await savePlaced(next, isPendingImage(latest) ? null : latest.revision)
          const committed = committedRevision(result)
          if (committed === null) {
            if (result.status === 'conflict') {
              await reconcileConflict(id)
            }
            return false
          }
          revision = committed
        }
        previewOrigins.delete(id)
        templates.set(id, { ...next, revision })
        notify()
        return true
      })
      if (!saved) {
        warn('install', `move for ${current.name} was not saved`)
      }
      resolveMove(target, saved)
    } catch (error) {
      rejectMove(target, error)
    }
  }
  queue.running = false
  if (queue.pending === null) moveQueues.delete(id)
}

const enqueueMove = async (
  id: string,
  originX: number,
  originY: number,
  everPlaced: boolean,
): Promise<boolean> => {
  const queue = moveQueues.get(id) ?? { pending: null, running: false }
  moveQueues.set(id, queue)
  return await new Promise<boolean>((resolve, reject) => {
    const previous = queue.pending
    queue.pending = {
      originX,
      originY,
      everPlaced: everPlaced || previous?.everPlaced === true,
      waiters: [...(previous?.waiters ?? []), { resolve, reject }],
    }
    if (!queue.running) void drainMoves(id, queue)
  })
}

/** Move a template and rescan its painted tile keys, coalescing updates to the latest position. */
export const moveLocalTemplate = async (
  id: string,
  originX: number,
  originY: number,
): Promise<boolean> => {
  const existing = templates.get(id)
  if (existing === undefined) return false
  const roundedX = Math.round(originX)
  const roundedY = Math.round(originY)
  validatePlacement(existing, roundedX, roundedY)
  if (existing.originX === roundedX && existing.originY === roundedY && !moveQueues.has(id)) {
    clearLocalPreview(id)
    return true
  }
  return await enqueueMove(id, roundedX, roundedY, false)
}

export const markPlaced = async (id: string): Promise<boolean> => {
  return await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || deleting.has(id)) return false
    const next = { ...existing, everPlaced: true, updatedAt: Date.now() }
    const result = await savePlaced(next, isPendingImage(existing) ? null : existing.revision)
    const revision = committedRevision(result)
    if (revision === null) {
      if (result.status === 'conflict') await reconcileConflict(id)
      warn('install', `placement for ${next.name} was not saved`)
      return false
    }
    templates.set(id, { ...next, revision })
    notify()
    return true
  })
}

/** Persist the final origin and first-placement marker in one durable state transition. */
export const placeLocalTemplate = async (
  id: string,
  originX: number,
  originY: number,
): Promise<boolean> => {
  const existing = templates.get(id)
  if (existing === undefined) return false
  const roundedX = Math.round(originX)
  const roundedY = Math.round(originY)
  validatePlacement(existing, roundedX, roundedY)
  if (existing.originX === roundedX && existing.originY === roundedY && !moveQueues.has(id)) {
    clearLocalPreview(id)
    return await markPlaced(id)
  }
  return await enqueueMove(id, roundedX, roundedY, true)
}

/** Move a template into a Local folder, or to the top level with null. */
export const setTemplateFolder = async (id: string, folderId: string | null): Promise<boolean> => {
  const releaseFolder = folderId === null ? null : leaseLocalFolder(folderId)
  if (folderId !== null && releaseFolder === null) return false
  try {
    return await writeInOrder(id, async () => {
      const existing = templates.get(id)
      if (existing === undefined || deleting.has(id)) return false
      if (folderId !== null) {
        const folder = getState().localFolders.find((candidate) => candidate.id === folderId)
        if (
          folder === undefined ||
          !sameTemplateSurface(
            existing.surface ?? WORLD_TEMPLATE_SURFACE,
            folder.surface ?? WORLD_TEMPLATE_SURFACE,
          )
        ) {
          return false
        }
      }
      if (existing.folderId === folderId) return true
      const next = { ...existing, folderId, updatedAt: Date.now() }
      let revision = existing.revision
      if (!isPendingImage(existing)) {
        const result = await savePlaced(next)
        const committed = committedRevision(result)
        if (committed === null) {
          if (result.status === 'conflict') await reconcileConflict(id)
          warn('install', `folder change for ${next.name} was not saved`)
          return false
        }
        revision = committed
      }
      templates.set(id, { ...next, revision })
      notify()
      return true
    })
  } finally {
    releaseFolder?.()
  }
}

/** Move several local templates together. A failed CAS or IndexedDB write moves none of them. */
export const setTemplatesFolder = async (
  ids: readonly string[],
  folderId: string | null,
): Promise<boolean> => {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return true
  const releaseFolder = folderId === null ? null : leaseLocalFolder(folderId)
  if (folderId !== null && releaseFolder === null) return false
  try {
    return await writeManyInOrder(unique, async () => {
      const existing = unique.map((id) => templates.get(id))
      if (existing.some((template) => template === undefined || deleting.has(template.id))) {
        return false
      }
      const present = existing as PlacedTemplate[]
      if (folderId !== null) {
        const folder = getState().localFolders.find((candidate) => candidate.id === folderId)
        if (
          folder === undefined ||
          present.some(
            (template) =>
              !sameTemplateSurface(
                template.surface ?? WORLD_TEMPLATE_SURFACE,
                folder.surface ?? WORLD_TEMPLATE_SURFACE,
              ),
          )
        ) {
          return false
        }
      }
      const changed = present.filter((template) => template.folderId !== folderId)
      if (changed.length === 0) return true
      const durable = changed.filter((template) => !isPendingImage(template))
      const updatedAt = Date.now()
      const result = await saveTemplateFolders(
        durable.map((template) => ({
          id: template.id,
          expectedRevision: template.revision,
          folderId,
          updatedAt,
        })),
      )
      if (result.status !== 'saved') {
        if (result.status === 'conflict') {
          for (const template of durable) await reconcileConflict(template.id)
        }
        warn('install', 'folder changes were not saved as one transaction')
        return false
      }
      for (const template of changed) {
        templates.set(template.id, {
          ...template,
          folderId,
          updatedAt,
          revision: result.revisions.get(template.id) ?? template.revision,
        })
      }
      notify()
      return true
    })
  } finally {
    releaseFolder?.()
  }
}

/** Archive the previous local image and publish its replacement only after the transaction commits. */
export const replaceLocalArtwork = async (
  expected: PlacedTemplate,
  indices: Uint8Array,
): Promise<void> => {
  await writeInOrder(expected.id, async () => {
    const checkCurrent = (): void => {
      if (
        !isCurrentTemplate(expected) ||
        deleting.has(expected.id) ||
        previewOrigins.has(expected.id)
      ) {
        throw new Error('That template changed during the update. Try again.')
      }
      if (isServerTemplate(expected) || isPendingImage(expected)) {
        throw new Error('Finish placing this local template before updating it.')
      }
    }
    checkCurrent()
    // Canvas artwork does not come from the recipe, so this version is processed-only.
    const { authoring: _authoring, artwork: _artwork, tiles: _tiles, ...processedOnly } = expected
    const next = {
      ...processedOnly,
      indices,
      opaque: indices.reduce((count, index) => count + Number(index !== TRANSPARENT_INDEX), 0),
      moved: 0,
      updatedAt: Date.now(),
    }
    const tiles = await paintedTileKeys(next)
    checkCurrent()
    const result = await saveTemplate({ ...next, tileKeys: [...tiles] }, expected.revision, true)
    if (result.status === 'limit') {
      throw new Error(
        'Local version history is full. Remove an unused local template to free its history, then try again.',
      )
    }
    if (result.status !== 'saved') {
      throw new Error(
        result.status === 'conflict'
          ? 'Another tab changed this template. Reload before trying again.'
          : 'Could not save the new version in this browser. Check available storage and try again.',
      )
    }
    // The old pixels go; the new ones stay in memory only if the budget allows, like any load.
    setPixels(expected, null)
    const resident = makeRoom(areaOf(next), expected.id)
    const { indices: _indices, ...metadata } = next
    templates.set(expected.id, {
      ...metadata,
      artwork: { indices: resident ? indices : null },
      tiles,
      revision: result.revision,
    })
    if (resident) retainedIndexPixels += areaOf(next)
    notify()
  })
}

export const renameLocalTemplate = async (id: string, name: string): Promise<boolean> => {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > MAX_TEMPLATE_NAME_LENGTH) return false
  return await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || deleting.has(id)) return false
    if (trimmed === existing.name) return true
    const next = { ...existing, name: trimmed, updatedAt: Date.now() }
    let revision = existing.revision
    if (!isPendingImage(existing)) {
      const result = await savePlaced(next)
      const committed = committedRevision(result)
      if (committed === null) {
        if (result.status === 'conflict') await reconcileConflict(id)
        warn('install', `rename for ${next.name} was not saved`)
        return false
      }
      revision = committed
    }
    templates.set(id, { ...next, revision })
    notify()
    return true
  })
}

/**
 * Whether a delete has been made terminal for this id, from any surface.
 *
 * `deleting` is set synchronously by {@link removeLocalTemplate} and outlives the IndexedDB work,
 * during which the record is still present in `localTemplates()`. A UI that reads only its own
 * "am I deleting this" flag will happily start a move, or offer a second delete, for a template
 * another surface has already condemned.
 */
export const isDeletingLocal = (id: string): boolean => deleting.has(id)

/** In-flight deletions, so a second caller joins the first rather than being told it failed. */
const deletions = new Map<string, Promise<boolean>>()

export const removeLocalTemplate = async (id: string): Promise<boolean> => {
  // A second surface asking for the same deletion is not a failure, and answering `false` made the
  // panel report one over a delete that was succeeding. Join the one already running instead.
  const running = deletions.get(id)
  if (running !== undefined) return await running
  const existing = templates.get(id)
  // Already gone — by this id's own earlier deletion, most likely — which is the outcome asked for.
  if (existing === undefined) return !templates.has(id)
  // Server rows are owned by their remote source. `forgetServerTemplate` is the sync lifecycle;
  // Local deletion must never make one disappear temporarily and then reappear on the next poll.
  if (isServerTemplate(existing)) return false
  if (deleting.has(id)) return false
  if ((deletionLeases.get(id) ?? 0) > 0) return false
  // Terminal immediately: in-flight scans and newly requested mutations must not queue a save
  // behind this delete and resurrect the record.
  deleting.add(id)
  const settled = (async (): Promise<boolean> => {
    // The guard is state, and other surfaces render from it — an open overlay menu locks its controls
    // and shows progress off this. Announcing it only once the record is gone leaves every one of them
    // stale for the whole IndexedDB round trip, and on a static map indefinitely.
    notify()
    let removed = false
    try {
      removed = await writeInOrder(id, async () => {
        const current = templates.get(id)
        if (current === undefined) return true
        if (!isPendingImage(current)) {
          const deleted = await deleteTemplate(id, current.revision)
          if (deleted.status !== 'saved') {
            if (deleted.status === 'conflict') {
              await reconcileConflict(id)
              return !templates.has(id)
            }
            return false
          }
        }
        retainedIndexPixels -= residentArea(current)
        previewOrigins.delete(id)
        templates.delete(id)
        notify()
        return true
      })
    } finally {
      deleting.delete(id)
      // Clearing it is a state change too. A refused delete otherwise leaves every surface that
      // rendered from the guard locked, with nothing to tell them it lifted.
      if (!removed) notify()
    }
    if (!removed) {
      warn('install', `deletion of ${existing.name} was not saved`)
      return false
    }
    return true
  })()
  deletions.set(id, settled)
  try {
    return await settled
  } finally {
    deletions.delete(id)
  }
}

export const setLocalVisible = async (id: string, visible: boolean): Promise<boolean> => {
  return await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || deleting.has(id)) return false
    if (existing.visible === visible) return true
    const next = { ...existing, visible }
    if (deleting.has(id)) return false
    let revision = existing.revision
    if (!isPendingImage(existing)) {
      const result = await savePlaced(next, existing.revision, visible)
      const committed = committedRevision(result)
      if (committed === null) {
        if (result.status === 'conflict') await reconcileConflict(id)
        warn('install', `visibility for ${next.name} was not saved`)
        return false
      }
      revision = committed
    }
    if (isServerTemplate(existing) && !setScopeVisible(id, visible)) {
      warn('install', `visibility for ${next.name} was not saved`)
      return false
    }
    templates.set(id, { ...next, revision })
    notify()
    return true
  })
}

/** World tiles worth scanning for navigation and mismatch work. */
export const templateTileKeys = (template: PlacedTemplate): Iterable<string> =>
  template.serverTileKeys ?? template.tiles.keys()

const mutateAppearance = async (
  id: string,
  mutate: (current: Appearance) => Appearance | null,
): Promise<boolean> =>
  await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || deleting.has(id)) return false
    const ownedAppearance = mutate(appearanceOf(existing))
    if (ownedAppearance !== null && !isAppearance(ownedAppearance)) return false
    const next = { ...existing, appearance: ownedAppearance }
    let revision = existing.revision
    if (!isPendingImage(existing)) {
      const result = await savePlaced(next)
      const committed = committedRevision(result)
      if (committed === null) {
        if (result.status === 'conflict') await reconcileConflict(id)
        warn('install', `appearance for ${next.name} was not saved`)
        return false
      }
      revision = committed
    }
    templates.set(id, { ...next, revision })
    notify()
    return true
  })

/** Change how one overlay draws. Appearance never affects its painted tile keys. */
/** Pass null to put the overlay back on the global defaults. */
export const setAppearance = async (
  id: string,
  appearance: Readonly<Partial<Appearance>> | null,
): Promise<boolean> => {
  // Own arrays before the ordered write yields. Scalar partial fields are merged with the appearance
  // current when the write executes, so independent queued controls cannot restore stale fields.
  const requested: Readonly<Partial<Appearance>> | null =
    appearance === null
      ? null
      : {
          ...appearance,
          ...(appearance.hiddenColours === undefined
            ? {}
            : { hiddenColours: [...appearance.hiddenColours] }),
        }
  return await mutateAppearance(id, (current) =>
    requested === null ? null : { ...current, ...requested },
  )
}

/** Toggle one appearance switch against the value current when its ordered write executes. */
export const toggleAppearanceBoolean = async (
  id: string,
  property: 'contrastOutline' | 'markMismatch' | 'markSelectedColour',
): Promise<boolean> =>
  await mutateAppearance(id, (current) => ({ ...current, [property]: !current[property] }))

/**
 * Take one group over, or hand it back to the defaults.
 *
 * Taking a group over copies the values it is *currently showing* into this template, so nothing
 * moves at the moment of the switch — the overlay looks identical and only stops following. Anything
 * else makes the switch itself an edit, which is a surprise nobody asked for.
 */
export const setOwnsGroup = async (
  id: string,
  group: AppearanceGroup,
  owns: boolean,
): Promise<boolean> =>
  await writeInOrder(id, async () => {
    const existing = templates.get(id)
    if (existing === undefined || deleting.has(id)) return false
    if (existing.owns.includes(group) === owns) return true
    const next: PlacedTemplate = {
      ...existing,
      appearance: owns ? appearanceOf(existing) : existing.appearance,
      owns: owns ? [...existing.owns, group] : existing.owns.filter((one) => one !== group),
    }
    let revision = existing.revision
    if (!isPendingImage(existing)) {
      const result = await savePlaced(next)
      const committed = committedRevision(result)
      if (committed === null) {
        if (result.status === 'conflict') await reconcileConflict(id)
        warn('install', `appearance ownership for ${next.name} was not saved`)
        return false
      }
      revision = committed
    }
    templates.set(id, { ...next, revision })
    notify()
    return true
  })

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
