import {
  sha256Hex,
  type TemplateSurface,
  type TemplateTag,
  TILE_SIZE,
  templateSurface,
  templateSurfaceBounds,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { warn } from '../debug.js'
import { isStoredBlob, isUint8Array, type StoredBlob } from '../page-world.js'
import type { Appearance, AppearanceGroup } from './appearance.js'
import { storedAuthoring } from './authoring.js'
import {
  type ImportedTemplate,
  MAX_TEMPLATE_ID_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
  processRecipe,
} from './import.js'
import {
  hasCurrentPalette,
  markCurrentPalette,
  migrateTemplateStorePalette,
  remapPaletteIndices,
  remapStoredAppearance,
} from './palette-migration.js'
import { LOCAL_TAG_STORE, upgradeLocalTags } from './tag-schema.js'

/**
 * Local templates on disk.
 *
 * IndexedDB rather than `GM_setValue` or `localStorage`, for a reason that is not preference: the
 * observed `.wplace` file is 11 MB and its decoded index array is 4 MB, which is past what a string
 * store will hold and would have to be base64'd to get there. IndexedDB takes a `Uint8Array`
 * directly.
 *
 * This is what makes navigating to an imported template survivable. There is no reachable MapLibre
 * instance, so going to a coordinate means a page load — and without persistence the import would
 * be destroyed by the very navigation meant to show it off.
 */

const DB_NAME = 'caelestis'
const STORE = 'local-templates'
// Shared with server-cache.ts: one database, one version, both stores created in either upgrade.
const VERSION = 6
const VERSIONS_STORE = 'local-template-versions'
const MAX_ARCHIVED_VERSIONS = 256
const MAX_ARCHIVED_INDEX_PIXELS = 64 * 1024 * 1024
let blockedOpenRequest: IDBOpenDBRequest | null = null
let blockedOpenRecovery: Promise<void> | null = null
let settleBlockedOpen: (() => void) | null = null

const markOpenBlocked = (request: IDBOpenDBRequest): void => {
  blockedOpenRequest = request
  if (blockedOpenRecovery !== null) return
  blockedOpenRecovery = new Promise<void>((resolve) => {
    settleBlockedOpen = resolve
  })
}

const finishBlockedOpen = (request: IDBOpenDBRequest): void => {
  if (blockedOpenRequest !== request) return
  blockedOpenRequest = null
  const settle = settleBlockedOpen
  settleBlockedOpen = null
  blockedOpenRecovery = null
  settle?.()
}

export interface StoredTemplate extends ImportedTemplate {
  /** Last mirrored tag assignments; owned by the tag transaction, not artwork edits. */
  readonly nativeTags?: readonly TemplateTag[]
  /** Native identity and last derived snapshot. Pending records are resumable migration journals. */
  readonly native?: {
    readonly id: string
    readonly status: 'pending' | 'linked'
    readonly token?: string
    readonly opacity?: number
    /** A native opacity edit overrides only opacity, without owning the whole pixels appearance. */
    readonly opacityOverride?: boolean
  }
  readonly updatedAt?: number
  /** Exact drawing surface. Records written before alliance support are world-scoped. */
  readonly surface?: TemplateSurface
  readonly visible: boolean
  readonly everPlaced: boolean
  /** Null means "follow the global appearance"; absent means the same, from before this was stored. */
  readonly appearance?: Appearance | null
  /** Monotonic compare-and-swap token. Records written before v3 restore as revision zero. */
  readonly revision: number
  /**
   * Which appearance groups this template answers for itself.
   *
   * Absent on anything stored before ownership was per group, where holding an appearance at all
   * meant owning everything — which is how it is read back.
   */
  readonly owns?: readonly AppearanceGroup[]
  /** Which Local folder this is in. Absent means the top level, as it did before folders existed. */
  readonly folderId?: string | null
  /**
   * Painted world tiles (`x/y`) at this placement, so a template can join the catalog without its
   * pixels in memory. Absent on records written before eviction, which restore by reading them.
   */
  readonly tileKeys?: readonly string[]
}

const open = (): Promise<IDBDatabase> => {
  if (blockedOpenRequest !== null) {
    return Promise.reject(new Error('indexedDB.open is still blocked by another connection'))
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION)
    let abandoned = false
    request.onupgradeneeded = (event) => {
      const db = request.result
      upgradeLocalTags(db)
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(VERSIONS_STORE)) {
        db.createObjectStore(VERSIONS_STORE, { keyPath: ['id', 'revision'] })
      }
      if (!db.objectStoreNames.contains('server-cache')) {
        db.createObjectStore('server-cache', { keyPath: 'url' })
      }
      if (event.oldVersion < 4) {
        const templates = request.transaction?.objectStore(STORE)
        if (templates !== undefined) migrateTemplateStorePalette(templates)
      }
    }
    request.onblocked = () => {
      abandoned = true
      markOpenBlocked(request)
      reject(new Error('indexedDB.open blocked by another connection'))
    }
    request.onsuccess = () => {
      const db = request.result
      finishBlockedOpen(request)
      if (abandoned) {
        db.close()
        return
      }
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => {
      finishBlockedOpen(request)
      reject(request.error ?? new Error('indexedDB.open failed'))
    }
  })
}

