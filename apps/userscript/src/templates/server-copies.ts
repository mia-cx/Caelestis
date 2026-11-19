import {
  sameTemplateSurface,
  type TemplateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { isScopeVisible, type ServerConnection, serverTemplatePreference } from '../settings.js'
import {
  catalogEntries,
  isServerTemplate,
  notifyLocalChange,
  type PlacedTemplate,
  templateById,
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
import { MAX_TEMPLATE_NAME_LENGTH, type TemplateRecord } from './template-record.js'

/**
 * Copies of templates someone else owns: a Caelestis server's, or Wplace's own.
 *
 * Server sync and the Wplace mirrors are their only writers. The catalog holds each copy beside
 * Local templates, but never saves one: the owner is where it lives, and a stale copy in IndexedDB
 * would outlive a delete. Pixels are cached on disk by version, and downloaded again through the
 * source server sync registers.
 */

type ServerPixelSource = (template: PlacedTemplate) => Promise<Uint8Array | null>
let serverPixelSource: ServerPixelSource | null = null

/** Server sync registers how to download a template again when its disk copy is gone. */
export const setServerPixelSource = (source: ServerPixelSource): void => {
  serverPixelSource = source
}

/** Reload a copy from its disk cache, or download it again. */
const loadCopyPixels = async (template: PlacedTemplate): Promise<SparsePixels> => {
  const version = template.serverVersion ?? ''
  const cached = await readServerPixels(template.id, version, template.width, template.height)
  let pixels = cached
  if (pixels === null) {
    // Downloads arrive as one dense image.
    const indices = (await serverPixelSource?.(template)) ?? null
    if (indices !== null && indices.length === areaOf(template)) {
      pixels = cutPixels(template.width, template.height, indices)
    }
  }
  if (pixels === null) throw new Error('Could not load this server template. Try again.')
  if (templateById(template.id)?.artwork !== template.artwork) {
    throw new Error('That template changed while it was loading. Try again.')
  }
  // Queued behind metadata updates and judged by the live row, so a download that started while
  // the template was public cannot write it back after unpublishing cleared the disk.
  if (cached === null) {
    const loaded = pixels
    void writeInOrder(template.id, async () => {
      if (templateById(template.id)?.serverUnpublished === true) return
      await saveServerPixels(template.id, version, loaded, template.opaque)
    })
  }
  return pixels
}
registerPixelLoader('copy', loadCopyPixels)

/**
 * Is there room for this server template, before anything is downloaded for it?
 *
 * Copies that do not fit beside the others wait on disk, so the only refusal is a template too large
 * to ever be in memory, or an id a Local template already holds. Asked before downloading, so a
 * server advertising such a template costs no transfer.
 */
export const hasRoomForServerTemplate = (id: string, nextPixels: number): boolean => {
  if (!Number.isSafeInteger(nextPixels) || nextPixels < 0) return false
  const existing = templateById(id)
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
 * whose pixels are already cached at this version, without reading them; `cachedArea` is what that
 * copy will cost once loaded.
 */
export const putServerTemplate = async (
  template: TemplateRecord & {
    indices: Uint8Array | null
    cachedArea?: number
    surface?: TemplateSurface
    serverUrl: string
    serverTemplateId: string
    serverNodeId: string | null
    serverVersion: string
    serverUnpublished?: boolean
    sourceOpacity?: number
    serverConnection?: ServerConnection
    serverTileKeys?: readonly string[]
    wrapX?: boolean
  },
  /** Checked after every awaited step, immediately before the live row may change. */
  isCurrent: () => boolean = () => true,
): Promise<boolean> => {
  const restoring = restoreRunning()
  if (restoring !== null) await restoring
  return await writeInOrder(template.id, async () => {
    if (!isCurrent()) return false
    const existing = templateById(template.id)
    if (existing !== undefined && !isServerTemplate(existing)) {
      throw new RangeError('server template id collides with a local template')
    }
    const visible = existing?.visible ?? isScopeVisible(template.id)
    const preference = existing === undefined ? serverTemplatePreference(template.id) : undefined
    const { indices, cachedArea, ...metadata } = template
    const pixels = indices === null ? null : cutPixels(template.width, template.height, indices)
    // Without server-reported coverage, colour navigation and full progress scans need the tiles.
    let tiles: ReadonlySet<string> = new Set<string>()
    if (template.serverTileKeys === undefined) {
      if (pixels === null) throw new RangeError('a cached server template needs its painted tiles')
      tiles = await paintedTileKeys(metadata, pixels)
    }
    // On disk before it can be evicted, so dropping it from memory never loses it. A draft stays off
    // disk and downloads again instead.
    if (template.serverUnpublished === true) await forgetServerPixels([template.id])
    else if (pixels !== null) {
      await saveServerPixels(template.id, template.serverVersion, pixels, template.opaque)
    }
    if (!isCurrent()) return false
    if (existing !== undefined) dropPixels(existing)
    const area = pixels === null ? cachedArea : storedArea(pixels)
    const resident = pixels !== null && makeRoom(storedArea(pixels), template.id)
    installEntry({
      ...metadata,
      artwork: newArtwork(resident ? pixels : null, area),
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
    notifyLocalChange()
    return true
  })
}

/** Refresh server-owned metadata without rebuilding unchanged pixels. */
export const updateServerTemplateMetadata = async (
  id: string,
  name: string,
  serverNodeId: string | null,
  serverUnpublished: boolean,
  serverConnection?: ServerConnection,
): Promise<boolean> =>
  await writeInOrder(id, async () => {
    const existing = templateById(id)
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
    installEntry({
      ...existing,
      name,
      serverNodeId,
      serverUnpublished,
      ...(serverConnection === undefined ? {} : { serverConnection }),
    })
    notifyLocalChange()
    return true
  })

/** Drop a server template we hold, because the server has stopped publishing it. */
export const forgetServerTemplate = async (id: string): Promise<void> =>
  await writeInOrder(id, async () => {
    const existing = templateById(id)
    if (existing === undefined || !isServerTemplate(existing)) return
    removeEntry(existing)
    notifyLocalChange()
    await forgetServerPixels([id])
  })

/**
 * Forget everything one server published, and free its decoded indices with it.
 *
 * For disconnecting: a disconnected server is never synced again, so the ordinary sync would leave
 * its templates drawn with no row anywhere to switch them off from.
 */
export const forgetServerTemplates = async (serverUrl: string): Promise<void> => {
  const ids = [...catalogEntries()]
    .filter((template) => template.serverUrl === serverUrl)
    .map(({ id }) => id)
  if (ids.length === 0) return
  await writeManyInOrder(ids, async () => {
    let removed = false
    for (const id of ids) {
      const template = templateById(id)
      if (template === undefined || template.serverUrl !== serverUrl) continue
      removeEntry(template)
      removed = true
    }
    if (removed) notifyLocalChange()
    await forgetServerPixels(ids)
  })
}

/** Forget one server's rows on one drawing surface while preserving its other canvases. */
export const forgetServerSurfaceTemplates = async (
  serverUrl: string,
  surface: TemplateSurface,
): Promise<void> => {
  const ids = [...catalogEntries()]
    .filter(
      (template) =>
        template.serverUrl === serverUrl &&
        sameTemplateSurface(template.surface ?? WORLD_TEMPLATE_SURFACE, surface),
    )
    .map(({ id }) => id)
  await Promise.all(ids.map(async (id) => await forgetServerTemplate(id)))
}
