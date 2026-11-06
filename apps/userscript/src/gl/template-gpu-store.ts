import { PALETTE_SIZE } from '@caelestis/shared'
import {
  isProfileEnabled,
  measureProfileDetail,
  profileWindowId,
  recordProfileCounter,
  recordProfileWorkload,
} from '../profile.js'
import type { PlacedTemplate, TemplateArtwork } from '../templates/local-store.js'
import { pixelRect, type SparsePixels } from '../templates/sparse-pixels.js'
import { gpuCacheEvictions } from './gpu-cache.js'
import { TEXTURE_HALO } from './shaders.js'

export const TEMPLATE_GPU_CACHE_BYTES = 64 * 1024 * 1024
export const TEMPLATE_UPLOAD_PIXELS_PER_FRAME = 512 * 1024

/** Where a texture sits in its template, and which of its sides no other texture continues. */
interface GpuTilePlacement {
  /** Top-left and size of the non-halo source cells in template coordinates. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly textureWidth: number
  readonly textureHeight: number
  readonly inset: number
  /**
   * Sides with no texture beyond them: the template's edges, and edges of chunks left out for being
   * transparent. An outline drawn around pixels on such a side falls on cells nobody else draws, so
   * the renderer extends the quad over them.
   */
  readonly openLeft: boolean
  readonly openTop: boolean
  readonly openRight: boolean
  readonly openBottom: boolean
  /**
   * Which corners a diagonal texture touches: up-left, up-right, down-left, down-right. The
   * diagonal's top or bottom halo strip also covers the end cells of this texture's side strip
   * there, so the side strip leaves them to it and no outline blends twice.
   */
  readonly diagonals: readonly [boolean, boolean, boolean, boolean]
}

export interface TemplateGpuTile extends GpuTilePlacement {
  readonly texture: WebGLTexture
}

interface UploadingTile extends GpuTilePlacement {
  texture: WebGLTexture | null
  uploadedPixels: number
}

/** The chunks of one entry still on their way to the GPU. */
interface TemplateGpuUpload {
  /** Age is observed only while profiling; a pre-existing queue starts at its first profiled advance. */
  observedAt: number | null
  profileWindow: number | null
  /** Unfinished chunks in plan order; each leaves for its entry's `indices` once fully uploaded. */
  readonly queue: UploadingTile[]
  /** Held only while uploading; a finished entry keeps no CPU copy of the pixels. */
  readonly pixels: SparsePixels
}

export interface TemplateGpuEntry {
  /** Fully uploaded chunks only. While an upload is in progress, the rest arrive here as they finish. */
  readonly indices: readonly TemplateGpuTile[]
  readonly palette: WebGLTexture
  readonly width: number
  readonly height: number
  /** The artwork uploaded. Textures stay valid while the template's pixels are evicted. */
  readonly source: TemplateArtwork
  lastUsed: number
  paletteData: Uint8Array | null
}

/** A rectangle in template coordinates. */
export interface TemplateRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface TemplateGpuAdvance {
  /** What can be drawn now: every chunk when complete, the finished ones while pending. */
  readonly entry: TemplateGpuEntry | null
  readonly status: 'complete' | 'pending' | 'failed'
  readonly uploadedPixels: number
}

type TemplateSource = Pick<PlacedTemplate, 'id' | 'width' | 'height' | 'artwork'>

interface GrowingTemplateGpuEntry extends TemplateGpuEntry {
  readonly indices: TemplateGpuTile[]
}

interface StoredTemplateGpu {
  readonly entry: GrowingTemplateGpuEntry
  /** Null once every chunk has reached the entry. */
  upload: TemplateGpuUpload | null
}

const textureBytes = (tiles: readonly GpuTilePlacement[]): number =>
  tiles.reduce((total, tile) => total + tile.textureWidth * tile.textureHeight, 0)

