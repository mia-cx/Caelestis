import {
  sameTemplateSurface,
  type TemplateSurface,
  templateSurfaceKey,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { registerDebugEntry } from '../console-api.js'
import { warn } from '../debug.js'
import { localFolderChainVisible } from '../local-folders.js'
import { isCurrentServerConnection } from '../server-connections.js'
import {
  getState,
  getSurfaceAppearance,
  isScopeVisible,
  type LocalFolder,
  type ServerConnection,
} from '../settings.js'
import {
  LOCAL_ROOT_KEY,
  localFolderKey,
  localTemplateKey,
  nodeTreeKey,
  serverScopeKey,
  serverTemplateTreeKey,
} from '../tree-keys.js'
import { type Appearance, type AppearanceGroup, GROUP_FIELDS } from './appearance.js'
import type { ImportedTemplate } from './import.js'
import { validatePlacement } from './placement.js'
import { nodeChainVisible, serverNodeParents, serverNodesRevision } from './server-nodes.js'
import { cutPixels, type SparsePixels } from './sparse-pixels.js'
import type { NativeLink, TemplateRecord } from './template-record.js'
import { WPLACE_OWNER_URL, type WplaceOwner } from './wplace-owned.js'

/**
 * The template catalog: every template this tab draws, in the order the panel shows them, with
 * change notification, previews and the editor's draft.
 *
 * It is the leaf of the template store. Residency (`residency.ts`) decides which artwork stays in
 * memory, `restore.ts` and `template-copies.ts` fill the catalog, and `template-edits.ts` changes it.
 */

/**
 * A template's pixels, held in memory only while the template is resident.
 *
 * Its identity changes only when the pixels do, so caches keyed on it (progress, colour totals)
 * survive eviction and reload. Read `pixels` for synchronous work that may skip an evicted template;
 * await `templateChunks` or `templatePixels` for work that needs the pixels.
 */
export interface TemplateArtwork {
  /** The painted chunks; null while evicted. */
  readonly pixels: SparsePixels | null
}

/** What every catalog entry has, wherever it came from. */
interface PlacedBase extends TemplateRecord {
  readonly artwork: TemplateArtwork
  /** Drawing surface this placement belongs to. Legacy browser-owned templates are world-scoped. */
  readonly surface?: TemplateSurface
  /** Painted world-tile keys (`x/y`) that bound mismatch and navigation work. */
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
}

/** A template that lives in this browser, saved in IndexedDB and edited here. */
export interface LocalTemplate extends PlacedBase {
  readonly origin: 'local'
  readonly native?: NativeLink
  /** Last content or placement edit; absent on legacy records. */
  readonly updatedAt?: number
  /**
   * Held in Local only until it uploads to a server. A staged template is in no group: the sidebar
   * does not list it and no switch hides it, since its outline and Apply or Cancel are the only way
   * out of its placement.
   */
  readonly staged?: true
  /** Which Local folder this sits in, or null for the top level of Local. */
  readonly folderId: string | null
}

/**
 * A copy of a template a Caelestis server publishes. The server owns and measures it; this browser
 * keeps only its own switches for it.
 */
export interface ServerCopy extends PlacedBase {
  readonly origin: 'server'
  /** The connection that drew it; a copy from an ended connection does not draw. */
  readonly server: ServerConnection
  /** Its id on that server, which is what the admin routes address. */
  readonly serverTemplateId: string
  /** The server folder it hangs off, or null at the server root. */
  readonly nodeId: string | null
  /** The version these pixels came from, so a sync knows whether to re-download them. */
  readonly version: string
  /**
   * Only an admin token can read it. Wplace's own scripts can read this page's IndexedDB and Cache
   * Storage, so nothing of it is written there.
   */
  readonly unpublished: boolean
  /** The source continues at x=0 after reaching the world's east edge. */
  readonly wrapX: boolean
}

/**
 * A read-only mirror of a template Wplace serves itself. No Caelestis server measures it, so its
 * progress and markers come from tile pixels, like a Local template's.
 */
export interface WplaceCopy extends PlacedBase {
  readonly origin: 'wplace'
  readonly owner: WplaceOwner
  /** The event group it belongs to, or null. */
  readonly nodeId: string | null
  /** Identifies the mirrored pixels, so a refresh knows whether to rebuild them. */
  readonly version: string
  /** Wplace's alliance opacity, used until this browser takes ownership of the pixels appearance. */
  readonly sourceOpacity?: number
}

/**
 * One catalog entry. Everything downstream — the renderer, the mismatch scan, the colour picker,
 * the overlay menu — takes any of them; `origin` says who owns it.
 */
export type PlacedTemplate = LocalTemplate | ServerCopy | WplaceCopy

/** Copies someone else owns, which this browser never saves. */
export type TemplateCopy = ServerCopy | WplaceCopy

/** A placement with its pixels in hand, for work that reads them. */
export type PlacedPixels = Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height'> & {
  readonly pixels: SparsePixels
}

