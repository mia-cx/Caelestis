import {
  isSha256Hex,
  type Millis,
  PALETTE_SIZE,
  type PixelBounds,
  parseTemplateRecipe,
  sameTemplateSurface,
  type TemplateRecipe,
  type TemplateSurface,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  templateSizeChange,
  templateSurface,
  templateSurfaceBounds,
  WORLD_PIXELS,
  WORLD_TILES,
} from '@caelestis/shared'
import type { DrawingScope } from '../db/scope.js'
import { PortError } from '../runtime/errors.js'

/** One immutable set of a template's pixels, sliced for `surface`. */
export interface TemplateVersionRecord {
  readonly templateId: string
  readonly surface: TemplateSurface
  readonly versionId: string
  /**
   * Who uploaded this — the digest of the access token used, and the wplace `/me` id of the account
   * that used it when the client presented one. The account is optional here and mandatory on the
   * reporter columns, because quorum counts distinct accounts while authorship only has to name the
   * credential that acted: a server-side admin upload has a token and no wplace session.
   */
  readonly createdWithToken: string
  readonly createdByUserId: number | null
  /** Used for both rows when the template is new; existing templates retain their original date. */
  readonly createdAt: Millis
  readonly bbox: PixelBounds
  readonly totalPixels: number
  /** Histogram for server-backed per-colour progress; absent on versions stored before it was. */
  readonly colourTotals?: readonly { readonly index: number; readonly total: number }[]
  readonly chunks: readonly {
    readonly tileX: number
    readonly tileY: number
    readonly hash: string
  }[]
  /**
   * How the uploading client produced these chunks. The original PNG is in the `sources` blob
   * namespace under `recipe.source.sha256`. Absent on processed-only uploads.
   */
  readonly recipe?: TemplateRecipe
}

/** A template to create, with its first version. */
export interface NewTemplateRecord extends TemplateVersionRecord {
  readonly season: number
  readonly nodeId: string | null
  readonly name: string
}

/** A template's own row: what it is called and where it sits, with no pixels attached. */
export interface TemplateRecord {
  readonly id: string
  readonly surface: TemplateSurface
  readonly season: number
  readonly nodeId: string | null
  readonly name: string
  readonly currentVersionId: string | null
  readonly published: boolean
  /** Frozen timelapses are exempt from decay through their freeze instant. */
  readonly timelapseFrozen: boolean
  readonly timelapseFrozenAt: Millis | null
  readonly finished: boolean
  readonly finishedAt: Millis | null
  readonly createdAt: Millis
  readonly updatedAt: Millis
}

/** The exact source revision an administrator confirmed before a destructive delete. */
export interface TemplateDeletePrecondition {
  readonly versionId: string
  readonly updatedAt: Millis
}

export interface ManifestTemplateRecord {
  readonly id: string
  readonly nodeId: string | null
  readonly name: string
  readonly versionId: string
  readonly bbox: PixelBounds
  readonly totalPixels: number
  readonly published: boolean
  readonly finished: boolean
  readonly finishedAt: Millis | null
  readonly timelapseFrozen: boolean
  readonly createdAt: Millis
  readonly updatedAt: Millis
}

export interface ManifestTileRecord {
  readonly templateId: string
  readonly versionId: string
  readonly tileX: number
  readonly tileY: number
  readonly hash: string
}

/**
 * What a template edit may change, beside its pixels.
 *
 * Pixels are not here on purpose: replacing them is `addTemplateVersion`, which mints a new version
 * id and a new chunk index. Everything in this patch leaves the chunks exactly where they are, which
 * is the whole reason `updatedAt` exists alongside the version.
 *
 * An absent field is "leave it alone", which is why every one is optional rather than nullable —
 * neither a name nor a publication state uses null as "leave alone". A null parent explicitly
 * places the template at the server root; absence leaves the parent alone.
 */
export interface TemplatePatch {
  readonly name?: string
  /** Moving to another node, or to the server root with null. */
  readonly nodeId?: string | null
  /** Null unpublishes; absent leaves publication alone. */
  readonly publishedAt?: Millis | null
  /** Null thaws; absent leaves the freeze alone. */
  readonly timelapseFrozenAt?: Millis | null
  /** Null reopens; a timestamp finishes; absent leaves the lifecycle alone. */
  readonly finishedAt?: Millis | null
}

export class TemplateNotFoundError extends PortError {
  override readonly name = 'TemplateNotFoundError'
  readonly kind = 'not-found'
}

