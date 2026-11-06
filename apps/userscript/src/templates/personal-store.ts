import { WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { warn } from '../debug.js'
import { getSurfaceAppearance } from '../state.js'
import { APPEARANCE_GROUPS } from './appearance.js'
import {
  NativeConflict,
  type NativeSnapshot,
  type NativeTemplates,
  nativeImage,
  nativeLocalId,
  nativeMetadata,
  nativePlacement,
  sameRender,
} from './native-store.js'
import type { SaveResult, TemplateSave } from './persist.js'
import * as disk from './persist.js'
import { cutPixels, joinPixels, type SparsePixels, samePixels } from './sparse-pixels.js'
import { connectLocalTagSync, synchronizeLocalTemplateTags } from './tags.js'

export type {
  SaveResult,
  StoredRecord,
  StoredTemplate,
  TemplateCatalog,
  TemplateLoadFailure,
} from './persist.js'
export {
  catalogStoredArea,
  catalogTileKeys,
  deleteTemplate as discardTemplate,
  hydrateStoredTemplate,
  loadTemplateCatalog,
  saveTemplateFolders,
  saveTemplateTileKeys,
} from './persist.js'

let native: NativeTemplates | null = null
let onMutation: (() => void) | undefined
let tail: Promise<unknown> = Promise.resolve()

// Serialize Caelestis mutations across tabs. Wplace remains authoritative and is checked before writes.
const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
  const run = async () =>
    typeof navigator !== 'undefined' && navigator.locks
      ? await navigator.locks.request('caelestis-personal-templates', operation)
      : await operation()
  const pending = tail.then(run, run)
  tail = pending.catch(() => {})
  return pending
}

const isWorld = (template: TemplateSave): boolean =>
  (template.surface ?? WORLD_TEMPLATE_SURFACE).kind === 'world'

/** A loaded record. Its pixels are null when it was loaded as metadata. */
const loadedTemplate = (loaded: disk.LoadTemplateResult): TemplateSave | null =>
  loaded.status === 'loaded' ? (loaded.template as TemplateSave) : null

/** A record's pixels: in hand, or read back at exactly its revision. A newer write is a conflict. */
const pixelsOf = async (template: TemplateSave): Promise<SparsePixels> => {
  if (template.pixels !== null) return template.pixels
  const stored = loadedTemplate(await disk.loadTemplate(template.id))
  if (stored?.pixels == null || stored.revision !== template.revision) throw new NativeConflict()
  return stored.pixels
}

const cacheResult = (result: SaveResult): number => {
  if (result.status === 'saved') return result.revision
  if (result.status === 'conflict') throw new NativeConflict()
  throw new Error(`Could not retain the Wplace template cache (${result.status})`)
}

/** Wplace's rendering of a snapshot: tens of seconds and a main-thread palette pass at 36 MP. */
const renderPixels = async (api: NativeTemplates, snapshot: NativeSnapshot) => {
  const { indices, ...rendered } = await api.pixels(snapshot)
  return { ...rendered, pixels: cutPixels(rendered.width, rendered.height, indices) }
}

/**
 * Derive the local record from a native snapshot. `rendersPrevious` says the snapshot's artwork is
 * `previous.pixels` exactly, because this tab just wrote it from them.
 */