const templates = new Map<string, PlacedTemplate>()
const previewOrigins = new Map<string, { x: number; y: number }>()
const deleting = new Set<string>()
const pendingAdds = new Set<string>()
const listeners: Array<() => void> = []
const previewListeners: Array<() => void> = []
let templateRevision = 0
let orderedCacheRevision = -1
let orderedCache: readonly PlacedTemplate[] = []

/**
 * Write one catalog entry. Residency's `installEntry` is the writer everyone else uses: it keeps the
 * pixel budget in step with the entry.
 */
export const setCatalogEntry = (template: PlacedTemplate): void => {
  templates.set(template.id, template)
}

/** Remove one entry and its preview. Residency's `removeEntry` is the writer everyone else uses. */
export const deleteCatalogEntry = (id: string): void => {
  previewOrigins.delete(id)
  templates.delete(id)
}

/** Every entry in insertion order, which eviction relies on to break ties. */
export const catalogEntries = (): IterableIterator<PlacedTemplate> => templates.values()

/** Whether an entry holds this id, or an add is admitting one under it. */
export const isIdTaken = (id: string): boolean => templates.has(id) || pendingAdds.has(id)

/** Hold an id for an add that has not reached the catalog yet. Returns the release. */
export const reserveId = (id: string): (() => void) => {
  pendingAdds.add(id)
  return () => pendingAdds.delete(id)
}

/**
 * Whether a delete has been made terminal for this id, from any surface.
 *
 * Set synchronously when a delete starts and held through the IndexedDB work, during which the
 * record is still present in `localTemplates()`. A UI that reads only its own "am I deleting this"
 * flag will happily start a move, or offer a second delete, for a template another surface has
 * already condemned.
 */
export const isDeletingLocal = (id: string): boolean => deleting.has(id)

/** Condemn an id for the length of its delete. Returns the release. */
export const markDeleting = (id: string): (() => void) => {
  deleting.add(id)
  return () => deleting.delete(id)
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

/** Flatten one tree in the same custom sibling order the panel shows. */
const flattenTree = <T extends PlacedTemplate>(
  rows: readonly T[],
  folders: readonly (readonly [id: string, parentId: string | null])[],
  folderKey: (id: string) => string,
  templateKey: (template: T) => string,
  templateParent: (template: T) => string | null,
  rank: ReadonlyMap<string, number>,
): readonly PlacedTemplate[] => {
  const result: PlacedTemplate[] = []
  const seenFolders = new Set<string>()
  const seenTemplates = new Set<string>()
  const foldersByParent = new Map<string | null, string[]>()
  const templatesByParent = new Map<string | null, T[]>()
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
      key: LOCAL_ROOT_KEY,
      rows: flattenTree(
        ordered.filter((template) => template.origin === 'local'),
        state.localFolders.map((folder) => [folder.id, folder.parentId] as const),
        localFolderKey,
        (template) => localTemplateKey(template.id),
        (template) => template.folderId,
        rank,
      ),
    },
    ...state.servers.map((server) => ({
      key: serverScopeKey(server.url),
      rows: flattenTree(
        ordered.filter(
          (template): template is ServerCopy =>
            template.origin === 'server' && template.server.url === server.url,
        ),
        serverNodeParents(server.url),
        (id) => nodeTreeKey(server, id),
        (template) => serverTemplateTreeKey(server, template.serverTemplateId),
        (template) => template.nodeId,
        rank,
      ),
    })),
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
      warn('install', `${what} listener failed`, String(error))
    }
  }
}

/** Announce a catalog change: entries, their pixels, or a delete starting or ending. */
export const notifyLocalChange = (): void => {
  templateRevision++
  notifyListeners(listeners, 'local template')
}

const notifyPreview = (): void => notifyListeners(previewListeners, 'local preview')

export const localTemplates = (): readonly PlacedTemplate[] => orderedTemplates()

/** Current catalog entry for one template id, without allocating or sorting the collection. */
export const templateById = (id: string): PlacedTemplate | undefined => templates.get(id)

