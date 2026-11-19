import {
  sameTemplateSurface,
  type TemplateSurface,
  TRANSPARENT_INDEX,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { log, warn } from '../debug.js'
import { leaseLocalFolder } from '../local-folders.js'
import { getState, setScopeVisible, setServerTemplatePreference } from '../settings.js'
import { type Appearance, type AppearanceGroup, isValidAppearance } from './appearance.js'
import type { TemplateAuthoring } from './authoring.js'
import {
  appearanceOf,
  clearLocalPreview,
  forgetPreview,
  isCurrentTemplate,
  isDeletingLocal,
  isIdTaken,
  isPendingImage,
  isServerTemplate,
  markDeleting,
  notifyLocalChange,
  type PlacedTemplate,
  previewOriginFor,
  reserveId,
  templateById,
  writeInOrder,
  writeManyInOrder,
} from './catalog.js'
import type { ImportedTemplate } from './import.js'
import { type SaveResult, saveTemplateFolders } from './persist.js'
// Edits a person makes, mirrored to their Wplace templates when linked.
import { deleteTemplate, saveTemplate } from './personal-store.js'
import { paintedTileKeys, validatePlacement } from './placement.js'
import {
  dropPixels,
  holdPendingPixels,
  installEntry,
  makeRoom,
  newArtwork,
  removeEntry,
  residentArea,
  templateChunks,
  touchTemplate,
} from './residency.js'
import { noteSnapshot, reconcileConflict, restoreRunning } from './restore.js'
import { cutPixels, joinPixels, storedArea } from './sparse-pixels.js'
import {
  MAX_TEMPLATE_ID_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
  type TemplateRecord,
} from './template-record.js'

/**
 * Every change a person makes to a template: adding, copying, moving, renaming, filing, showing,
 * restyling, replacing its artwork and deleting it.
 *
 * Each edit runs in its template's write order, saves through a compare-and-swap, and takes the
 * stored winner when it loses one. Server copies accept only their per-browser switches.
 */

/** Save an entry where it belongs: IndexedDB for Local ones, this browser's preference for copies. */
const savePlaced = async (
  placed: PlacedTemplate,
  expectedRevision: number | null = placed.revision,
): Promise<SaveResult> => {
  if (isServerTemplate(placed)) {
    return setServerTemplatePreference(placed.id, placed.appearance, placed.owns)
      ? { status: 'saved', revision: placed.revision }
      : { status: 'limit' }
  }
  // A metadata change on a stored record keeps its pixels, so it never needs them in memory.
  const { tiles, artwork, ...rest } = placed
  return noteSnapshot(
    artwork,
    await saveTemplate(
      {
        ...rest,
        tileKeys: [...tiles],
        pixels: expectedRevision === null ? artwork.pixels : null,
      },
      expectedRevision,
    ),
    expectedRevision === null,
  )
}

/** Save a new entry. A new record has nothing stored yet, so its pixels must be in memory. */
const persist = async (placed: PlacedTemplate): Promise<SaveResult> => {
  if (isServerTemplate(placed)) return await savePlaced(placed)
  if (placed.artwork.pixels === null) {
    throw new RangeError('a new template has no pixels in memory')
  }
  return await writeInOrder(placed.id, () => savePlaced(placed, null))
}

const committedRevision = (result: SaveResult): number | null =>
  result.status === 'saved' ? result.revision : null

/**
 * Admit an import, optionally committing an existing placement in the same initial write, or
 * staging it for upload to a server.
 */
export const addLocalTemplate = async (
  template: ImportedTemplate,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
  everPlaced = false,
  staged = false,
): Promise<PlacedTemplate> => {
  const restoring = restoreRunning()
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
  if (isIdTaken(template.id)) {
    throw new RangeError('local template id already exists')
  }
  const { indices, ...metadata } = template
  const pixels = cutPixels(template.width, template.height, indices)
  const area = storedArea(pixels)
  // A new template is being placed, so it needs its pixels in memory.
  if (!makeRoom(area)) {
    throw new RangeError('templates in memory exceed the pixel budget')
  }
  touchTemplate(template.id)
  const releaseId = reserveId(template.id)
  const releasePixels = holdPendingPixels(area)
  try {
    const tiles = await paintedTileKeys(scoped, pixels)
    const placed: PlacedTemplate = {
      ...metadata,
      artwork: newArtwork(pixels),
      updatedAt: Date.now(),
      surface,
      tiles,
      visible: true,
      everPlaced,
      ...(staged ? { staged: true } : {}),
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
    installEntry(admitted)
    log('install', `placed ${template.name}`, { tiles: tiles.size })
    notifyLocalChange()
    return admitted
  } finally {
    releaseId()
    releasePixels()
  }
}

/** Durable Local placement does not carry the server-only antimeridian representation. */
export const canCopyAsLocalTemplate = (template: PlacedTemplate): boolean =>
  template.wrapX !== true || template.originX + template.width <= WORLD_PIXELS

/**
 * Make a durable local copy without carrying any server-owned identity fields across the boundary.
 *
 * Picking the imported fields explicitly makes a server identity unrepresentable in the copy. An
 * image import is normally pending until its first placement; this copy already has a position, so
 * marking that placement immediately is also what commits it to IndexedDB before its source can be
 * removed. A server source transfers its immutable indices to the Local identity after that commit,
 * so a move at the aggregate pixel budget does not need to retain the same artwork twice.
 */
export const copyAsLocalTemplate = async (
  template: PlacedTemplate,
  id: string,
  /** Server templates keep theirs on the server, so the caller fetches it. */
  authoring: TemplateAuthoring | null = template.authoring ?? null,
): Promise<PlacedTemplate> => {
  if (!canCopyAsLocalTemplate(template)) {
    throw new RangeError('wrapped server templates cannot be copied into Local')
  }
  const restoring = restoreRunning()
  if (restoring !== null) await restoring
  const pixels = await templateChunks(template)
  const imported: TemplateRecord = {
    id,
    name: template.name,
    source: 'image',
    ...(template.sortOrder === undefined ? {} : { sortOrder: template.sortOrder }),
    originX: template.originX,
    originY: template.originY,
    width: template.width,
    height: template.height,
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
      isIdTaken(id)
    ) {
      throw new RangeError('local template metadata or id is unavailable')
    }
    const source = templateById(template.id)
    if (source !== template) throw new Error('server template changed while it was being copied')
    // The copy takes over the source's pixels, so only pixels the source did not hold need room.
    const area = storedArea(pixels)
    if (!makeRoom(area - residentArea(source), template.id)) {
      throw new RangeError('templates in memory exceed the pixel budget')
    }

    const releaseId = reserveId(id)
    try {
      const tiles = await paintedTileKeys({ ...imported, surface }, pixels)
      const placed: PlacedTemplate = {
        ...imported,
        artwork: newArtwork(pixels),
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
      if (templateById(template.id) !== source) {
        await deleteTemplate(id, saved.revision)
        throw new Error('server template changed while it was being copied')
      }

      const copied = { ...placed, revision: saved.revision }
      removeEntry(source)
      installEntry(copied)
      notifyLocalChange()
      return copied
    } finally {
      releaseId()
    }
  }

  const copied = await addLocalTemplate(
    { ...imported, indices: joinPixels(pixels) },
    template.surface ?? WORLD_TEMPLATE_SURFACE,
  )
  if (await markPlaced(copied.id)) {
    return templateById(copied.id) ?? copied
  }
  await removeLocalTemplate(copied.id)
  throw new Error('local template copy could not be saved')
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
    const existing = templateById(id)
    if (existing === undefined) {
      resolveMove(target, false)
      continue
    }
    try {
      let tiles = await paintedTileKeys(
        { ...existing, originX: target.originX, originY: target.originY },
        await templateChunks(existing),
      )
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
      const current = templateById(id)
      if (current === undefined || isDeletingLocal(id)) {
        resolveMove(target, false)
        continue
      }
      const saved = await commitEdit(
        id,
        null,
        async (latest) => {
          validatePlacement(latest, target.originX, target.originY)
          const sourceChanged =
            latest.artwork !== existing.artwork ||
            latest.width !== existing.width ||
            latest.height !== existing.height
          if (sourceChanged) {
            tiles = await paintedTileKeys(
              { ...latest, originX: target.originX, originY: target.originY },
              await templateChunks(latest),
            )
          }
          return {
            ...latest,
            updatedAt: Date.now(),
            originX: target.originX,
            originY: target.originY,
            everPlaced: latest.everPlaced || target.everPlaced,
            tiles,
          }
        },
        () => {
          forgetPreview(id)
          return true
        },
      )
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

/** What an edit makes of the current entry: the next one, `'unchanged'`, or null to refuse. */
type Edit = (
  current: PlacedTemplate,
) => PlacedTemplate | 'unchanged' | null | Promise<PlacedTemplate | 'unchanged' | null>

/**
 * Apply one edit to a template in its write order: build the next entry from the current one, save
 * it, reconcile a lost compare-and-swap, and publish the result.
 *
 * A pending image lives only in memory until an edit places it, which saves it as a new record.
 * `label` names the edit in the warning a failed save logs; null logs nothing. `beforePublish`
 * runs once the save committed and may still refuse.
 */
const commitEdit = (
  id: string,
  label: string | null,
  edit: Edit,
  beforePublish?: (next: PlacedTemplate) => boolean,
): Promise<boolean> =>
  writeInOrder(id, async () => {
    const existing = templateById(id)
    if (existing === undefined || isDeletingLocal(id)) return false
    const next = await edit(existing)
    if (next === null) return false
    if (next === 'unchanged') return true
    let revision = existing.revision
    const pending = isPendingImage(existing)
    if (!pending || !isPendingImage(next)) {
      const result = await savePlaced(next, pending ? null : existing.revision)
      const committed = committedRevision(result)
      if (committed === null) {
        if (result.status === 'conflict') await reconcileConflict(id)
        if (label !== null) warn('install', `${label} for ${next.name} was not saved`)
        return false
      }
      revision = committed
    }
    if (beforePublish !== undefined && !beforePublish(next)) {
      if (label !== null) warn('install', `${label} for ${next.name} was not saved`)
      return false
    }
    installEntry({ ...next, revision })
    notifyLocalChange()
    return true
  })

export const markPlaced = async (id: string): Promise<boolean> =>
  await commitEdit(id, 'placement', (existing) => ({
    ...existing,
    everPlaced: true,
    updatedAt: Date.now(),
  }))

/** Keep a staged template that did not upload as an ordinary Local one. */
export const unstageLocalTemplate = async (id: string): Promise<void> =>
  await writeInOrder(id, async () => {
    const existing = templateById(id)
    if (existing?.staged === undefined) return
    const { staged: _staged, ...kept } = existing
    installEntry(kept)
    notifyLocalChange()
  })

/** Persist the final origin and first-placement marker in one durable state transition. */
export const placeLocalTemplate = async (
  id: string,
  originX: number,
  originY: number,
): Promise<boolean> => {
  const existing = templateById(id)
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
    return await commitEdit(id, 'folder change', (existing) => {
      if (folderId !== null) {
        const folder = getState().localFolders.find((candidate) => candidate.id === folderId)
        if (
          folder === undefined ||
          !sameTemplateSurface(
            existing.surface ?? WORLD_TEMPLATE_SURFACE,
            folder.surface ?? WORLD_TEMPLATE_SURFACE,
          )
        ) {
          return null
        }
      }
      if (existing.folderId === folderId) return 'unchanged'
      return { ...existing, folderId, updatedAt: Date.now() }
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
      const present: PlacedTemplate[] = []
      for (const id of unique) {
        const template = templateById(id)
        if (template === undefined || isDeletingLocal(id)) return false
        present.push(template)
      }
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
        installEntry({
          ...template,
          folderId,
          updatedAt,
          revision: result.revisions.get(template.id) ?? template.revision,
        })
      }
      notifyLocalChange()
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
        isDeletingLocal(expected.id) ||
        previewOriginFor(expected.id) !== null
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
      opaque: indices.reduce((count, index) => count + Number(index !== TRANSPARENT_INDEX), 0),
      moved: 0,
      updatedAt: Date.now(),
    }
    const pixels = cutPixels(next.width, next.height, indices)
    const tiles = await paintedTileKeys(next, pixels)
    checkCurrent()
    const result = await saveTemplate(
      { ...next, pixels, tileKeys: [...tiles] },
      expected.revision,
      true,
    )
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
    dropPixels(expected)
    const area = storedArea(pixels)
    const resident = makeRoom(area, expected.id)
    const artwork = newArtwork(resident ? pixels : null, area)
    noteSnapshot(artwork, result, true)
    installEntry({ ...next, artwork, tiles, revision: result.revision })
    notifyLocalChange()
  })
}

export const renameLocalTemplate = async (id: string, name: string): Promise<boolean> => {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > MAX_TEMPLATE_NAME_LENGTH) return false
  return await commitEdit(id, 'rename', (existing) =>
    trimmed === existing.name ? 'unchanged' : { ...existing, name: trimmed, updatedAt: Date.now() },
  )
}

const deletionLeases = new Map<string, number>()

/** Keep a browser-owned template from being deleted while another copy is still being committed. */
export const leaseLocalTemplate = (id: string): (() => void) | null => {
  const template = templateById(id)
  if (template === undefined || isServerTemplate(template) || isDeletingLocal(id)) return null
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

/** Whether a lease from `leaseLocalTemplate` is keeping `id` from being deleted. */
export const isLeasedLocal = (id: string): boolean => (deletionLeases.get(id) ?? 0) > 0

/** In-flight deletions, so a second caller joins the first rather than being told it failed. */
const deletions = new Map<string, Promise<boolean>>()

export const removeLocalTemplate = async (id: string): Promise<boolean> => {
  // A second surface asking for the same deletion is not a failure: join the one already running.
  const running = deletions.get(id)
  if (running !== undefined) return await running
  const existing = templateById(id)
  // Already gone — by this id's own earlier deletion, most likely — which is the outcome asked for.
  if (existing === undefined) return true
  // Server rows are owned by their remote source. `forgetServerTemplate` is the sync lifecycle;
  // Local deletion must never make one disappear temporarily and then reappear on the next poll.
  if (isServerTemplate(existing)) return false
  if (isDeletingLocal(id)) return false
  if (isLeasedLocal(id)) return false
  // Terminal immediately: in-flight scans and newly requested mutations must not queue a save
  // behind this delete and resurrect the record.
  const releaseDeleting = markDeleting(id)
  const settled = (async (): Promise<boolean> => {
    // Other surfaces render from the guard (an open overlay menu locks its controls on it), so it is
    // announced now rather than once the record is gone.
    notifyLocalChange()
    let removed = false
    try {
      removed = await writeInOrder(id, async () => {
        const current = templateById(id)
        if (current === undefined) return true
        if (!isPendingImage(current)) {
          const deleted = await deleteTemplate(id, current.revision)
          if (deleted.status !== 'saved') {
            if (deleted.status === 'conflict') {
              await reconcileConflict(id)
              return templateById(id) === undefined
            }
            return false
          }
        }
        removeEntry(current)
        notifyLocalChange()
        return true
      })
    } finally {
      releaseDeleting()
      // Lifting the guard is a state change too: surfaces that locked on it must hear it lift.
      if (!removed) notifyLocalChange()
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

export const setLocalVisible = async (id: string, visible: boolean): Promise<boolean> =>
  await commitEdit(
    id,
    'visibility',
    (existing) => (existing.visible === visible ? 'unchanged' : { ...existing, visible }),
    // A server row's visibility is a scope switch, not part of its stored preference.
    (next) => !isServerTemplate(next) || setScopeVisible(id, visible),
  )

const mutateAppearance = async (
  id: string,
  mutate: (current: Appearance) => Appearance | null,
): Promise<boolean> =>
  await commitEdit(id, 'appearance', (existing) => {
    const ownedAppearance = mutate(appearanceOf(existing))
    if (ownedAppearance !== null && !isValidAppearance(ownedAppearance)) return null
    return { ...existing, appearance: ownedAppearance }
  })

/**
 * Change how one overlay draws; null puts it back on the global defaults. Appearance never affects
 * its painted tile keys.
 */
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
 * moves at the moment of the switch — the overlay looks identical and only stops following.
 */
export const setOwnsGroup = async (
  id: string,
  group: AppearanceGroup,
  owns: boolean,
): Promise<boolean> =>
  await commitEdit(id, 'appearance ownership', (existing) =>
    existing.owns.includes(group) === owns
      ? 'unchanged'
      : {
          ...existing,
          appearance: owns ? appearanceOf(existing) : existing.appearance,
          owns: owns ? [...existing.owns, group] : existing.owns.filter((one) => one !== group),
        },
  )