/**
 * A new version of an existing template that is not a version of the same thing: another surface,
 * or other dimensions (see `templateSizeChange`).
 *
 * The bounds compared are the *painted extent*, which `sliceTemplate` derives from non-transparent
 * pixels rather than from the image rectangle, so editing artwork at its outer edge is refused as a
 * different template.
 */
export class TemplateIdentityError extends PortError {
  override readonly name = 'TemplateIdentityError'
  readonly kind = 'conflict'
}

/**
 * Refuse `next` as a new version of template `templateId` unless it keeps the template's surface
 * and dimensions. `existing.bbox` is the current version's, or null before the template has one.
 * The uploader checks before storing blobs, so a refusal leaves none behind; the store checks again
 * inside the write against what a concurrent upload may have changed.
 */
export const assertSameTemplate = (
  templateId: string,
  existing: { readonly surface: TemplateSurface; readonly bbox: PixelBounds | null },
  next: { readonly surface: TemplateSurface; readonly bbox: PixelBounds },
): void => {
  if (!sameTemplateSurface(existing.surface, next.surface))
    throw new TemplateIdentityError(
      `template ${templateId} belongs to ${existing.surface.kind}, not ${next.surface.kind}`,
    )
  if (existing.bbox === null) return
  const resized = templateSizeChange(next.surface, existing.bbox, next.bbox)
  if (resized !== null) throw new TemplateIdentityError(`template ${templateId} ${resized}`)
}

/**
 * The domain the `templates`, `template_versions` and `version_tiles` CHECKs enforce, checked first
 * so a malformed version fails with a named reason instead of a constraint error.
 */
export const assertValidTemplateVersion = (version: TemplateVersionRecord): void => {
  const fail = (reason: string): never => {
    throw new Error(`template version ${version.versionId} rejected: ${reason}`)
  }
  if (templateSurface(version.surface.kind, version.surface.allianceId) === null) {
    fail(`surface ${version.surface.kind}/${version.surface.allianceId} is invalid`)
  }
  if (!isSha256Hex(version.createdWithToken))
    fail(`createdWithToken ${version.createdWithToken} is not a sha256 digest`)
  if (
    version.createdByUserId !== null &&
    (!Number.isSafeInteger(version.createdByUserId) || version.createdByUserId < 0)
  ) {
    fail(`createdByUserId ${version.createdByUserId} is not a non-negative integer`)
  }
  const { minX, minY, maxX, maxY } = version.bbox
  if (![minX, minY, maxX, maxY, version.totalPixels].every(Number.isSafeInteger)) {
    fail('bounding box and total pixels must be integers')
  }
  const surfaceBounds = templateSurfaceBounds(version.surface)
  if (surfaceBounds === null) {
    // World x wraps through zero, so minX may exceed maxX; y does not.
    if (minX < 0 || minX >= WORLD_PIXELS || minY < 0 || minY >= WORLD_PIXELS) {
      fail('bounding box minimum is outside the canvas')
    }
    if (maxX < 1 || maxX > WORLD_PIXELS || maxY < 1 || maxY > WORLD_PIXELS) {
      fail('bounding box maximum is outside the canvas')
    }
    if (minX === maxX || minY >= maxY) fail('bounding box covers no pixels')
  } else if (
    minX < surfaceBounds.minX ||
    minY < surfaceBounds.minY ||
    maxX > surfaceBounds.maxX ||
    maxY > surfaceBounds.maxY ||
    minX >= maxX ||
    minY >= maxY
  ) {
    fail('bounding box is outside its alliance surface')
  }
  if (version.totalPixels < 0) fail('total pixels is negative')
  if (version.colourTotals !== undefined) {
    const indices = new Set<number>()
    let total = 0
    for (const colour of version.colourTotals) {
      if (
        !Number.isSafeInteger(colour.index) ||
        colour.index < 0 ||
        colour.index >= PALETTE_SIZE ||
        colour.index === TRANSPARENT_INDEX ||
        indices.has(colour.index) ||
        !Number.isSafeInteger(colour.total) ||
        colour.total <= 0
      ) {
        fail('colour totals contain an invalid or duplicate palette entry')
      }
      indices.add(colour.index)
      total += colour.total
    }
    if (total !== version.totalPixels) fail('colour totals do not sum to total pixels')
  }
  if (version.recipe !== undefined && parseTemplateRecipe(version.recipe) === null)
    fail('recipe is not a valid template recipe')
  const minTile =
    surfaceBounds === null
      ? { x: 0, y: 0 }
      : {
          x: Math.floor(surfaceBounds.minX / TILE_SIZE),
          y: Math.floor(surfaceBounds.minY / TILE_SIZE),
        }
  const maxTile =
    surfaceBounds === null
      ? { x: WORLD_TILES - 1, y: WORLD_TILES - 1 }
      : {
          x: Math.floor((surfaceBounds.maxX - 1) / TILE_SIZE),
          y: Math.floor((surfaceBounds.maxY - 1) / TILE_SIZE),
        }
  for (const chunk of version.chunks) {
    if (
      !Number.isSafeInteger(chunk.tileX) ||
      !Number.isSafeInteger(chunk.tileY) ||
      chunk.tileX < minTile.x ||
      chunk.tileX > maxTile.x ||
      chunk.tileY < minTile.y ||
      chunk.tileY > maxTile.y
    ) {
      fail(`chunk tile ${chunk.tileX}/${chunk.tileY} is outside the canvas`)
    }
    if (!isSha256Hex(chunk.hash)) fail(`chunk hash ${chunk.hash} is not a sha256 digest`)
  }
}

