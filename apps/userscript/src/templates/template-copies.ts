import {
  sameTemplateSurface,
  type TemplateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { isScopeVisible, type ServerConnection, serverTemplatePreference } from '../settings.js'
import {
  catalogEntries,
  notifyLocalChange,
  type ServerCopy,
  type TemplateCopy,
  templateById,
  type WplaceCopy,
  writeInOrder,
  writeManyInOrder,
} from './catalog.js'
import { paintedTileKeys } from './placement.js'
import {
  areaOf,
  dropPixels,
  installEntry,
  MAX_RESIDENT_PIXELS,
  makeRoom,
  newArtwork,
  registerPixelLoader,
  removeEntry,
} from './residency.js'
import { restoreRunning } from './restore.js'
import { forgetServerPixels, readServerPixels, saveServerPixels } from './server-pixel-cache.js'
import { cutPixels, type SparsePixels, storedArea } from './sparse-pixels.js'
import { MAX_TEMPLATE_NAME_LENGTH } from './template-record.js'

/**
 * Copies of templates someone else owns: a Caelestis server's, or Wplace's own.
 *
 * Server sync and the Wplace mirrors are their only writers. The catalog holds each copy beside
 * Local templates, but never saves one: the owner is where it lives, and a stale copy in IndexedDB
 * would outlive a delete. Pixels are cached on disk by version, and a server's are downloaded again
 * through the source server sync registers.
 */

/** Fields this browser keeps for a copy itself, rather than taking them from the owner. */
type KeptHere = 'artwork' | 'tiles' | 'visible' | 'everPlaced' | 'appearance' | 'revision' | 'owns'

/**
 * A copy as its owner hands it over. A server reports the world tiles it paints; a Wplace mirror's
 * are counted from its pixels.
 */
export type CopyRecord =
  | (Omit<ServerCopy, KeptHere> & { readonly tileKeys: readonly string[] })
  | Omit<WplaceCopy, KeptHere>

type ServerPixelSource = (copy: ServerCopy) => Promise<Uint8Array | null>
let serverPixelSource: ServerPixelSource | null = null

/** Server sync registers how to download a template again when its disk copy is gone. */
export const setServerPixelSource = (source: ServerPixelSource): void => {
  serverPixelSource = source
}

/** Reload a copy from its disk cache, or download a server's again. */
const loadCopyPixels = async (copy: TemplateCopy): Promise<SparsePixels> => {
  const cached = await readServerPixels(copy.id, copy.version, copy.width, copy.height)
  let pixels = cached
  if (pixels === null && copy.origin === 'server') {
    // Downloads arrive as one dense image.
    const indices = (await serverPixelSource?.(copy)) ?? null
    if (indices !== null && indices.length === areaOf(copy)) {
      pixels = cutPixels(copy.width, copy.height, indices)
    }
  }
  if (pixels === null) throw new Error('Could not load this server template. Try again.')
  if (templateById(copy.id)?.artwork !== copy.artwork) {
    throw new Error('That template changed while it was loading. Try again.')
  }
  // Queued behind metadata updates and judged by the live row, so a download that started while
  // the template was public cannot write it back after unpublishing cleared the disk.
  if (cached === null) {
    const loaded = pixels
    void writeInOrder(copy.id, async () => {
      const live = templateById(copy.id)
      if (live?.origin === 'server' && live.unpublished) return
      await saveServerPixels(copy.id, copy.version, loaded, copy.opaque)
    })
  }
  return pixels
}
registerPixelLoader('copy', loadCopyPixels)

/**
 * Is there room for this copy, before anything is downloaded for it?
 *
 * Copies that do not fit beside the others wait on disk, so the only refusal is a template too large
 * to ever be in memory, or an id a Local template already holds. Asked before downloading, so an
 * owner advertising such a template costs no transfer.
 */
export const hasRoomForCopy = (id: string, nextPixels: number): boolean => {
  if (!Number.isSafeInteger(nextPixels) || nextPixels < 0) return false
  if (templateById(id)?.origin === 'local') return false
  return nextPixels <= MAX_RESIDENT_PIXELS
}

/**
 * Put a copy into the catalog, replacing any earlier copy of it.
 *
 * Its local switches survive the replacement: whether it is showing and how it is drawn are this
 * browser's opinions about someone else's template, and re-syncing pixels is no reason to discard
 * them. Everything else — the name, where it sits, the pixels — comes from the owner.
 *
 * Downloaded pixels are cached on disk and stay in memory if they fit. Null indices install a copy
 * whose pixels are already cached at this version, without reading them; `cachedArea` is what that
 * copy will cost once loaded.
 */
export const putTemplateCopy = async (
  record: CopyRecord & { readonly indices: Uint8Array | null; readonly cachedArea?: number },
  /** Checked after every awaited step, immediately before the live row may change. */
  isCurrent: () => boolean = () => true,
): Promise<boolean> => {
  const restoring = restoreRunning()
  if (restoring !== null) await restoring
  return await writeInOrder(record.id, async () => {
    if (!isCurrent()) return false
    const existing = templateById(record.id)
    if (existing?.origin === 'local') {
      throw new RangeError('server template id collides with a local template')
    }
    const visible = existing?.visible ?? isScopeVisible(record.id)
    const preference = existing === undefined ? serverTemplatePreference(record.id) : undefined
    const { indices, cachedArea, ...fields } = record
    const pixels = indices === null ? null : cutPixels(record.width, record.height, indices)
    let copy: Omit<ServerCopy, KeptHere> | Omit<WplaceCopy, KeptHere>
    let tiles: ReadonlySet<string>
    if (fields.origin === 'server') {
      const { tileKeys, ...server } = fields
      copy = server
      tiles = new Set(tileKeys)
    } else {
      // Without owner-reported coverage, colour navigation and full progress scans need the tiles.
      if (pixels === null) throw new RangeError('a cached Wplace copy needs its painted tiles')
      copy = fields
      tiles = await paintedTileKeys(fields, pixels)
    }
    // On disk before it can be evicted, so dropping it from memory never loses it. A draft stays off
    // disk and downloads again instead.
    if (copy.origin === 'server' && copy.unpublished) await forgetServerPixels([record.id])
    else if (pixels !== null) {
      await saveServerPixels(record.id, record.version, pixels, record.opaque)
    }
    if (!isCurrent()) return false
    if (existing !== undefined) dropPixels(existing)
    const area = pixels === null ? cachedArea : storedArea(pixels)
    const resident = pixels !== null && makeRoom(storedArea(pixels), record.id)
    installEntry({
      ...copy,
      artwork: newArtwork(resident ? pixels : null, area),
      surface: record.surface ?? WORLD_TEMPLATE_SURFACE,
      tiles,
      // Whether someone else's template is on *your* canvas is your decision and nobody else's, so
      // it is read back from this browser's own record rather than defaulted.
      visible,
      everPlaced: true,
      appearance: existing !== undefined ? existing.appearance : (preference?.appearance ?? null),
      revision: existing?.revision ?? 0,
      owns: existing !== undefined ? existing.owns : (preference?.owns ?? []),
    })
    notifyLocalChange()
    return true
  })
}

/** Refresh server-owned metadata without rebuilding unchanged pixels. */
export const updateServerTemplateMetadata = async (
  id: string,
  name: string,
  nodeId: string | null,
  unpublished: boolean,
  server: ServerConnection,
): Promise<boolean> =>
  await writeInOrder(id, async () => {
    const existing = templateById(id)
    if (existing?.origin !== 'server') return false
    if (name.length === 0 || name.length > MAX_TEMPLATE_NAME_LENGTH) return false
    if (
      existing.name === name &&
      existing.nodeId === nodeId &&
      existing.unpublished === unpublished &&
      existing.server === server
    )
      return true
    // Unpublished since its pixels were saved: take them back off disk.
    if (unpublished && !existing.unpublished) await forgetServerPixels([id])
    installEntry({ ...existing, name, nodeId, unpublished, server })
    notifyLocalChange()
    return true
  })

/** Drop a copy we hold, because its owner has stopped publishing it. */
export const forgetTemplateCopy = async (id: string): Promise<void> =>
  await writeInOrder(id, async () => {
    const existing = templateById(id)
    if (existing === undefined || existing.origin === 'local') return
    removeEntry(existing)
    notifyLocalChange()
    await forgetServerPixels([id])
  })

/**
 * Forget every copy `belongs` picks, and free their decoded indices with them.
 *
 * For an owner going away: a disconnected server is never synced again, so the ordinary sync would
 * leave its templates drawn with no row anywhere to switch them off from.
 */
export const forgetTemplateCopies = async (
  belongs: (copy: TemplateCopy) => boolean,
): Promise<void> => {
  const ids = [...catalogEntries()]
    .filter((template) => template.origin !== 'local' && belongs(template))
    .map(({ id }) => id)
  if (ids.length === 0) return
  await writeManyInOrder(ids, async () => {
    let removed = false
    for (const id of ids) {
      const template = templateById(id)
      if (template === undefined || template.origin === 'local' || !belongs(template)) continue
      removeEntry(template)
      removed = true
    }
    if (removed) notifyLocalChange()
    await forgetServerPixels(ids)
  })
}

/** Forget one server's copies on one drawing surface while preserving its other canvases. */
export const forgetServerSurfaceTemplates = async (
  serverUrl: string,
  surface: TemplateSurface,
): Promise<void> => {
  const ids = [...catalogEntries()]
    .filter(
      (template) =>
        template.origin === 'server' &&
        template.server.url === serverUrl &&
        sameTemplateSurface(template.surface ?? WORLD_TEMPLATE_SURFACE, surface),
    )
    .map(({ id }) => id)
  await Promise.all(ids.map(async (id) => await forgetTemplateCopy(id)))
}
