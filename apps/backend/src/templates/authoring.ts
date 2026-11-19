import {
  decodePng,
  decodeWplaceIndexedPng,
  encodeIndexedPng,
  MAX_TEMPLATE_SOURCE_BYTES,
  MAX_TIMELAPSE_CAPTURE_TILES,
  millis,
  PALETTE_SIZE,
  type PixelBounds,
  PngError,
  pngSize,
  type QuantiseReport,
  quantiseToPalette,
  SliceError,
  type SurfaceChunkKey,
  sha256Hex,
  sliceTemplateForSurface,
  type TemplateRecipe,
  type TemplateSurface,
  TRANSPARENT_INDEX,
  tileKey,
  timelapseCaptureTileCount,
  uuidV7,
} from '@caelestis/shared'
import { assertSameScope, InvalidNodeParentError, type NodeStore } from '../nodes/store.js'
import type { BlobStore } from '../ports/index.js'
import { PortError } from '../runtime/errors.js'
import {
  assertSameTemplate,
  TemplateNotFoundError,
  type TemplateStore,
  type TemplateVersionRecord,
} from './store.js'

/** One upload of pixels, placed at an origin on `surface`. */
export interface TemplatePixelsInput {
  readonly surface: TemplateSurface
  readonly createdWithToken: string
  /** The uploader's wplace account when the client presented one; null for a server-side upload. */
  readonly createdByUserId: number | null
  readonly originX: number
  readonly originY: number
  readonly png: Uint8Array
  /** The original PNG and the recipe the client used to turn it into `png`. */
  readonly authoring?: TemplateAuthoringInput
}

/** A new template: where it lives and what it is called, with its first pixels. */
export interface NewTemplateInput extends TemplatePixelsInput {
  readonly season: number
  readonly nodeId: string | null
  readonly name: string
}

export interface TemplateAuthoringInput {
  readonly source: Uint8Array
  readonly recipe: TemplateRecipe
}

export interface StoredTemplate {
  readonly templateId: string
  readonly versionId: string
  readonly bbox: PixelBounds
  readonly totalPixels: number
  readonly chunks: readonly { readonly tile: SurfaceChunkKey; readonly hash: string }[]
  readonly report: QuantiseReport
  readonly published: boolean
}

/**
 * Tiles one upload may cover.
 *
 * Every chunk costs an R2 HEAD, an R2 PUT, a compression and a share of a D1 batch statement, so the
 * bound is on the pipeline rather than on the image: 400 tiles is a 400,000-pixel span in one
 * dimension, far beyond a placed template.
 *
 * The number comes from the Workers Free plan's 1,000 internal subrequests, which R2 and D1 binding
 * calls both count against. `hasAll` is one HEAD per distinct hash, because R2 has no bulk existence
 * operation, and a first upload has no hash already present — so the worst case is 400 HEADs, 400
 * PUTs and roughly twenty batch statements, a little over 800. At 512 the same upload would ask for
 * more than a thousand and fail after writing part of its chunks, orphaning those.
 */
const MAX_TEMPLATE_CHUNKS = 400

/** An upload the pipeline refuses for a reason the client can act on — answered as 400, not 500. */
export class StoreTemplateError extends PortError {
  override readonly name = 'StoreTemplateError'
  readonly kind = 'invalid'
}

/** Pixels that do not decode or slice are the uploader's to fix, so refuse them as such. */
const refuseUnreadable = async <A>(read: () => Promise<A>): Promise<A> => {
  try {
    return await read()
  } catch (error) {
    if (error instanceof PngError || error instanceof SliceError)
      throw new StoreTemplateError(error.message)
    throw error
  }
}

const exactPaletteReport = (indices: Uint8Array): QuantiseReport => {
  let opaquePixels = 0
  const used = new Set<number>()
  for (const index of indices) {
    if (index === TRANSPARENT_INDEX) continue
    opaquePixels += 1
    used.add(index)
  }
  return {
    opaquePixels,
    movedPixels: 0,
    distinctColours: used.size,
    distinctPaletteEntries: used.size,
    meanDistance: 0,
    maxDistance: 0,
  }
}