const normaliseRevision = (value: unknown): number =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0

/** Share the existing database upgrade and blocked-connection handling with tag persistence. */
export { open as openTemplateDatabase }

/** Read native identity links without hydrating artwork, including records outside the rendering budget. */
export const loadNativeTemplateIds = async (): Promise<ReadonlyMap<string, string>> => {
  const db = await open()
  try {
    return await new Promise((resolve, reject) => {
      const links = new Map<string, string>()
      const transaction = db.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor === null) return
        const value: unknown = cursor.value
        if (
          typeof value === 'object' &&
          value !== null &&
          'id' in value &&
          typeof value.id === 'string' &&
          'native' in value &&
          typeof value.native === 'object' &&
          value.native !== null &&
          'id' in value.native &&
          typeof value.native.id === 'string'
        )
          links.set(value.native.id, value.id)
        cursor.continue()
      }
      transaction.oncomplete = () => resolve(links)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

const writeVersioned = async (
  id: IDBValidKey,
  expectedRevision: number | null,
  operation: (
    templates: IDBObjectStore,
    nextRevision: number,
    current: unknown,
    transaction: IDBTransaction,
  ) => void,
  incrementRevision = true,
  history?: 'archive' | 'delete',
): Promise<SaveResult> => {
  try {
    const db = await open()
    try {
      return await new Promise<SaveResult>((resolve, reject) => {
        const stores = [STORE]
        if (history !== undefined) stores.push(VERSIONS_STORE)
        if (history === 'delete') stores.push(LOCAL_TAG_STORE)
        const transaction = db.transaction(stores, 'readwrite')
        const templates = transaction.objectStore(STORE)
        const request = templates.get(id)
        let result: SaveResult = { status: 'conflict' }
        request.onsuccess = () => {
          const current = request.result as { revision?: unknown } | undefined
          if (expectedRevision === null) {
            if (current !== undefined) return
          } else {
            if (current === undefined) return
            const actual = normaliseRevision(current.revision)
            if (incrementRevision && actual >= Number.MAX_SAFE_INTEGER - 1) return
            if (actual !== expectedRevision) return
          }
          const nextRevision = incrementRevision
            ? (expectedRevision ?? 0) + 1
            : (expectedRevision ?? 0)
          const commit = (): void => {
            if (history === 'archive') {
              transaction
                .objectStore(VERSIONS_STORE)
                .add({ ...current, id, revision: expectedRevision })
            } else if (history === 'delete') {
              transaction
                .objectStore(VERSIONS_STORE)
                .delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))
            }
            operation(templates, nextRevision, current, transaction)
            result = { status: 'saved', revision: nextRevision }
          }
          if (history === 'archive') {
            let records = 0
            let pixels = candidateIndexPixels(current)
            const cursorRequest = transaction.objectStore(VERSIONS_STORE).openCursor()
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result
              if (cursor !== null) {
                records++
                pixels = boundedPixelSum(pixels, candidateIndexPixels(cursor.value))
              }
              if (records >= MAX_ARCHIVED_VERSIONS || pixels > MAX_ARCHIVED_INDEX_PIXELS) {
                result = { status: 'limit' }
              } else if (cursor === null) {
                commit()
              } else {
                cursor.continue()
              }
            }
            cursorRequest.onerror = () =>
              reject(cursorRequest.error ?? new Error('indexedDB history cursor failed'))
            return
          }
          commit()
        }
        request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
        transaction.oncomplete = () => resolve(result)
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('indexedDB transaction failed'))
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('indexedDB transaction aborted'))
      })
    } finally {
      db.close()
    }
  } catch (error) {
    warn('install', 'local template storage unavailable', String(error))
    return { status: 'unavailable' }
  }
}

