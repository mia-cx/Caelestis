import { sameTemplateSurface, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { log, warn } from '../debug.js'
import { getState } from '../settings.js'
import { APPEARANCE_GROUPS } from './appearance.js'
import {
  catalogEntries,
  forgetPreview,
  isIdTaken,
  isPendingImage,
  type LocalTemplate,
  notifyLocalChange,
  type PlacedTemplate,
  type TemplateArtwork,
  templateById,
  writeInOrder,
} from './catalog.js'
import { sameRender } from './native-store.js'
import {
  catalogStoredArea,
  catalogTileKeys,
  // Raw record removal, for records found invalid: no Wplace mirror is told.
  deleteTemplate as discardStoredRecord,
  hydrateStoredTemplate,
  loadTemplateCatalog,
  type SaveResult,
  type StoredRecord,
  saveTemplateFolders,
  saveTemplateTileKeys,
} from './persist.js'
import { loadTemplate, loadTemplateMetadata } from './personal-store.js'
import { paintedTileKeys } from './placement.js'
import {
  dropPixels,
  fillResidentSet,
  fitsResident,
  installEntry,
  MAX_RESIDENT_PIXELS,
  makeRoom,
  newArtwork,
  registerPixelLoader,
  removeEntry,
} from './residency.js'
import { type SparsePixels, storedArea } from './sparse-pixels.js'
import {
  type LocalRecord,
  parseStoredMetadata,
  parseStoredTemplate,
  storedRevision,
  storedTemplateOrNull,
} from './template-record.js'

/**
 * Keeps the catalog's Local templates agreeing with IndexedDB: restores them at startup, reloads
 * evicted pixels, and takes the stored winner after another tab or Wplace won a compare-and-swap.
 */

const MAX_RESTORE_PASSES = 4
let restoreInFlight: Promise<void> | null = null
let scheduledRestoreRecovery: Promise<void> | null = null
let reconciliationTail: Promise<void> = Promise.resolve()
const reconciliationObservers = new Map<string, Set<() => void>>()

/** The restore now running, for adds that must not race it; null when none is. */
export const restoreRunning = (): Promise<void> | null => restoreInFlight

/** Hear when one template's entry is replaced by the stored winner. Returns the unsubscribe. */
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
      warn('local reconciliation observer failed', String(error))
    }
  }
}

/**
 * The Wplace snapshot token each personal artwork is a rendering of, so a reconciliation can tell
 * a metadata change from new artwork without reading pixels.
 */
const artworkSnapshots = new WeakMap<TemplateArtwork, string>()

/**
 * Remember the snapshot a save linked this artwork to.
 *
 * A save that wrote these pixels links them outright. A metadata save never looked at them, so
 * it only carries a snapshot the artwork already had forward, and drops it if the two render
 * differently.
 */
export const noteSnapshot = (
  artwork: TemplateArtwork,
  result: SaveResult,
  wrotePixels: boolean,
): SaveResult => {
  const token = result.status === 'saved' ? result.native?.token : undefined
  if (token === undefined) return result
  const known = artworkSnapshots.get(artwork)
  if (wrotePixels) artworkSnapshots.set(artwork, token)
  else if (known !== undefined) {
    let same = false
    // A malformed token renders like nothing else.
    try {
      same = sameRender(known, token)
    } catch {}
    if (same) artworkSnapshots.set(artwork, token)
    else artworkSnapshots.delete(artwork)
  }
  return result
}

/** A catalog entry for a stored record. The caller accounts for any pixels it installs. */
const placedFromStored = (
  stored: LocalRecord,
  tiles: ReadonlySet<string>,
  artwork: TemplateArtwork,
): LocalTemplate => {
  if (stored.native?.token !== undefined) artworkSnapshots.set(artwork, stored.native.token)
  return {
    ...stored,
    artwork,
    surface: stored.surface ?? WORLD_TEMPLATE_SURFACE,
    appearance: stored.appearance ?? null,
    owns: stored.owns ?? (stored.appearance != null ? APPEARANCE_GROUPS : []),
    folderId: stored.folderId ?? null,
    visible: stored.visible,
    tiles,
  }
}

const removeStaleLocalState = (existing: PlacedTemplate): void => {
  removeEntry(existing)
  noteReconciliation(existing.id)
  notifyLocalChange()
}

/**
 * The painted tiles of a winner whose artwork is still `existing`'s, or null when it may differ.
 *
 * Personal artwork is a rendering of its Wplace snapshot, so snapshots that render the same hold
 * the same pixels. A winner that moved needs its tiles recounted, from pixels still in memory.
 */