const colourTotals = (
  indices: Uint8Array,
): readonly { readonly index: number; readonly total: number }[] => {
  const totals = new Array<number>(PALETTE_SIZE).fill(0)
  for (const index of indices) {
    if (index !== TRANSPARENT_INDEX) totals[index] = (totals[index] ?? 0) + 1
  }
  return [...totals.entries()]
    .filter(([, total]) => total > 0)
    .map(([index, total]) => ({ index, total }))
}

/**
 * Refuse authoring that does not describe these pixels. The server cannot rerun the processor, so
 * it checks everything it can: the source bytes, their size, and the output size.
 */
const checkAuthoring = async (
  authoring: TemplateAuthoringInput,
  width: number,
  height: number,
): Promise<void> => {
  const { source, recipe } = authoring
  if (source.byteLength > MAX_TEMPLATE_SOURCE_BYTES)
    throw new StoreTemplateError('source image is too large to keep')
  if ((await sha256Hex(source)) !== recipe.source.sha256)
    throw new StoreTemplateError('source image does not match its recipe')
  const size = pngSize(source)
  if (size.width !== recipe.source.width || size.height !== recipe.source.height)
    throw new StoreTemplateError('source image size does not match its recipe')
  if (recipe.width !== width || recipe.height !== height)
    throw new StoreTemplateError(`recipe output is not ${width}x${height}`)
}

/** Decode, check and slice an upload, refusing what the pipeline cannot store. Writes nothing. */
const sliceUpload = async (input: TemplatePixelsInput) => {
  const { indices, report, sliced } = await refuseUnreadable(async () => {
    const decoded = (await decodeWplaceIndexedPng(input.png)) ?? (await decodePng(input.png))
    const { width, height } = decoded
    if (input.authoring !== undefined) await checkAuthoring(input.authoring, width, height)
    const { indices, report } =
      'indices' in decoded
        ? { indices: decoded.indices, report: exactPaletteReport(decoded.indices) }
        : quantiseToPalette(decoded.pixels)
    const sliced = sliceTemplateForSurface(
      indices,
      width,
      height,
      input.originX,
      input.originY,
      input.surface,
    )
    return { indices, report, sliced }
  })
  // Bound the storage work, not the image area. A 1,999,000x2 image slices to ~4,000 chunks: ~170
  // batch statements against D1's 50 per invocation, ~8,000 R2 subrequests against a limit of 1,000,
  // and 4,000 concurrent compressions — from an upload a few kilobytes long, because two rows of one
  // colour deflate to nothing. A large template covering an ordinary number of tiles remains valid.
  if (sliced.chunks.length > MAX_TEMPLATE_CHUNKS) {
    throw new StoreTemplateError(
      `template covers ${sliced.chunks.length} tiles, more than the ${MAX_TEMPLATE_CHUNKS} one upload may carry`,
    )
  }
  if (input.surface.kind === 'world') {
    const captureTiles = timelapseCaptureTileCount(sliced.bbox)
    if (captureTiles > MAX_TIMELAPSE_CAPTURE_TILES) {
      throw new StoreTemplateError(
        `template timelapse covers ${captureTiles.toLocaleString()} tiles, more than the ${MAX_TIMELAPSE_CAPTURE_TILES.toLocaleString()} one viewer may load`,
      )
    }
  }
  return { indices, report, sliced }
}

type SlicedUpload = Awaited<ReturnType<typeof sliceUpload>>

/**
 * Store the chunk and source blobs of a sliced upload, and describe them as a new version of
 * `templateId`. Blobs land before any version row, so no version can name a missing blob.
 */