export type SaveResult =
  | { readonly status: 'saved'; readonly revision: number }
  | { readonly status: 'conflict' }
  | { readonly status: 'limit' }
  | { readonly status: 'unavailable' }

/** A record to save. Null indices keep the stored pixels, so an evicted template can save metadata. */
export type TemplateSave = Omit<StoredTemplate, 'indices'> & { readonly indices: Uint8Array | null }

/** Save metadata, archive and replace artwork, or replace a derived image after its history was reserved. */
export const saveTemplate = async (
  template: TemplateSave,
  expectedRevision: number | null,
  archiveCurrent = false,
  replaceArtwork = false,
): Promise<SaveResult> => {
  const { indices, ...metadata } = template
  if (indices === null && (expectedRevision === null || archiveCurrent || replaceArtwork)) {
    throw new RangeError('only a metadata save may keep the stored pixels')
  }
  return await writeVersioned(
    template.id,
    expectedRevision,
    (templates, revision, current) => {
      const savedMetadata = {
        ...metadata,
        nativeTags:
          typeof current === 'object' && current !== null && 'nativeTags' in current
            ? current.nativeTags
            : metadata.nativeTags,
      }
      // IndexedDB can inspect a Blob's size without first allocating an equally large typed array.
      // Legacy Uint8Array records remain readable; all new writes use this bounded representation.
      const currentIndices =
        expectedRevision !== null &&
        typeof current === 'object' &&
        current !== null &&
        'indices' in current
          ? current.indices
          : undefined
      const reusable =
        indices === null ||
        (!archiveCurrent &&
          !replaceArtwork &&
          hasCurrentPalette(current) &&
          (isUint8Array(currentIndices) || isStoredBlob(currentIndices)) &&
          candidateIndexPixels(current) === indices.length)
      if (reusable) {
        // Metadata-only mutations keep the already-cloned durable value. Re-wrapping a multi-MB
        // ArrayBuffer in a Blob copies it and makes every move/toggle/appearance change rewrite all
        // pixels even though this PR has no pixel-editing mutation.
        const record: Record<string, unknown> = {
          ...savedMetadata,
          revision,
          indices: currentIndices,
        }
        delete record.paletteMigration
        if (typeof current === 'object' && current !== null && 'paletteMigration' in current) {
          record.paletteMigration = current.paletteMigration
        }
        templates.put(record)
      } else {
        const bytes =
          indices.byteOffset === 0 && indices.byteLength === indices.buffer.byteLength
            ? (indices.buffer as ArrayBuffer)
            : indices.slice().buffer
        templates.put(
          markCurrentPalette({ ...savedMetadata, revision, indices: new Blob([bytes]) }),
        )
      }
    },
    true,
    archiveCurrent ? 'archive' : undefined,
  )
}

export interface TemplateFolderUpdate {
  readonly id: string
  readonly expectedRevision: number
  readonly folderId: string | null
  readonly updatedAt?: number
}

export type SaveTemplateFoldersResult =
  | { readonly status: 'saved'; readonly revisions: ReadonlyMap<string, number> }
  | { readonly status: 'conflict' }
  | { readonly status: 'unavailable' }