/** Templates, their versions and tile indexes, and the manifest reads over them. */
export interface TemplateStore {
  /**
   * Create a template with its first version, tile index, and current-version pointer, atomically.
   * Throws `NodeNotFoundError` or `InvalidNodeParentError` when `template.nodeId` names a node that
   * is missing or on another season or surface.
   */
  createTemplate(template: NewTemplateRecord): Promise<void>

  /**
   * Make `version` the current version of its existing template, atomically. The template keeps
   * its name, folder, season and publication. Throws `TemplateNotFoundError` when the template is
   * gone and `TemplateIdentityError` when the version is on another surface or of other dimensions
   * than the one it replaces.
   */
  addTemplateVersion(version: TemplateVersionRecord): Promise<void>

  /** A version with its complete tile index, or null if absent. */
  readTemplateVersion(versionId: string): Promise<TemplateVersionRecord | null>

  /**
   * Whether any version of a published template names this chunk or source hash. Blobs are
   * content-addressed and outlive unpublishing, so this is what keeps a draft's pixels admin-only.
   */
  isPublishedArtwork(namespace: 'chunks' | 'sources', hash: string): Promise<boolean>

  /** Artwork revisions in creation order, so a template's observations survive pixel replacements. */
  listTemplateVersions(
    templateId: string,
  ): Promise<readonly Pick<TemplateVersionRecord, 'versionId' | 'createdAt'>[]>

  /**
   * A template's own row, without a version or a tile index: what "does this exist, and where does
   * it live" needs, without reading the chunk index `readTemplateVersion` returns.
   */
  readTemplate(templateId: string): Promise<TemplateRecord | null>

  /**
   * Apply `patch` to a template. Returns false when the id does not exist, when a guarded move
   * loses a race with another move or delete, or when a thaw that does not also reopen the
   * template finds it finished. A caller that distinguishes those outcomes must re-read the row.
   *
   * A template is a leaf with no materialized path, so moving one is a single column. Throws
   * `NodeNotFoundError` when the destination node does not exist, so a typo cannot orphan a
   * template into a node nobody can navigate to.
   */
  updateTemplate(templateId: string, patch: TemplatePatch, updatedAt: Millis): Promise<boolean>

  /**
   * Delete a template with every version and tile index it owns. Returns false if it is absent or
   * no longer matches the revision the caller confirmed.
   *
   * **Chunks are deliberately left behind.** They are content-addressed and shared: two templates
   * with the same region, or two versions of one template that differ elsewhere, refer to the same
   * blob. Reclaiming storage is a sweep over hashes no version references, a separate job.
   */
  deleteTemplate(templateId: string, expected: TemplateDeletePrecondition): Promise<boolean>

  listManifestTemplates(
    scope: DrawingScope,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTemplateRecord[]>

  listManifestTiles(
    scope: DrawingScope,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTileRecord[]>

  /**
   * The subset of `ids` that name published templates, in input order with duplicates dropped.
   *
   * The publish gate for reads that take raw template ids and do not go through the manifest. An
   * id that names nothing is dropped silently: to a non-admin caller, missing and unpublished are
   * deliberately the same answer. Rejects more than `MAX_IDS_PER_READ` distinct ids.
   */
  filterPublishedTemplateIds(ids: readonly string[]): Promise<readonly string[]>
}
