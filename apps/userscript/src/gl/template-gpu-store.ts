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

interface PendingTemplateGpuTile extends GpuTilePlacement {
  texture: WebGLTexture | null
  uploadedPixels: number
}

interface PendingTemplateGpu {
  /** Age is observed only while profiling; a pre-existing queue starts at its first profiled advance. */
  observedAt: number | null
  profileWindow: number | null
  readonly indices: readonly PendingTemplateGpuTile[]
  readonly palette: WebGLTexture
  readonly width: number
  readonly height: number
  readonly source: TemplateArtwork
  /** Held only while uploading; a finished entry keeps no CPU copy of the pixels. */
  readonly pixels: SparsePixels
  lastUsed: number
}

export interface TemplateGpuEntry {
  readonly indices: readonly TemplateGpuTile[]
  readonly palette: WebGLTexture
  readonly width: number
  readonly height: number
  /** The artwork uploaded. Textures stay valid while the template's pixels are evicted. */
  readonly source: TemplateArtwork
  lastUsed: number
  paletteData: Uint8Array | null
}

export interface TemplateGpuAdvance {
  readonly entry: TemplateGpuEntry | null
  readonly status: 'complete' | 'pending' | 'failed'
  readonly uploadedPixels: number
}

type TemplateSource = Pick<PlacedTemplate, 'id' | 'width' | 'height' | 'artwork'>

const entryBytes = (entry: TemplateGpuEntry | PendingTemplateGpu): number =>
  PALETTE_SIZE * 4 +
  entry.indices.reduce((total, tile) => total + tile.textureWidth * tile.textureHeight, 0)

/**
 * Owns palette-index textures for one WebGL context.
 *
 * Both renderer adapters use this module. It hides device-sized chunking, outline halos,
 * progressive uploads, source replacement, and bounded warm caching behind one interface.
 */