/** Save several folder assignments in one IndexedDB transaction, or none of them. */
export const saveTemplateFolders = async (
  updates: readonly TemplateFolderUpdate[],
): Promise<SaveTemplateFoldersResult> => {
  if (updates.length === 0) return { status: 'saved', revisions: new Map() }
  if (new Set(updates.map(({ id }) => id)).size !== updates.length) return { status: 'conflict' }
  try {
    const db = await open()
    try {
      return await new Promise<SaveTemplateFoldersResult>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite')
        const templates = transaction.objectStore(STORE)
        const current = new Map<string, Record<string, unknown>>()
        let remaining = updates.length
        let conflict = false
        let result: SaveTemplateFoldersResult = { status: 'conflict' }

        const finishReads = (): void => {
          if (remaining !== 0) return
          if (conflict) return
          const revisions = new Map<string, number>()
          for (const update of updates) {
            const record = current.get(update.id)
            if (record === undefined) return
            const revision = update.expectedRevision + 1
            templates.put({
              ...record,
              folderId: update.folderId,
              ...(update.updatedAt === undefined ? {} : { updatedAt: update.updatedAt }),
              revision,
            })
            revisions.set(update.id, revision)
          }
          result = { status: 'saved', revisions }
        }

        for (const update of updates) {
          const request = templates.get(update.id)
          request.onsuccess = () => {
            const record = request.result
            if (
              typeof record !== 'object' ||
              record === null ||
              normaliseRevision((record as { revision?: unknown }).revision) !==
                update.expectedRevision ||
              update.expectedRevision >= Number.MAX_SAFE_INTEGER - 1
            ) {
              conflict = true
            } else {
              current.set(update.id, record as Record<string, unknown>)
            }
            remaining--
            finishReads()
          }
          request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
        }
        transaction.oncomplete = () => resolve(result)
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('indexedDB transaction failed'))
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('indexedDB transaction aborted'))
      })
    } finally {
      db.close()
    }
  } catch (error) {
    warn('install', 'local template storage unavailable', String(error))
    return { status: 'unavailable' }
  }
}

export const deleteTemplate = async (
  id: IDBValidKey,
  expectedRevision: number,
): Promise<SaveResult> =>
  await writeVersioned(
    id,
    expectedRevision,
    (templates, _revision, _current, transaction) => {
      templates.delete(id)
      const cursorRequest = transaction.objectStore(LOCAL_TAG_STORE).openCursor()
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (cursor === null) return
        const tag = cursor.value as { templateIds: string[] }
        if (tag.templateIds.includes(String(id)))
          cursor.update({
            ...tag,
            templateIds: tag.templateIds.filter((templateId) => templateId !== id),
          })
        cursor.continue()
      }
      // Record absence is itself the tombstone: a stale mutation requires an existing record with the
      // expected revision, so deleted IDs need no permanent side-store entry.
    },
    false,
    'delete',
  )

/** A stored record. Its artwork may be missing when a source and recipe can rebuild it. */
export type StoredRecord = Record<string, unknown> & { indices?: Uint8Array | StoredBlob }

const isRebuildable = (record: Record<string, unknown>): boolean =>
  storedAuthoring(record.authoring, record) !== null

const boundedStoredRecord = (value: unknown): value is StoredRecord => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const indices = record.indices
  const storedPixels = isUint8Array(indices)
    ? indices.length
    : isStoredBlob(indices)
      ? indices.size
      : -1
  // Missing or wrong-sized artwork is lost, but a source and recipe can rebuild it on hydration.
  const indexPixels = isRebuildable(record)
    ? Number(record.width) * Number(record.height)
    : storedPixels
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    record.id.length > MAX_TEMPLATE_ID_LENGTH ||
    typeof record.name !== 'string' ||
    record.name.length > MAX_TEMPLATE_NAME_LENGTH ||
    typeof record.source !== 'string' ||
    !['wplace', 'marble', 'image'].includes(record.source) ||
    !Number.isSafeInteger(record.originX) ||
    !Number.isSafeInteger(record.originY) ||
    !Number.isSafeInteger(record.width) ||
    Number(record.width) <= 0 ||
    !Number.isSafeInteger(record.height) ||
    Number(record.height) <= 0 ||
    indexPixels < 0 ||
    !Number.isSafeInteger(record.moved) ||
    Number(record.moved) < 0 ||
    !Number.isSafeInteger(record.opaque) ||
    (Number(record.opaque) <= 0 && !(Number(record.opaque) === 0 && record.native !== undefined)) ||
    Number(record.moved) > Number(record.opaque) ||
    Number(record.opaque) > indexPixels ||
    typeof record.visible !== 'boolean' ||
    typeof record.everPlaced !== 'boolean' ||
    (record.sortOrder !== undefined && !Number.isSafeInteger(record.sortOrder))
  ) {
    return false
  }
  const width = Number(record.width)
  const height = Number(record.height)
  const originX = Number(record.originX)
  const originY = Number(record.originY)
  const rawSurface = record.surface
  const surface =
    rawSurface === undefined
      ? WORLD_TEMPLATE_SURFACE
      : typeof rawSurface === 'object' && rawSurface !== null && 'kind' in rawSurface
        ? templateSurface(
            rawSurface.kind,
            'allianceId' in rawSurface ? rawSurface.allianceId : undefined,
          )
        : null
  if (surface === null) return false
  const bounds = templateSurfaceBounds(surface) ?? {
    minX: 0,
    minY: 0,
    maxX: WORLD_PIXELS,
    maxY: WORLD_PIXELS,
  }
  if (
    originX < bounds.minX ||
    originY < bounds.minY ||
    originX > bounds.maxX - width ||
    originY > bounds.maxY - height ||
    indexPixels !== width * height ||
    (record.source === 'image' && record.everPlaced === false)
  ) {
    return false
  }
  if (
    record.revision !== undefined &&
    (!Number.isSafeInteger(record.revision) ||
      Number(record.revision) < 0 ||
      Number(record.revision) >= Number.MAX_SAFE_INTEGER)
  ) {
    return false
  }
  const appearance = record.appearance
  if (
    typeof appearance === 'object' &&
    appearance !== null &&
    'hiddenColours' in appearance &&
    Array.isArray(appearance.hiddenColours) &&
    appearance.hiddenColours.length > 64
  ) {
    return false
  }
  return true
}