const uploadVersion = async (
  blobs: BlobStore,
  templateId: string,
  input: TemplatePixelsInput,
  { indices, sliced }: SlicedUpload,
): Promise<TemplateVersionRecord> => {
  const encodedChunks = await Promise.all(
    sliced.chunks.map(async (chunk) => {
      const png = await encodeIndexedPng(chunk.width, chunk.height, chunk.indices)
      return { chunk, png, hash: await sha256Hex(png) }
    }),
  )

  // Several tiles can contain the same cropped image. Content addressing means one upload per
  // distinct hash is enough even when the version index refers to that hash more than once.
  const pngByHash = new Map(encodedChunks.map(({ hash, png }) => [hash, png]))
  const present = await blobs.hasAll('chunks', [...pngByHash.keys()])
  await Promise.all(
    [...pngByHash].map(async ([hash, png]) => {
      if (!present.has(hash)) await blobs.put('chunks', hash, png)
    }),
  )
  if (input.authoring !== undefined) {
    const { source, recipe } = input.authoring
    const hash = recipe.source.sha256
    if (!(await blobs.hasAll('sources', [hash])).has(hash)) await blobs.put('sources', hash, source)
  }
  return {
    templateId,
    surface: input.surface,
    versionId: uuidV7(),
    createdWithToken: input.createdWithToken,
    createdByUserId: input.createdByUserId,
    createdAt: millis(Date.now()),
    bbox: sliced.bbox,
    totalPixels: sliced.totalPixels,
    colourTotals: colourTotals(indices),
    chunks: encodedChunks.map(({ chunk, hash }) => ({
      tileX: chunk.tileX,
      tileY: chunk.tileY,
      hash,
    })),
    ...(input.authoring === undefined ? {} : { recipe: input.authoring.recipe }),
  }
}

/** What the caller learns about a version once it is current. */
const storedTemplate = async (
  sql: TemplateStore,
  version: TemplateVersionRecord,
  report: QuantiseReport,
): Promise<StoredTemplate> => {
  const installed = await sql.readTemplate(version.templateId)
  if (installed === null) {
    throw new TemplateNotFoundError(`template does not exist: ${version.templateId}`)
  }
  return {
    templateId: version.templateId,
    versionId: version.versionId,
    bbox: version.bbox,
    totalPixels: version.totalPixels,
    chunks: version.chunks.map(({ tileX, tileY, hash }) => ({
      tile: tileKey({ x: tileX, y: tileY }),
      hash,
    })),
    report,
    published: installed.published,
  }
}

/** Mint a template from its first upload. */
export const createStoredTemplate = async (
  blobs: BlobStore,
  sql: NodeStore & TemplateStore,
  input: NewTemplateInput,
): Promise<StoredTemplate> => {
  if (input.nodeId !== null) {
    const node = await sql.readNode(input.nodeId)
    // The folder is the template's parent: naming one that is missing is bad input.
    if (node === null) throw new InvalidNodeParentError(`node does not exist: ${input.nodeId}`)
    assertSameScope(node, input, 'destination node')
  }
  const upload = await sliceUpload(input)
  const version = await uploadVersion(blobs, uuidV7(), input, upload)
  await sql.createTemplate({
    ...version,
    season: input.season,
    nodeId: input.nodeId,
    name: input.name,
  })
  return storedTemplate(sql, version, upload.report)
}

/**
 * Re-slice and re-upload an existing template's pixels as a fresh current version. The template's
 * own row keeps its name, parent, published state and creation date.
 */
export const replaceStoredTemplate = async (
  blobs: BlobStore,
  sql: TemplateStore,
  templateId: string,
  input: TemplatePixelsInput,
): Promise<StoredTemplate> => {
  const upload = await sliceUpload(input)
  const existing = await sql.readTemplate(templateId)
  if (existing === null) {
    throw new TemplateNotFoundError(`template does not exist: ${templateId}`)
  }
  let currentBbox: PixelBounds | null = null
  if (existing.currentVersionId !== null) {
    const current = await sql.readTemplateVersion(existing.currentVersionId)
    if (current === null) {
      throw new TemplateNotFoundError(
        `current version does not exist: ${existing.currentVersionId}`,
      )
    }
    currentBbox = current.bbox
  }
  assertSameTemplate(
    templateId,
    { surface: existing.surface, bbox: currentBbox },
    { surface: input.surface, bbox: upload.sliced.bbox },
  )
  const version = await uploadVersion(blobs, templateId, input, upload)
  await sql.addTemplateVersion(version)
  return storedTemplate(sql, version, upload.report)
}