/** Whether this exact snapshot is still the installed version of its template. */
export const isCurrentTemplate = (template: PlacedTemplate): boolean =>
  templateById(template.id) === template

/** Ordered template ids directly inside one Local folder. */
export const templateIdsInLocalFolder = (folderId: string): readonly string[] =>
  orderedTemplates()
    .filter((template) => template.origin === 'local' && template.folderId === folderId)
    .map((template) => template.id)

/** Whether a template's source continues at x=0 past the world's east edge. Only server copies do. */
export const wrapsX = (template: PlacedTemplate): boolean =>
  template.origin === 'server' && template.wrapX

// A plain image has no meaningful position until its first placement is applied. Keep it local
// until then so a second tab restoring IndexedDB cannot mistake an active placement for crash
// residue and delete it underneath the owner.
export const isPendingImage = (template: PlacedTemplate): boolean =>
  template.source === 'image' && !template.everPlaced

let displayOrderCache:
  | {
      readonly customOrder: readonly string[]
      readonly localFolders: readonly LocalFolder[]
      readonly servers: readonly ServerConnection[]
      readonly nodeRevision: number
      readonly templateRevision: number
      readonly templates: readonly PlacedTemplate[]
    }
  | undefined
let displayPreviewCache:
  | {
      readonly ordered: readonly PlacedTemplate[]
      readonly draft: PlacedTemplate | null
      readonly origins: ReadonlyMap<string, { readonly x: number; readonly y: number }>
      readonly templates: readonly PlacedTemplate[]
    }
  | undefined

/** Whether every preview origin is the same object it was. Origins are replaced, never mutated. */
const samePreviewOrigins = (
  held: ReadonlyMap<string, { readonly x: number; readonly y: number }>,
): boolean => {
  if (held.size !== previewOrigins.size) return false
  for (const [id, origin] of previewOrigins) if (held.get(id) !== origin) return false
  return true
}

/**
 * Templates as the canvas and its interactions currently present them: custom order plus previews.
 *
 * The same array until the order, a preview or the draft changes, so renderers can keep the
 * snapshots they drew.
 */
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
  const ordered = displayOrderCache.templates
  if (previewOrigins.size === 0 && draft === null) {
    // Let a discarded draft's artwork go.
    displayPreviewCache = undefined
    return ordered
  }
  if (
    displayPreviewCache?.ordered !== ordered ||
    displayPreviewCache.draft !== draft ||
    !samePreviewOrigins(displayPreviewCache.origins)
  ) {
    const moved =
      previewOrigins.size === 0
        ? ordered
        : ordered.map((template) => {
            const preview = previewOrigins.get(template.id)
            return preview === undefined
              ? template
              : { ...template, originX: preview.x, originY: preview.y }
          })
    displayPreviewCache = {
      ordered,
      draft,
      origins: new Map(previewOrigins),
      templates: draft === null ? moved : [...moved, draft],
    }
  }
  return displayPreviewCache.templates
}

/**
 * The template editor's unsaved artwork. It draws above every template and is never stored, so
 * the catalog, the tree, and every sync see none of it.
 */
let draft: PlacedTemplate | null = null

export const templateDraft = (): PlacedTemplate | null => draft

/** Whether this is the editor's draft rather than a catalog entry. */
export const isTemplateDraft = (template: PlacedTemplate): boolean => template.id === draft?.id

/** Show new draft artwork. Its painted tiles are not tracked: nothing scans or navigates a draft. */
export const setTemplateDraft = (
  next: ImportedTemplate | null,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): void => {
  if (next === null) {
    draft = null
    notifyPreview()
    return
  }
  validatePlacement({ ...next, surface })
  const { indices, ...metadata } = next
  draft = {
    ...metadata,
    origin: 'local',
    // Outside the catalog, so outside the resident budget.
    artwork: { pixels: cutPixels(next.width, next.height, indices) },
    surface,
    tiles: new Set(),
    visible: true,
    everPlaced: true,
    appearance: null,
    owns: [],
    revision: 0,
    folderId: null,
  }
  notifyPreview()
}

/** Move the draft without replacing its artwork, as placement previews do. */
export const moveTemplateDraft = (originX: number, originY: number): boolean => {
  if (draft === null) return false
  const moved = { ...draft, originX: Math.round(originX), originY: Math.round(originY) }
  validatePlacement(moved)
  draft = moved
  notifyPreview()
  return true
}

/** Each surface's slice of one `displayTemplates()` list, dropped together when that list changes. */
let surfaceSlices: {
  readonly all: readonly PlacedTemplate[]
  readonly bySurface: Map<string, readonly PlacedTemplate[]>
} | null = null