type HydrationResult =
  | {
      readonly status: 'loaded'
      readonly template: unknown
      readonly migrated?: Record<string, unknown>
      /** A record whose lost artwork was rebuilt from its source and recipe. */
      readonly repaired?: Record<string, unknown>
    }
  | { readonly status: 'invalid' }
  | { readonly status: 'unavailable' }

/** A stored record that failed validation, identified well enough to discard it. */
export type TemplateLoadFailure = { readonly revision: number } & (
  | { readonly id: string }
  | { readonly key: IDBValidKey }
)

/** Every stored template: valid records with their pixels still unread, and records to discard. */
export interface TemplateCatalog {
  readonly records: readonly StoredRecord[]
  readonly invalid: readonly TemplateLoadFailure[]
  /** Resolves once a blocked native open has settled and one restore retry may be attempted. */
  readonly retryAfterUnavailable: Promise<void> | null
}

const candidateIndexPixels = (value: unknown): number => {
  if (typeof value !== 'object' || value === null || !('indices' in value)) return 0
  const indices = (value as { readonly indices?: unknown }).indices
  if (isUint8Array(indices)) return indices.length
  if (isStoredBlob(indices)) return indices.size
  return 0
}

const boundedPixelSum = (total: number, pixels: number): number =>
  pixels > Number.MAX_SAFE_INTEGER - total ? Number.MAX_SAFE_INTEGER : total + pixels

const hydrateCandidate = async (candidate: StoredRecord): Promise<HydrationResult> => {
  const finish = (indices: Uint8Array): HydrationResult => {
    if (hasCurrentPalette(candidate)) {
      return {
        status: 'loaded',
        template: { ...candidate, revision: candidate.revision ?? 0, indices },
      }
    }
    const remapped = remapPaletteIndices(indices)
    const migrated = markCurrentPalette({
      ...candidate,
      indices: new Blob([remapped.buffer as ArrayBuffer]),
      appearance: remapStoredAppearance(candidate.appearance),
    })
    return {
      status: 'loaded',
      template: { ...migrated, revision: candidate.revision ?? 0, indices: remapped },
      migrated,
    }
  }
  const pixels = Number(candidate.width) * Number(candidate.height)
  const authoring = storedAuthoring(candidate.authoring, candidate)
  // Artwork with a recipe must still be the artwork that recipe produced. Processed-only records
  // have nothing to check against and load as stored.
  const accept = async (indices: Uint8Array): Promise<HydrationResult> =>
    indices.length === pixels &&
    (authoring === null || (await sha256Hex(indices)) === authoring.artwork)
      ? finish(indices)
      : await rebuildArtwork(candidate, 'invalid')
  const { indices } = candidate
  if (indices === undefined) return await rebuildArtwork(candidate, 'invalid')
  if (isUint8Array(indices)) return await accept(indices)
  // A wrong-sized cache can never be accepted. Rebuild before reading it, so its bytes are never
  // charged against the restore budget, which only counts the expected output size.
  if (indices.size !== pixels) return await rebuildArtwork(candidate, 'invalid')
  try {
    const buffer = await indices.arrayBuffer()
    if (buffer.byteLength !== indices.size) return await rebuildArtwork(candidate, 'invalid')
    return await accept(new Uint8Array(buffer))
  } catch (error) {
    warn('install', `could not read local template ${String(candidate.id)}`, String(error))
    return await rebuildArtwork(candidate, 'unavailable')
  }
}