const unchangedArtworkTiles = async (
  existing: PlacedTemplate,
  winner: LocalRecord,
): Promise<ReadonlySet<string> | null> => {
  const before = artworkSnapshots.get(existing.artwork)
  const after = winner.native?.token
  if (
    before === undefined ||
    after === undefined ||
    winner.width !== existing.width ||
    winner.height !== existing.height ||
    winner.opaque !== existing.opaque
  )
    return null
  try {
    if (!sameRender(before, after)) return null
    if (
      winner.originX === existing.originX &&
      winner.originY === existing.originY &&
      sameTemplateSurface(winner.surface ?? WORLD_TEMPLATE_SURFACE, existing.surface)
    )
      return existing.tiles
    const pixels = existing.artwork.pixels
    return pixels === null ? null : await paintedTileKeys(winner, pixels)
  } catch {
    return null
  }
}

/**
 * Replace stale process-local state with the durable winner after an IndexedDB CAS conflict.
 *
 * The winner is read without its pixels first, so a metadata change keeps this tab's artwork.
 * `verifyPixels` reads them at once, for a caller whose pixel load just failed.
 */
const reconcileConflictExclusive = async (id: string, verifyPixels: boolean): Promise<void> => {
  const MAX_RECONCILIATION_ATTEMPTS = 4
  for (let attempt = 0; attempt < MAX_RECONCILIATION_ATTEMPTS; attempt++) {
    const existing = templateById(id)
    if (existing === undefined) return
    const loaded = verifyPixels
      ? await loadTemplate(id, MAX_RESIDENT_PIXELS)
      : await loadTemplateMetadata(id)
    if (loaded.status === 'unavailable') return
    if (loaded.status === 'missing') {
      removeStaleLocalState(existing)
      return
    }
    if (loaded.status === 'invalid') {
      const deleted = await discardStoredRecord(id, loaded.revision)
      if (deleted.status === 'saved') {
        removeStaleLocalState(existing)
        return
      }
      if (deleted.status === 'conflict') continue
      warn(`could not remove invalid conflict winner for ${existing.name}`)
      return
    }
    let winner: LocalRecord & { readonly pixels: SparsePixels | null }
    try {
      winner = verifyPixels
        ? parseStoredTemplate(loaded.template)
        : { ...parseStoredMetadata(loaded.template), pixels: null }
      if (winner.id !== id || (winner.source === 'image' && !winner.everPlaced)) {
        throw new RangeError('winning template state is invalid')
      }
    } catch (error) {
      const deleted = await discardStoredRecord(id, storedRevision(loaded.template))
      if (deleted.status === 'saved') {
        removeStaleLocalState(existing)
        return
      }
      if (deleted.status === 'conflict') continue
      warn(`could not remove invalid conflict winner for ${existing.name}`, String(error))
      return
    }
    // Unchanged on disk: keep this artwork, so progress and textures keyed on it survive.
    if (winner.revision === existing.revision) return
    // Split the pixels off, so the catalog entry holds them only through its artwork.
    const { pixels, ...metadata } = winner
    if (pixels === null) {
      const kept = await unchangedArtworkTiles(existing, metadata)
      if (kept === null) {
        verifyPixels = true
        continue
      }
      if (templateById(id) !== existing) continue
      forgetPreview(id)
      installEntry(placedFromStored(metadata, kept, existing.artwork))
      noteReconciliation(id)
      notifyLocalChange()
      return
    }
    let tiles: ReadonlySet<string>
    try {
      tiles = await paintedTileKeys(metadata, pixels)
    } catch (error) {
      const deleted = await discardStoredRecord(id, winner.revision)
      if (deleted.status === 'saved') {
        removeStaleLocalState(existing)
        return
      }
      if (deleted.status === 'conflict') continue
      warn(`could not remove invalid conflict winner for ${existing.name}`, String(error))
      return
    }
    if (templateById(id) !== existing) continue
    forgetPreview(id)
    // The winner stays in memory only where the stale copy was, or where it fits for free.
    const wasResident = existing.artwork.pixels !== null
    dropPixels(existing)
    const area = storedArea(pixels)
    const resident = wasResident ? makeRoom(area, id) : fitsResident(area)
    installEntry(placedFromStored(metadata, tiles, newArtwork(resident ? pixels : null, area)))
    noteReconciliation(id)
    notifyLocalChange()
    return
  }
  warn(`could not reconcile ${id}: conflict retry limit reached`)
}

