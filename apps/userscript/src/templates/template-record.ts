import {
  type TemplateSurface,
  type TemplateTag,
  templateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { warn } from '../debug.js'
import {
  APPEARANCE_GROUPS,
  type Appearance,
  type AppearanceGroup,
  legacyAppearanceGroups,
  normaliseAppearance,
} from './appearance.js'
import { storedAuthoring, type TemplateAuthoring } from './authoring.js'
import { validatePlacement } from './placement.js'
import type { SparsePixels } from './sparse-pixels.js'

/**
 * The template record: its shape, its limits, and the one parser every stored copy goes through.
 *
 * A new stored field is added here, once. Imports, the IndexedDB store and the in-memory catalog
 * all extend {@link TemplateRecord}.
 */

export type TemplateSource = 'wplace' | 'marble' | 'image'
const TEMPLATE_SOURCES: readonly unknown[] = [
  'wplace',
  'marble',
  'image',
] satisfies TemplateSource[]

export const MAX_TEMPLATE_ID_LENGTH = 128
export const MAX_TEMPLATE_NAME_LENGTH = 256

/** What every template is, wherever it came from: identity, placement and pixel counts. */
export interface TemplateRecord {
  readonly id: string
  readonly name: string
  readonly source: TemplateSource
  /** Source z-order, lowest first. Optional only for records written by older builds. */
  readonly sortOrder?: number
  /** Top-left corner in global canvas pixels. */
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
  /** How far the quantiser had to move things, for reporting to whoever imported it. */
  readonly moved: number
  readonly opaque: number
  /** Source and recipe behind the pixels. Absent on Marble, server, and older templates. */
  readonly authoring?: TemplateAuthoring
}

/** Native identity and last derived snapshot. Pending records are resumable migration journals. */
export interface NativeLink {
  readonly id: string
  readonly status: 'pending' | 'linked'
  readonly token?: string
  readonly opacity?: number
  /** A native opacity edit overrides only opacity, without owning the whole pixels appearance. */
  readonly opacityOverride?: boolean
}

/** A Local template as this browser stores it. */
export interface StoredTemplate extends TemplateRecord {
  /**
   * The painted chunks. On disk they are one Blob of packed chunk bytes in `indices` and the chunk
   * keys in `chunks`; records written before chunks hold the whole image there and no `chunks`.
   */
  readonly pixels: SparsePixels
  /** Last mirrored tag assignments; owned by the tag transaction, not artwork edits. */
  readonly nativeTags?: readonly TemplateTag[]
  readonly native?: NativeLink
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

export type StoredMetadata = Omit<StoredTemplate, 'pixels'>

/** A stored record as the catalog reads it: always a Local template. */
export type LocalRecord = StoredMetadata & { readonly origin: 'local' }

/** The stored shape of a Local template: everything but the origin the parser marked it with. */
export const storedShape = <T extends { readonly origin: 'local' }>({
  origin: _origin,
  ...stored
}: T): Omit<T, 'origin'> => stored

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const safeInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null

/** A record's compare-and-swap revision, or zero when it carries none that is valid. */
export const storedRevision = (value: unknown): number => {
  if (!isRecord(value)) return 0
  const revision = safeInteger(value.revision)
  return revision !== null && revision >= 0 ? revision : 0
}

const isTemplateSource = (value: unknown): value is TemplateSource =>
  TEMPLATE_SOURCES.includes(value)

/** The fields every stored record shares. */
type StoredCore = Pick<
  StoredMetadata,
  | 'id'
  | 'name'
  | 'source'
  | 'sortOrder'
  | 'originX'
  | 'originY'
  | 'width'
  | 'height'
  | 'moved'
  | 'opaque'
  | 'visible'
  | 'everPlaced'
  | 'revision'
> & { readonly surface: TemplateSurface }

/**
 * Check the fields every stored record shares, throwing a RangeError on the first bad one.
 *
 * `capacity` is the most pixels the record's artwork can hold; the whole box by default.
 */
export const parseStoredCore = (record: Record<string, unknown>, capacity?: number): StoredCore => {
  const { id, name, source, visible, everPlaced, native } = record
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_TEMPLATE_ID_LENGTH) {
    throw new RangeError('template id is invalid')
  }
  if (typeof name !== 'string' || name.length > MAX_TEMPLATE_NAME_LENGTH) {
    throw new RangeError('template name is invalid')
  }
  if (!isTemplateSource(source)) throw new RangeError('template source is invalid')
  const sortOrder = record.sortOrder === undefined ? undefined : safeInteger(record.sortOrder)
  if (sortOrder === null) throw new RangeError('template sort order is invalid')
  const originX = safeInteger(record.originX)
  const originY = safeInteger(record.originY)
  const width = safeInteger(record.width)
  const height = safeInteger(record.height)
  if (originX === null || originY === null || width === null || height === null) {
    throw new RangeError('template placement is invalid')
  }
  const surface =
    record.surface === undefined
      ? WORLD_TEMPLATE_SURFACE
      : isRecord(record.surface)
        ? templateSurface(record.surface.kind, record.surface.allianceId)
        : null
  if (surface === null) throw new RangeError('template surface is invalid')
  validatePlacement({ originX, originY, width, height, surface })
  const moved = safeInteger(record.moved)
  const opaque = safeInteger(record.opaque)
  if (
    moved === null ||
    opaque === null ||
    moved < 0 ||
    (opaque <= 0 && !(opaque === 0 && native !== undefined)) ||
    moved > opaque ||
    opaque > (capacity ?? width * height)
  ) {
    throw new RangeError('template pixel counts are invalid')
  }
  if (typeof visible !== 'boolean' || typeof everPlaced !== 'boolean') {
    throw new RangeError('template state is invalid')
  }
  const revision = record.revision === undefined ? 0 : safeInteger(record.revision)
  if (revision === null || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('template revision is invalid')
  }
  return {
    id,
    name,
    source,
    ...(sortOrder === undefined ? {} : { sortOrder }),
    originX,
    originY,
    width,
    height,
    moved,
    opaque,
    visible,
    everPlaced,
    surface,
    revision,
  }
}

const parseNativeLink = (native: unknown): NativeLink | undefined => {
  if (native === undefined) return undefined
  if (
    !isRecord(native) ||
    typeof native.id !== 'string' ||
    native.id.length === 0 ||
    (native.status !== 'pending' && native.status !== 'linked') ||
    (native.status === 'linked' && typeof native.token !== 'string') ||
    (native.opacity !== undefined &&
      (typeof native.opacity !== 'number' ||
        !Number.isFinite(native.opacity) ||
        native.opacity < 0 ||
        native.opacity > 1))
  )
    throw new RangeError('native template link is invalid')
  return native as unknown as NativeLink
}

const parseOwns = (owns: unknown, appearance: unknown): readonly AppearanceGroup[] => {
  // "It has an appearance, so it chose one" holds for a record written by this model. A record
  // from before it carries `shape`, and every template got one whether or not anyone touched it,
  // so reading that as a deliberate choice would detach it from the global sliders for good.
  if (owns === undefined) return appearance == null ? [] : legacyAppearanceGroups(appearance)
  const groups: readonly unknown[] = APPEARANCE_GROUPS
  if (
    !Array.isArray(owns) ||
    owns.some((group) => !groups.includes(group)) ||
    new Set(owns).size !== owns.length
  ) {
    throw new RangeError('template appearance ownership is invalid')
  }
  return owns
}

/** Parse a stored record's metadata, throwing a RangeError when it is invalid. */
export const parseStoredMetadata = (value: unknown): LocalRecord => {
  if (!isRecord(value)) throw new RangeError('template record is not an object')
  const core = parseStoredCore(value)
  const { folderId, updatedAt, appearance, authoring: rawAuthoring } = value
  if (folderId !== undefined && folderId !== null && typeof folderId !== 'string') {
    throw new RangeError('template folder is invalid')
  }
  const native = parseNativeLink(value.native)
  const owns = parseOwns(value.owns, appearance)
  const authoring = storedAuthoring(rawAuthoring, core)
  if (rawAuthoring !== undefined && authoring === null)
    warn('install', `dropping unreadable source and recipe of ${core.name}`)
  return {
    origin: 'local',
    ...(native === undefined ? {} : { native }),
    ...core,
    folderId: typeof folderId === 'string' ? folderId : null,
    ...(typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt >= 0
      ? { updatedAt }
      : {}),
    appearance: normaliseAppearance(appearance),
    owns,
    ...(authoring === null ? {} : { authoring }),
  }
}

/** Parse a hydrated record, whose pixels must fill its box, throwing a RangeError when invalid. */
export const parseStoredTemplate = (value: unknown): LocalRecord & StoredTemplate => {
  const metadata = parseStoredMetadata(value)
  // Hydration built these from the stored bytes; only their size can disagree with the record.
  const pixels = isRecord(value) ? (value.pixels as SparsePixels | undefined) : undefined
  if (pixels?.width !== metadata.width || pixels.height !== metadata.height) {
    throw new RangeError('template pixels are invalid')
  }
  return { ...metadata, pixels }
}

/** A hydrated record, or null when it is invalid. */
export const storedTemplateOrNull = (value: unknown): (LocalRecord & StoredTemplate) | null => {
  try {
    return parseStoredTemplate(value)
  } catch {
    return null
  }
}