/**
 * Rebuild lost artwork from the source and recipe stored beside it. The result must hash to the
 * artwork the recipe originally produced. Otherwise the record stays, unloaded, so its source is
 * never discarded and no other pixels are shown in its place.
 */
const rebuildArtwork = async (
  candidate: Record<string, unknown>,
  failure: 'invalid' | 'unavailable',
): Promise<HydrationResult> => {
  const authoring = storedAuthoring(candidate.authoring, candidate)
  if (authoring === null) return { status: failure }
  try {
    const { indices } = await processRecipe(authoring.source, authoring.recipe, {
      originX: Number(candidate.originX),
      originY: Number(candidate.originY),
    })
    if ((await sha256Hex(indices)) !== authoring.artwork)
      throw new Error('rebuilt artwork differs from the artwork its recipe produced')
    return {
      status: 'loaded',
      template: { ...candidate, revision: candidate.revision ?? 0, indices },
      repaired: markCurrentPalette({ ...candidate, indices: new Blob([indices.slice().buffer]) }),
    }
  } catch (error) {
    warn('install', `could not rebuild local template ${String(candidate.id)}`, String(error))
    return { status: 'unavailable' }
  }
}

/** Write rebuilt artwork back, unless the record changed while it was being rebuilt. */
const persistRepairedArtwork = async (
  candidate: Record<string, unknown>,
  repaired: Record<string, unknown>,
): Promise<void> => {
  const id = candidate.id
  if (typeof id !== 'string') return
  await writeVersioned(id, storedRevision(candidate), (templates) => templates.put(repaired), false)
}

const persistLoadedPaletteMigration = async (
  candidate: Record<string, unknown>,
  migrated: Record<string, unknown>,
): Promise<void> => {
  const id = candidate.id
  if (typeof id !== 'string') return
  await writeVersioned(
    id,
    storedRevision(candidate),
    (templates, _revision, current) => {
      if (typeof current !== 'object' || current === null || hasCurrentPalette(current)) return
      templates.put(migrated)
    },
    false,
  )
}

export type LoadTemplateResult =
  | { readonly status: 'loaded'; readonly template: unknown }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly revision: number }
  | { readonly status: 'unavailable' }

const storedRevision = (value: unknown): number => {
  if (typeof value !== 'object' || value === null || !('revision' in value)) return 0
  return normaliseRevision((value as { readonly revision?: unknown }).revision)
}

const loadFailureIdentity = (
  value: unknown,
  primaryKey: IDBValidKey | undefined,
):
  | { readonly id: string; readonly revision: number }
  | {
      readonly key: IDBValidKey
      readonly revision: number
    }
  | null => {
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const id = (value as { readonly id?: unknown }).id
    if (typeof id === 'string' && id.length > 0 && id.length <= MAX_TEMPLATE_ID_LENGTH) {
      return { id, revision: storedRevision(value) }
    }
  }
  return primaryKey === undefined ? null : { key: primaryKey, revision: storedRevision(value) }
}

/** Read one winning CAS value after a conflict without materialising every other template. */
export const loadTemplate = async (
  id: string,
  maxIndexPixels = 64 * 1024 * 1024,
): Promise<LoadTemplateResult> => {
  try {
    const db = await open()
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readonly')
        const request = transaction.objectStore(STORE).get(id)
        let result: unknown
        request.onsuccess = () => {
          result = request.result
        }
        request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
        transaction.oncomplete = () => resolve(result)
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('indexedDB transaction failed'))
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('indexedDB transaction aborted'))
      })
      if (value === undefined) return { status: 'missing' }
      if (!boundedStoredRecord(value)) {
        return { status: 'invalid', revision: storedRevision(value) }
      }
      return await hydrateStoredTemplate(value, maxIndexPixels)
    } finally {
      db.close()
    }
  } catch (error) {
    warn('install', 'local template storage unavailable', String(error))
    return { status: 'unavailable' }
  }
}

/**
 * Read one catalog record's pixels: validated against its recipe, rebuilt when lost, and migrated
 * to the current palette, with any repair written back.
 */