const storedBytes = ({ entry, upload }: StoredTemplateGpu): number =>
  PALETTE_SIZE * 4 +
  textureBytes(entry.indices) +
  (upload === null ? 0 : textureBytes(upload.queue))

const isCurrent = (entry: TemplateGpuEntry, template: TemplateSource): boolean =>
  entry.source === template.artwork &&
  entry.width === template.width &&
  entry.height === template.height

const overlaps = (tile: TemplateRect, rects: readonly TemplateRect[]): boolean =>
  rects.some(
    (rect) =>
      rect.x < tile.x + tile.width &&
      tile.x < rect.x + rect.width &&
      rect.y < tile.y + tile.height &&
      tile.y < rect.y + rect.height,
  )

/**
 * Owns palette-index textures for one WebGL context.
 *
 * Both renderer adapters use this module. It hides device-sized chunking, outline halos,
 * progressive uploads, source replacement, and bounded warm caching behind one interface.
 */
export class TemplateGpuStore {
  private readonly stored = new Map<string, StoredTemplateGpu>()
  private readonly maximumTextureSize: number | null

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly maximumBytes = TEMPLATE_GPU_CACHE_BYTES,
  ) {
    let measured: unknown = null
    try {
      measured = gl.getParameter(gl.MAX_TEXTURE_SIZE)
    } catch {}
    this.maximumTextureSize =
      typeof measured === 'number' && Number.isFinite(measured) && measured > 0
        ? Math.max(1, Math.floor(measured))
        : null
  }

  memoryBytes(): number {
    let bytes = 0
    for (const stored of this.stored.values()) bytes += storedBytes(stored)
    return bytes
  }

  /** The drawable entry, possibly still uploading; see `TemplateGpuEntry.indices`. */
  entry(id: string): TemplateGpuEntry | null {
    return this.stored.get(id)?.entry ?? null
  }

  /** Whether the template's current artwork is fully uploaded. */
  hasCurrent(template: TemplateSource): boolean {
    const stored = this.stored.get(template.id)
    return stored !== undefined && stored.upload === null && isCurrent(stored.entry, template)
  }

  /**
   * Point the entry's palette texture at `data`, uploading only a palette it does not hold yet.
   *
   * Palettes are compared by identity, so callers never mutate one they have passed in. The render
   * scene keeps a palette's array until its bytes change.
   */
  uploadPalette(entry: TemplateGpuEntry, data: Uint8Array): void {
    if (entry.paletteData === data) return
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, entry.palette)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, PALETTE_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
    recordProfileCounter('gpu:palette upload bytes', data.byteLength)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    entry.paletteData = data
  }

  private textureLimit(width: number, height: number): number {
    return this.maximumTextureSize ?? Math.max(width, height) + 2
  }

  /** Textures for the painted chunks only, each split further if the device cannot hold it. */
  private plan(pixels: SparsePixels): UploadingTile[] {
    const rects: { x: number; y: number; width: number; height: number; inset: number }[] = []
    for (const chunk of pixels.chunks.values()) {
      const allocationLimit = this.textureLimit(chunk.width, chunk.height)
      const inset = allocationLimit > TEXTURE_HALO * 2 ? TEXTURE_HALO : 0
      const contentLimit = Math.max(1, allocationLimit - inset * 2)
      for (let y = chunk.y; y < chunk.y + chunk.height; y += contentLimit) {
        const height = Math.min(contentLimit, chunk.y + chunk.height - y)
        for (let x = chunk.x; x < chunk.x + chunk.width; x += contentLimit) {
          rects.push({
            x,
            y,
            width: Math.min(contentLimit, chunk.x + chunk.width - x),
            height,
            inset,
          })
        }
      }
    }
    // Chunks share one grid, so a neighbour continues a side exactly when it starts where it ends.
    const starts = new Set(rects.map(({ x, y }) => `${x},${y}`))
    const rightEdges = new Set(rects.map(({ x, y, width }) => `${x + width},${y}`))
    const bottomEdges = new Set(rects.map(({ x, y, height }) => `${x},${y + height}`))
    const bottomRights = new Set(
      rects.map(({ x, y, width, height }) => `${x + width},${y + height}`),
    )
    return rects.map(({ x, y, width, height, inset }) => ({
      texture: null,
      x,
      y,
      width,
      height,
      textureWidth: width + inset * 2,
      textureHeight: height + inset * 2,
      inset,
      openLeft: !rightEdges.has(`${x},${y}`),
      openTop: !bottomEdges.has(`${x},${y}`),
      openRight: !starts.has(`${x + width},${y}`),
      openBottom: !starts.has(`${x},${y + height}`),
      // Without a halo there are no side strips to yield.
      diagonals: [
        inset > 0 && bottomRights.has(`${x},${y}`),
        inset > 0 && bottomEdges.has(`${x + width},${y}`),
        inset > 0 && rightEdges.has(`${x},${y + height}`),
        inset > 0 && starts.has(`${x + width},${y + height}`),
      ],
      uploadedPixels: 0,
    }))
  }

  private allocate(texture: WebGLTexture, width: number, height: number): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8UI,
      width,
      height,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      null,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  private fill(
    upload: TemplateGpuUpload,
    tile: UploadingTile,
    uploadX: number,
    uploadY: number,
    uploadWidth: number,
    uploadHeight: number,
  ): Uint8Array {
    // The halo reads into neighbouring chunks, and reads transparent past the template's edges.
    return pixelRect(
      upload.pixels,
      tile.x - tile.inset + uploadX,
      tile.y - tile.inset + uploadY,
      uploadWidth,
      uploadHeight,
    )
  }

  /**
   * Spend up to `allowance` pixels on the queue, chunks overlapping `visible` first, and hand each
   * chunk to the entry the moment its texture is whole. A texture is never drawn half-filled.
   */
  private advanceUpload(
    entry: GrowingTemplateGpuEntry,
    upload: TemplateGpuUpload,
    allowance: number,
    visible: readonly TemplateRect[],
  ): { readonly uploadedPixels: number; readonly failed: boolean } {
    const gl = this.gl
    let left = Math.max(0, Math.floor(allowance))
    let uploadedPixels = 0
    while (left > 0 && upload.queue.length > 0) {
      // The first visible chunk, else the next in plan order.
      const at = Math.max(
        0,
        upload.queue.findIndex((tile) => overlaps(tile, visible)),
      )
      const tile = upload.queue[at] as UploadingTile
      const total = tile.textureWidth * tile.textureHeight
      const texture = tile.texture ?? gl.createTexture()
      if (texture === null) return { uploadedPixels, failed: true }
      if (tile.texture === null) {
        tile.texture = texture
        measureProfileDetail('Overlay texture allocation', () =>
          this.allocate(texture, tile.textureWidth, tile.textureHeight),
        )
      }
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      while (tile.uploadedPixels < total && left > 0) {
        const uploadY = Math.floor(tile.uploadedPixels / tile.textureWidth)
        const uploadX = tile.uploadedPixels - uploadY * tile.textureWidth
        const uploadWidth =
          uploadX === 0 && left >= tile.textureWidth
            ? tile.textureWidth
            : Math.min(tile.textureWidth - uploadX, left)
        const uploadHeight =
          uploadX === 0 && uploadWidth === tile.textureWidth
            ? Math.min(tile.textureHeight - uploadY, Math.max(1, Math.floor(left / uploadWidth)))
            : 1
        const count = uploadWidth * uploadHeight
        const pixels = measureProfileDetail('Overlay index staging', () =>
          this.fill(upload, tile, uploadX, uploadY, uploadWidth, uploadHeight),
        )
        measureProfileDetail('Overlay index upload', () =>
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            uploadX,
            uploadY,
            uploadWidth,
            uploadHeight,
            gl.RED_INTEGER,
            gl.UNSIGNED_BYTE,
            pixels,
          ),
        )
        tile.uploadedPixels += count
        recordProfileCounter('gpu:index upload bytes', pixels.byteLength)
        uploadedPixels += count
        left -= count
      }
      if (tile.uploadedPixels < total) break
      upload.queue.splice(at, 1)
      const { uploadedPixels: _uploaded, texture: _pending, ...placement } = tile
      entry.indices.push({ ...placement, texture })
    }
    return { uploadedPixels, failed: false }
  }

  /**
   * Upload up to `allowance` more pixels of the template and return what can be drawn.
   *
   * `visible` lists the parts of the template on screen, in template coordinates; chunks touching
   * them upload before the rest. A pending result still carries every chunk finished so far.
   */
  advance(
    template: TemplateSource,
    allowance: number,
    generation: number,
    visible: readonly TemplateRect[] = [],
  ): TemplateGpuAdvance {
    let stored = this.stored.get(template.id)
    if (stored !== undefined && !isCurrent(stored.entry, template)) {
      this.release(template.id)
      stored = undefined
    }
    if (stored === undefined) {
      const pixels = template.artwork.pixels
      // Evicted and never uploaded: nothing to draw until the pixels are back in memory.
      if (pixels === null) return { entry: null, status: 'pending', uploadedPixels: 0 }
      const palette = this.gl.createTexture()
      if (palette === null) return { entry: null, status: 'failed', uploadedPixels: 0 }
      stored = {
        entry: {
          indices: [],
          palette,
          width: template.width,
          height: template.height,
          source: template.artwork,
          lastUsed: generation,
          paletteData: null,
        },
        upload: {
          observedAt: null,
          profileWindow: null,
          queue: measureProfileDetail('Overlay upload planning', () => this.plan(pixels)),
          pixels,
        },
      }
      this.stored.set(template.id, stored)
    }
    const { entry, upload } = stored
    entry.lastUsed = generation
    if (upload === null) return { entry, status: 'complete', uploadedPixels: 0 }
    if (isProfileEnabled()) {
      const now = performance.now()
      if (upload.profileWindow !== profileWindowId()) upload.observedAt = null
      upload.profileWindow = profileWindowId()
      upload.observedAt ??= now
      recordProfileWorkload('GPU observed upload queue age ms', now - upload.observedAt)
      recordProfileWorkload(
        'GPU pending templates',
        [...this.stored.values()].filter((other) => other.upload !== null).length,
      )
    } else upload.observedAt = null
    const { uploadedPixels, failed } = this.advanceUpload(entry, upload, allowance, visible)
    if (failed) {
      this.release(template.id)
      return { entry: null, status: 'failed', uploadedPixels }
    }
    if (upload.queue.length > 0) return { entry, status: 'pending', uploadedPixels }
    stored.upload = null
    return { entry, status: 'complete', uploadedPixels }
  }

  release(id: string): void {
    measureProfileDetail('Overlay texture deletion', () => {
      const stored = this.stored.get(id)
      if (stored === undefined) return
      const { entry, upload } = stored
      for (const tile of entry.indices) this.gl.deleteTexture(tile.texture)
      if (upload !== null) {
        recordProfileCounter('gpu:pending uploads released')
        for (const tile of upload.queue) {
          if (tile.texture !== null) this.gl.deleteTexture(tile.texture)
        }
      }
      this.gl.deleteTexture(entry.palette)
      this.stored.delete(id)
    })
  }

  collect(existing: ReadonlySet<string>, visible: ReadonlySet<string>): void {
    const records = [...this.stored].map(([id, stored]) => ({
      id,
      bytes: storedBytes(stored),
      lastUsed: stored.entry.lastUsed,
      visible: visible.has(id),
      exists: existing.has(id),
    }))
    for (const id of gpuCacheEvictions(records, this.maximumBytes)) {
      recordProfileCounter('gpu:cache evictions')
      this.release(id)
    }
  }

  dispose(): void {
    for (const id of [...this.stored.keys()]) this.release(id)
  }
}