const project = async (
  api: NativeTemplates,
  incoming: NativeSnapshot,
  previous: TemplateSave | null,
  rendersPrevious = false,
): Promise<TemplateSave> => {
  let snapshot = incoming
  if (previous !== null && (await synchronizeLocalTemplateTags(previous.id, api))) {
    const current = await api.read(incoming.template.id)
    if (current === null) throw new NativeConflict()
    snapshot = current
  }
  if (previous?.native?.token === snapshot.token) return previous
  const placement = nativePlacement(snapshot.template)
  const reusable =
    previous !== null &&
    previous.width === placement.width &&
    previous.height === placement.height &&
    // Tag reconciliation may have swapped in a newer snapshot; the written artwork counts only if
    // that snapshot still renders the same.
    ((rendersPrevious && sameRender(incoming.token, snapshot.token)) ||
      (previous.native?.token !== undefined && sameRender(previous.native.token, snapshot.token)))
  const pixels = reusable
    ? {
        ...placement,
        id: previous.id,
        name: snapshot.template.name,
        source: previous.source,
        sortOrder: snapshot.template.order,
        pixels: previous.pixels,
        opaque: previous.opaque,
        moved: previous.moved,
      }
    : await renderPixels(api, snapshot)
  const nativeOpacityChanged =
    previous === null ||
    (previous.native?.status === 'linked' && previous.native.opacity !== snapshot.template.opacity)
  const owns = previous?.owns ?? (previous?.appearance != null ? APPEARANCE_GROUPS : [])
  // Wplace may have moved or redrawn it, so the painted tiles are recounted on restore.
  const { tileKeys: _staleTiles, ...kept } = previous ?? {}
  const template: TemplateSave = {
    ...kept,
    ...pixels,
    id: previous?.id ?? pixels.id,
    // An existing import keeps its source attribution and quantization report.
    source: previous?.source ?? pixels.source,
    moved: Math.min(previous?.moved ?? pixels.moved, pixels.opaque),
    revision: previous?.revision ?? 0,
    visible: snapshot.template.visible,
    everPlaced: snapshot.template.hasPlaced,
    updatedAt: snapshot.template.updatedAt,
    surface: WORLD_TEMPLATE_SURFACE,
    appearance: previous?.appearance ?? null,
    owns,
    folderId: previous?.folderId ?? null,
    native: {
      id: snapshot.template.id,
      status: 'linked',
      token: snapshot.token,
      opacity: snapshot.template.opacity,
      opacityOverride: nativeOpacityChanged || previous?.native?.opacityOverride === true,
    },
  }
  // Reused artwork is the stored artwork. Rendered artwork is compared with it.
  const artworkChanged =
    previous !== null &&
    !reusable &&
    template.pixels !== null &&
    !samePixels(await pixelsOf(previous), template.pixels)
  // Pixels edited in Wplace's editor no longer come from the imported source and recipe.
  const { authoring: _stale, ...processedOnly } = template
  const projected = artworkChanged ? processedOnly : template
  // A native edit during decoding supersedes this projection.
  if ((await api.read(snapshot.template.id))?.token !== snapshot.token) throw new NativeConflict()
  const revision = cacheResult(
    await disk.saveTemplate(projected, previous?.revision ?? null, artworkChanged),
  )
  if (previous === null) await synchronizeLocalTemplateTags(projected.id, api)
  return { ...projected, revision }
}

/** Journal the native identity before copying pixels, so an interrupted migration never duplicates art. */
const migrate = async (api: NativeTemplates, template: TemplateSave): Promise<TemplateSave> => {
  if (!isWorld(template) || template.native?.status === 'linked') return template
  let pending = template
  if (pending.native === undefined) {
    const id = `caelestis-${await nativeLocalId(template.id)}`
    // A pre-existing record under our migration identity is never overwritten.
    if (api.metadata.getById(id) !== undefined) throw new NativeConflict()
    pending = { ...template, native: { id, status: 'pending' } }
    pending = {
      ...pending,
      revision: cacheResult(await disk.saveTemplate(pending, template.revision)),
    }
  }
  const id = pending.native?.id
  if (id === undefined) throw new Error('Migration identity is missing')
  const existing = await api.read(id)
  const snapshot =
    existing ??
    (await api.save(
      id,
      {
        ...nativeMetadata(pending),
        originalWidth: pending.width,
        originalHeight: pending.height,
        opacity:
          (pending.owns?.includes('pixels') ?? pending.appearance != null)
            ? (pending.appearance?.opacity ?? getSurfaceAppearance(WORLD_TEMPLATE_SURFACE).opacity)
            : getSurfaceAppearance(WORLD_TEMPLATE_SURFACE).opacity,
      },
      null,
      await nativeImage({ ...pending, indices: joinPixels(await pixelsOf(pending)) }),
    ))
  // A new native copy is these exact pixels with lossless colour settings: rendering it returns them.
  return await project(api, snapshot, pending, existing === null)
}

const synchronizeOne = async (
  api: NativeTemplates,
  template: TemplateSave,
): Promise<TemplateSave | null> => {
  if (!isWorld(template)) return template
  if (template.native?.status !== 'linked') return await migrate(api, template)
  const snapshot = await api.read(template.native.id)
  if (snapshot !== null) return await project(api, snapshot, template)
  // Native absence is authoritative after migration commits. Never re-create a deleted native ID.
  cacheResult(await disk.deleteTemplate(template.id, template.revision))
  return null
}