export const hydrateStoredTemplate = async (
  record: StoredRecord,
  maxIndexPixels = 64 * 1024 * 1024,
): Promise<LoadTemplateResult> => {
  if (Number(record.width) * Number(record.height) > maxIndexPixels) {
    return { status: 'invalid', revision: storedRevision(record) }
  }
  const hydrated = await hydrateCandidate(record)
  if (hydrated.status === 'invalid') return { status: 'invalid', revision: storedRevision(record) }
  if (hydrated.status === 'loaded' && hydrated.migrated !== undefined) {
    void persistLoadedPaletteMigration(record, hydrated.migrated)
  }
  if (hydrated.status === 'loaded' && hydrated.repaired !== undefined) {
    void persistRepairedArtwork(record, hydrated.repaired)
  }
  return hydrated
}

const TILE_KEY = /^\d{1,5}\/\d{1,5}$/

/**
 * The painted tiles a record carries, or null when restore has to read its pixels: records from
 * before tiles were stored, on an older palette, or whose artwork must be rebuilt.
 */
export const catalogTileKeys = (record: StoredRecord): readonly string[] | null => {
  const { tileKeys, indices } = record
  const width = Number(record.width)
  const height = Number(record.height)
  const maxTiles = (Math.ceil(width / TILE_SIZE) + 1) * (Math.ceil(height / TILE_SIZE) + 1)
  if (
    !hasCurrentPalette(record) ||
    !isStoredBlob(indices) ||
    indices.size !== width * height ||
    !Array.isArray(tileKeys) ||
    tileKeys.length > maxTiles ||
    !tileKeys.every((key) => typeof key === 'string' && TILE_KEY.test(key))
  )
    return null
  return tileKeys
}

/**
 * Record the painted tiles a restore had to count from pixels, so the next one need not.
 *
 * Skipped when the record changed since it was read: whoever changed it wrote its own tiles.
 */
export const saveTemplateTileKeys = async (
  id: string,
  revision: number,
  tileKeys: readonly string[],
): Promise<void> => {
  await writeVersioned(
    id,
    revision,
    (templates, _revision, current) => {
      if (typeof current !== 'object' || current === null) return
      templates.put({ ...current, tileKeys })
    },
    false,
  )
}

/** Every stored template's id, for walking the store one record at a time. */
export const loadTemplateIds = async (): Promise<readonly string[]> => {
  try {
    const db = await open()
    try {
      return await new Promise<readonly string[]>((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys()
        request.onsuccess = () =>
          resolve(request.result.filter((key): key is string => typeof key === 'string'))
        request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
      })
    } finally {
      db.close()
    }
  } catch (error) {
    warn('install', 'local template storage unavailable', String(error))
    return []
  }
}

/**
 * Every stored template, without reading any pixels.
 *
 * Valid records come back raw with their artwork still a Blob, so the whole catalog costs only its
 * metadata. Pixels load per record through {@link hydrateStoredTemplate}. Records at a revision in
 * `excludedRevisions` were already handled by this restore and are skipped.
 */
export const loadTemplateCatalog = async (
  excludedRevisions: ReadonlyMap<string, number> = new Map(),
): Promise<TemplateCatalog> => {
  try {
    const db = await open()
    try {
      return await new Promise<TemplateCatalog>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readonly')
        const request = transaction.objectStore(STORE).openCursor()
        const records: StoredRecord[] = []
        const invalid: TemplateLoadFailure[] = []
        request.onsuccess = () => {
          const cursor = request.result
          if (cursor === null) return
          const value: unknown = cursor.value
          if (boundedStoredRecord(value)) {
            if (excludedRevisions.get(value.id as string) !== storedRevision(value))
              records.push(value)
          } else {
            const identity = loadFailureIdentity(value, cursor.primaryKey)
            if (
              identity !== null &&
              !('id' in identity && excludedRevisions.get(identity.id) === identity.revision)
            )
              invalid.push(identity)
          }
          cursor.continue()
        }
        request.onerror = () => reject(request.error ?? new Error('indexedDB cursor failed'))
        transaction.oncomplete = () => resolve({ records, invalid, retryAfterUnavailable: null })
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('indexedDB transaction failed'))
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('indexedDB transaction aborted'))
      })
    } finally {
      db.close()
    }
  } catch (error) {
    warn('install', 'local template storage unavailable', String(error))
    return { records: [], invalid: [], retryAfterUnavailable: blockedOpenRecovery }
  }
}