export class TemplateGpuStore {
  private readonly complete = new Map<string, TemplateGpuEntry>()
  private readonly pending = new Map<string, PendingTemplateGpu>()
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
    for (const entry of this.complete.values()) bytes += entryBytes(entry)
    for (const entry of this.pending.values()) bytes += entryBytes(entry)
    return bytes
  }

  entry(id: string): TemplateGpuEntry | null {
    return this.complete.get(id) ?? null
  }

  hasCurrent(template: TemplateSource): boolean {
    const entry = this.complete.get(template.id)
    return (
      entry !== undefined &&
      entry.source === template.artwork &&
      entry.width === template.width &&
      entry.height === template.height
    )
  }

  uploadPalette(entry: TemplateGpuEntry, data: Uint8Array): void {
    if (
      entry.paletteData !== null &&
      entry.paletteData.length === data.length &&
      entry.paletteData.every((value, index) => value === data[index])
    )
      return
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, entry.palette)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, PALETTE_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
    recordProfileCounter('gpu:palette upload bytes', data.byteLength)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    entry.paletteData = data.slice()
  }

  private textureLimit(width: number, height: number): number {
    return this.maximumTextureSize ?? Math.max(width, height) + 2
  }

  /** Textures for the painted chunks only, each split further if the device cannot hold it. */
  private plan(pixels: SparsePixels): readonly PendingTemplateGpuTile[] {
    const rects: { x: number; y: number; width: number; height: number; inset: number }[] = []
    for (const chunk of pixels.chunks.values()) {
      const allocationLimit = this.textureLimit(chunk.width, chunk.height)
      const inset = allocationLimit >= 3 ? 1 : 0
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
    pending: PendingTemplateGpu,
    tile: PendingTemplateGpuTile,
    uploadX: number,
    uploadY: number,
    uploadWidth: number,
    uploadHeight: number,
  ): Uint8Array {
    // The halo reads into neighbouring chunks, and reads transparent past the template's edges.
    return pixelRect(
      pending.pixels,
      tile.x - tile.inset + uploadX,
      tile.y - tile.inset + uploadY,
      uploadWidth,
      uploadHeight,
    )
  }

  private advanceUpload(pending: PendingTemplateGpu, allowance: number): TemplateGpuAdvance {
    const gl = this.gl
    let left = Math.max(0, Math.floor(allowance))
    let uploadedPixels = 0
    for (const tile of pending.indices) {
      const total = tile.textureWidth * tile.textureHeight
      if (tile.uploadedPixels >= total) continue
      if (left === 0) return { entry: null, status: 'pending', uploadedPixels }
      if (tile.texture === null) {
        const texture = gl.createTexture()
        if (texture === null) return { entry: null, status: 'failed', uploadedPixels }
        tile.texture = texture
        measureProfileDetail('Overlay texture allocation', () =>
          this.allocate(texture, tile.textureWidth, tile.textureHeight),
        )
      }
      gl.bindTexture(gl.TEXTURE_2D, tile.texture)
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
          this.fill(pending, tile, uploadX, uploadY, uploadWidth, uploadHeight),
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
    }

    const indices: TemplateGpuTile[] = []
    for (const tile of pending.indices) {
      if (tile.texture === null || tile.uploadedPixels < tile.textureWidth * tile.textureHeight)
        return { entry: null, status: 'pending', uploadedPixels }
      const { uploadedPixels: _uploaded, texture, ...placement } = tile
      indices.push({ ...placement, texture })
    }
    const entry: TemplateGpuEntry = {
      indices,
      palette: pending.palette,
      width: pending.width,
      height: pending.height,
      source: pending.source,
      lastUsed: pending.lastUsed,
      paletteData: null,
    }
    return { entry, status: 'complete', uploadedPixels }
  }

  advance(template: TemplateSource, allowance: number, generation: number): TemplateGpuAdvance {
    let entry = this.complete.get(template.id)
    let pending = this.pending.get(template.id)
    const changed =
      (entry !== undefined &&
        (entry.source !== template.artwork ||
          entry.width !== template.width ||
          entry.height !== template.height)) ||
      (pending !== undefined &&
        (pending.source !== template.artwork ||
          pending.width !== template.width ||
          pending.height !== template.height))
    if (changed) {
      this.release(template.id)
      entry = undefined
      pending = undefined
    }
    if (entry !== undefined) {
      entry.lastUsed = generation
      return { entry, status: 'complete', uploadedPixels: 0 }
    }
    if (pending === undefined) {
      const pixels = template.artwork.pixels
      // Evicted and never uploaded: nothing to draw until the pixels are back in memory.
      if (pixels === null) return { entry: null, status: 'pending', uploadedPixels: 0 }
      const palette = this.gl.createTexture()
      if (palette === null) return { entry: null, status: 'failed', uploadedPixels: 0 }
      pending = {
        observedAt: null,
        profileWindow: null,
        indices: measureProfileDetail('Overlay upload planning', () => this.plan(pixels)),
        palette,
        width: template.width,
        height: template.height,
        source: template.artwork,
        pixels,
        lastUsed: generation,
      }
      this.pending.set(template.id, pending)
    }
    pending.lastUsed = generation
    if (isProfileEnabled()) {
      const now = performance.now()
      if (pending.profileWindow !== profileWindowId()) pending.observedAt = null
      pending.profileWindow = profileWindowId()
      pending.observedAt ??= now
      recordProfileWorkload('GPU observed upload queue age ms', now - pending.observedAt)
      recordProfileWorkload('GPU pending templates', this.pending.size)
    } else pending.observedAt = null
    const advanced = this.advanceUpload(pending, allowance)
    if (advanced.status === 'failed') {
      this.release(template.id)
      return advanced
    }
    if (advanced.entry === null) return advanced
    this.pending.delete(template.id)
    this.complete.set(template.id, advanced.entry)
    return advanced
  }

  release(id: string): void {
    measureProfileDetail('Overlay texture deletion', () => {
      const existing = this.complete.get(id)
      if (existing !== undefined) {
        for (const tile of existing.indices) this.gl.deleteTexture(tile.texture)
        this.gl.deleteTexture(existing.palette)
        this.complete.delete(id)
      }
      const pending = this.pending.get(id)
      if (pending !== undefined) {
        recordProfileCounter('gpu:pending uploads released')
        for (const tile of pending.indices) {
          if (tile.texture !== null) this.gl.deleteTexture(tile.texture)
        }
        this.gl.deleteTexture(pending.palette)
        this.pending.delete(id)
      }
    })
  }

  collect(existing: ReadonlySet<string>, visible: ReadonlySet<string>): void {
    const records = [...this.complete].map(([id, entry]) => ({
      id,
      bytes: entryBytes(entry),
      lastUsed: entry.lastUsed,
      visible: visible.has(id),
      exists: existing.has(id),
    }))
    for (const [id, entry] of this.pending) {
      records.push({
        id,
        bytes: entryBytes(entry),
        lastUsed: entry.lastUsed,
        visible: visible.has(id),
        exists: existing.has(id),
      })
    }
    for (const id of gpuCacheEvictions(records, this.maximumBytes)) {
      recordProfileCounter('gpu:cache evictions')
      this.release(id)
    }
  }

  dispose(): void {
    for (const id of new Set([...this.complete.keys(), ...this.pending.keys()])) this.release(id)
  }
}