/** Take the stored winner for one template, one reconciliation at a time. */
export const reconcileConflict = async (id: string, verifyPixels = false): Promise<void> => {
  const running = reconciliationTail.then(
    async () => await reconcileConflictExclusive(id, verifyPixels),
    async () => await reconcileConflictExclusive(id, verifyPixels),
  )
  reconciliationTail = running.then(
    () => undefined,
    () => undefined,
  )
  await running
}

/** Read a Local template's evicted pixels back from IndexedDB. */
const loadLocalPixels = async (template: LocalTemplate): Promise<SparsePixels> => {
  const loaded = await loadTemplate(template.id, MAX_RESIDENT_PIXELS)
  if (loaded.status === 'unavailable') {
    throw new Error('Could not read this template from browser storage. Try again.')
  }
  const current = templateById(template.id)
  const stored = loaded.status === 'loaded' ? storedTemplateOrNull(loaded.template) : null
  if (stored !== null && current?.artwork === template.artwork) {
    if (stored.revision === current.revision) return stored.pixels
  }
  // Disk no longer holds what this tab shows: another tab or Wplace changed it. Take the winner.
  await reconcileConflict(template.id, true)
  throw new Error('That template changed while it was loading. Try again.')
}
registerPixelLoader('local', loadLocalPixels)

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
  warn(`discarded invalid local template ${String(key)}`, String(error ?? 'invalid'))
  const deleted = await discardStoredRecord(key, revision)
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
  const present = templateById(id)
  if (present?.origin === 'local') return 'skipped'
  const tileKeys = catalogTileKeys(record)
  let source: unknown = record
  let pixels: SparsePixels | null = null
  if (tileKeys === null) {
    const loaded = await hydrateStoredTemplate(record, MAX_RESIDENT_PIXELS)
    // Unreadable now is environmental, and must never destroy data.
    if (loaded.status === 'unavailable') {
      warn(`could not read local template ${id}`)
      return 'skipped'
    }
    const stored = loaded.status === 'loaded' ? storedTemplateOrNull(loaded.template) : null
    if (stored === null) return await discardRecord(id, recordRevision, seen)
    const { pixels: storedPixels, ...metadata } = stored
    source = metadata
    pixels = storedPixels
  }
  let template: LocalRecord
  try {
    // Earlier builds could persist 0x0, non-finite, out-of-world, or fully transparent records.
    // Validate each independently so one bad legacy entry cannot prevent every good restore.
    template = parseStoredMetadata(source)
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
      warn(`could not durably repair missing folder for ${template.name}`)
    }
    template = { ...template, folderId: null, revision }
    seen.set(id, revision)
  }
  let tiles: ReadonlySet<string> = new Set(tileKeys ?? [])
  if (pixels !== null) {
    try {
      tiles = await paintedTileKeys(template, pixels)
    } catch (error) {
      return await discardRecord(id, template.revision, seen, error)
    }
    void saveTemplateTileKeys(id, template.revision, [...tiles])
  }
  if (isIdTaken(id)) {
    warn(`could not restore ${template.name}: local template id already exists`)
    return 'skipped'
  }
  if (pixels === null) {
    installEntry(placedFromStored(template, tiles, newArtwork(null, catalogStoredArea(record))))
    return 'restored'
  }
  const area = storedArea(pixels)
  const resident = fitsResident(area)
  installEntry(placedFromStored(template, tiles, newArtwork(resident ? pixels : null, area)))
  return 'restored'
}

/**
 * Rebuild the catalog on startup from every stored record, reading pixels only where needed.
 *
 * Templates join evicted; `fillResidentSet` then loads what fits, visible ones first.
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
  if (restored > 0) log(`restored ${restored} local templates`)
  notifyLocalChange()
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

/**
 * Apply native projections through the same serialized reconciliation used by local edit conflicts.
 *
 * One catalog read finds the records whose revision moved; the rest are current already.
 */
export const refreshPersonalTemplates = async (): Promise<void> => {
  if (restoreInFlight !== null) await restoreInFlight
  const { records } = await loadTemplateCatalog()
  const revisions = new Map(
    records.map((record) => [
      record.id as string,
      Number.isSafeInteger(record.revision) ? Number(record.revision) : 0,
    ]),
  )
  for (const template of [...catalogEntries()]) {
    if (template.origin !== 'local' || isPendingImage(template)) continue
    if (template.surface.kind !== 'world') continue
    if (revisions.get(template.id) === template.revision) continue
    await writeInOrder(template.id, async () => await reconcileConflict(template.id))
  }
  await restoreLocalTemplates()
}