/** Install the native owner. Alliance records continue through Caelestis's existing surface wrapper. */
export const connectPersonalStore = (api: NativeTemplates, observer?: () => void): void => {
  native = api
  onMutation = observer
  connectLocalTagSync(async () => {
    await synchronizePersonalTemplates()
    onMutation?.()
  })
}

/** Refresh derived records, preserving individual failures for retry rather than treating them as deletions. */
export const synchronizePersonalTemplates = (): Promise<void> =>
  exclusive(async () => {
    if (native === null) return
    const api = native
    // Metadata only: pixels load just for artwork that changed, one template at a time.
    const known = new Set<string>()
    for (const localId of await disk.loadTemplateIds()) {
      const template = loadedTemplate(await disk.loadTemplateMetadata(localId))
      if (template === null || !isWorld(template)) continue
      if (template.native !== undefined) known.add(template.native.id)
      try {
        const current = await synchronizeOne(api, template)
        if (current?.native !== undefined) known.add(current.native.id)
      } catch (error) {
        warn('install', `could not sync personal template ${template.name}`, String(error))
      }
    }
    const identities = await disk.loadNativeTemplateIds()
    for (const id of api.ids()) {
      if (known.has(id)) continue
      try {
        const snapshot = await api.read(id)
        if (snapshot === null) continue
        // A previous pass may have left a projection outside this batch's hydration budget.
        const localId = identities.get(id) ?? (await nativeLocalId(id))
        const loaded = await disk.loadTemplateMetadata(localId)
        if (loaded.status !== 'loaded' && loaded.status !== 'missing') continue
        const previous = loadedTemplate(loaded)
        // A pending migration retains its original identity even when decoding failed earlier in this pass.
        if (previous?.native?.status === 'pending') continue
        await project(api, snapshot, previous)
      } catch (error) {
        warn('install', `could not mirror Wplace template ${id}`, String(error))
      }
    }
  })

/** Read the native winner for linked records; legacy/alliance records keep their existing persistence contract. */
const loadCurrent = async (
  id: string,
  load: (id: string) => Promise<disk.LoadTemplateResult>,
): Promise<disk.LoadTemplateResult> => {
  if (native === null) return await load(id)
  return await exclusive(async () => {
    const loaded = await load(id)
    const previous = loadedTemplate(loaded)
    if (previous?.native === undefined || native === null) return loaded
    try {
      const current = await synchronizeOne(native, previous)
      return current === null ? { status: 'missing' } : { status: 'loaded', template: current }
    } catch (error) {
      warn('install', `could not read native template ${id}`, String(error))
      return { status: 'unavailable' }
    }
  })
}

/** One template with its pixels, current with Wplace. */
export const loadTemplate = async (
  id: string,
  maxIndexPixels?: number,
): Promise<disk.LoadTemplateResult> =>
  await loadCurrent(id, async (local) => await disk.loadTemplate(local, maxIndexPixels))

/** One template current with Wplace, without its pixels: a loaded template's `pixels` is null. */
export const loadTemplateMetadata = async (id: string): Promise<disk.LoadTemplateResult> =>
  await loadCurrent(id, disk.loadTemplateMetadata)