/**
 * The renderer and editor menu for one canvas must never see templates from another surface.
 *
 * The same array until `displayTemplates()` changes, so a settled renderer compares one reference.
 */
export const displayTemplatesForSurface = (surface: TemplateSurface): readonly PlacedTemplate[] => {
  const all = displayTemplates()
  if (surfaceSlices?.all !== all) surfaceSlices = { all, bySurface: new Map() }
  const key = templateSurfaceKey(surface)
  const held = surfaceSlices.bySurface.get(key)
  if (held !== undefined) return held
  const slice = all.filter((template) =>
    sameTemplateSurface(template.surface ?? WORLD_TEMPLATE_SURFACE, surface),
  )
  surfaceSlices.bySurface.set(key, slice)
  return slice
}

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

/** Drop a preview without announcing it, for a writer whose catalog change announces itself. */
export const forgetPreview = (id: string): void => {
  previewOrigins.delete(id)
}

/**
 * Whether this template actually draws.
 *
 * Its own switch *and* every folder above it, unless it is staged. A template inside a hidden
 * folder keeps saying it is visible, because it is — within a group that is not — and that is what
 * makes turning the group back on restore the arrangement instead of flattening it.
 */
export const isTemplateVisible = (template: PlacedTemplate): boolean => {
  if (template.origin === 'local' && template.staged === true) return true
  if (!template.visible) return false
  // The editor's draft belongs to no folder, and it is the thing being looked at.
  if (isTemplateDraft(template)) return true
  switch (template.origin) {
    case 'local':
      return localFolderChainVisible(template.folderId)
    case 'server':
      return (
        isCurrentServerConnection(template.server) &&
        copyChainVisible(template.server.url, template)
      )
    case 'wplace':
      return copyChainVisible(WPLACE_OWNER_URL[template.owner], template)
  }
}

/** A copy answers to its owner's switch and the owner's folders above it, not to Local's. */
const copyChainVisible = (ownerUrl: string, template: TemplateCopy): boolean =>
  isScopeVisible(serverScopeKey(ownerUrl)) &&
  nodeChainVisible(ownerUrl, template.nodeId, template.surface ?? WORLD_TEMPLATE_SURFACE)

/** Each template's own switch beside the renderer's effective visibility decision. */
registerDebugEntry('templates', () =>
  localTemplates().map((template) => ({
    id: template.id,
    name: template.name,
    visible: template.visible,
    drawing: isTemplateVisible(template),
    origin: template.origin,
    folderId: template.origin === 'local' ? template.folderId : null,
    server: template.origin === 'server' ? template.server.url : null,
    serverTemplateId: template.origin === 'server' ? template.serverTemplateId : null,
    opaque: template.opaque,
  })),
)

/**
 * How this template is actually drawn: its own appearance, or the global default it inherits.
 *
 * The global colour filter lives beside the global appearance rather than inside it — the colour
 * grid writes `hiddenColours` on the state directly — so the inherited object is completed from
 * both, and taking a group over copies the filter the template is actually showing.
 */
export const appearanceOf = (template: PlacedTemplate): Appearance => {
  const global = getSurfaceAppearance(template.surface ?? WORLD_TEMPLATE_SURFACE)
  const own = template.appearance
  const native = template.origin === 'local' ? template.native : undefined
  const nativeOpacity =
    native?.status === 'linked' && native.opacityOverride === true ? native.opacity : undefined
  const sourceOpacity = template.origin === 'wplace' ? template.sourceOpacity : undefined
  const inherited = sourceOpacity === undefined ? global : { ...global, opacity: sourceOpacity }
  if (own === null || template.owns.length === 0)
    return nativeOpacity === undefined ? inherited : { ...inherited, opacity: nativeOpacity }

  // Field by field, from whichever side owns that field's group: a template that has taken over its
  // markers still follows the global sliders for its shape.
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

/** Per-id write order, so each template's saves land in the order they were asked for. */
const writeTails = new Map<string, Promise<unknown>>()

/** Run `write` after every earlier write to `id` settles. */
export const writeInOrder = <T>(id: string, write: () => Promise<T>): Promise<T> => {
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

/** Run `write` after every earlier write to any of `ids` settles, holding all of them. */
export const writeManyInOrder = <T>(
  ids: readonly string[],
  write: () => Promise<T>,
): Promise<T> => {
  const unique = [...new Set(ids)].sort()
  const previous = Promise.all(
    unique.map(async (id) => {
      // A failed earlier write must not block this one.
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