/** Commit supported personal edits through Wplace, then retain the derived pixels and Caelestis metadata. */
export const saveTemplate = async (
  template: TemplateSave,
  expectedRevision: number | null,
  archiveCurrent = false,
): Promise<SaveResult> => {
  if (archiveCurrent && template.pixels === null) {
    throw new RangeError('a new version needs its pixels')
  }
  if (!isWorld(template) || (native === null && template.native === undefined))
    return archiveCurrent
      ? await disk.saveTemplate(template, expectedRevision, true)
      : await disk.saveTemplate(template, expectedRevision)
  if (native === null) return { status: 'unavailable' }
  return await exclusive<SaveResult>(async () => {
    const api = native
    if (api === null) return { status: 'unavailable' }
    try {
      const previous = loadedTemplate(await disk.loadTemplateMetadata(template.id))
      if (
        previous?.revision !== expectedRevision &&
        !(previous === null && expectedRevision === null)
      )
        return { status: 'conflict' }
      if (previous === null) {
        const { pixels } = template
        // A metadata save needs a stored record to keep the pixels of, and another tab removed it.
        if (pixels === null) return { status: 'conflict' }
        const saved = await disk.saveTemplate(template, null)
        if (saved.status !== 'saved') return saved
        const linked = await migrate(api, { ...template, pixels, revision: saved.revision })
        return {
          status: 'saved',
          revision: linked.revision,
          ...(linked.native === undefined ? {} : { native: linked.native }),
        }
      }
      let linked = await migrate(api, previous)
      const nativeId = linked.native?.id
      if (nativeId === undefined) throw new Error('Native identity is missing')
      const snapshot = await api.read(nativeId)
      if (snapshot === null || snapshot.token !== linked.native?.token) {
        await synchronizeOne(api, linked)
        return { status: 'conflict' }
      }
      const patch = nativeMetadata(template)
      const ownsPixels = template.owns?.includes('pixels') === true
      const opacityChanged =
        ownsPixels !== (previous.owns?.includes('pixels') === true) ||
        (ownsPixels && template.appearance?.opacity !== previous.appearance?.opacity)
      const opacity = opacityChanged
        ? ownsPixels && template.appearance != null
          ? template.appearance.opacity
          : getSurfaceAppearance(WORLD_TEMPLATE_SURFACE).opacity
        : snapshot.template.opacity
      const changed =
        JSON.stringify(patch) !== JSON.stringify(nativeMetadata(linked)) ||
        opacity !== snapshot.template.opacity
      if (archiveCurrent) {
        // Reserve history before changing native artwork. A full archive must leave native pixels intact.
        const archived = await disk.saveTemplate(
          { ...linked, pixels: await pixelsOf(linked) },
          linked.revision,
          true,
        )
        if (archived.status !== 'saved') return archived
        linked = { ...linked, revision: archived.revision }
      }
      const saved =
        changed || archiveCurrent
          ? await api.save(
              nativeId,
              {
                ...patch,
                opacity,
                ...(archiveCurrent
                  ? {
                      originalWidth: template.width,
                      originalHeight: template.height,
                      colorMetric: 'lab',
                      dithering: false,
                      useLegacyColors: false,
                      colorPaletteMode: 'all',
                      templateColorIdxs: undefined,
                    }
                  : {}),
              },
              snapshot,
              archiveCurrent && template.pixels !== null
                ? await nativeImage({ ...template, indices: joinPixels(template.pixels) })
                : undefined,
            )
          : snapshot
      const next: TemplateSave = {
        ...template,
        native: {
          id: nativeId,
          status: 'linked',
          token: saved.token,
          opacity: saved.template.opacity,
          opacityOverride: !opacityChanged && linked.native?.opacityOverride === true,
        },
      }
      // A native write may finish even if this derived cache cannot. Reconciliation reads the native winner.
      const result = await disk.saveTemplate(next, linked.revision, false, archiveCurrent)
      return result.status === 'saved' && next.native !== undefined
        ? { ...result, native: next.native }
        : { status: 'conflict' }
    } catch (error) {
      warn('install', `could not save personal template ${template.name}`, String(error))
      return { status: error instanceof NativeConflict ? 'conflict' : 'unavailable' }
    }
  }).finally(() => onMutation?.())
}

/** Native deletion wins; server-owned templates never reach this local persistence boundary. */
export const deleteTemplate = async (id: IDBValidKey, revision: number): Promise<SaveResult> => {
  const loaded = typeof id === 'string' ? await disk.loadTemplateMetadata(id) : null
  if (loaded?.status === 'unavailable' || loaded?.status === 'invalid')
    return { status: 'unavailable' }
  const previous = loaded === null ? null : loadedTemplate(loaded)
  if (previous?.native === undefined) return await disk.deleteTemplate(id, revision)
  if (native === null) return { status: 'unavailable' }
  return await exclusive(async () => {
    const current =
      typeof id === 'string' ? loadedTemplate(await disk.loadTemplateMetadata(id)) : null
    if (current?.revision !== revision || current.native === undefined || native === null)
      return { status: 'conflict' }
    try {
      const snapshot = await native.read(current.native.id)
      if (snapshot !== null) {
        if (snapshot.token !== current.native.token) return { status: 'conflict' }
        await native.remove(snapshot)
      }
      return await disk.deleteTemplate(id, revision)
    } catch (error) {
      warn('install', `could not delete native template ${String(id)}`, String(error))
      return { status: error instanceof NativeConflict ? 'conflict' : 'unavailable' }
    }
  })
}
