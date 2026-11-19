import {
  parseTileKey,
  type Template,
  TILE_SIZE,
  type TileKey,
  tileKey,
  timelapseCaptureRect,
  WORLD_PIXELS,
} from '@caelestis/shared'
import { osmSpan } from '@caelestis/social'
import { chunkImageUrl, tileImageUrl } from '#lib/api/client.js'

/**
 * A template's bounding box as a drawable rectangle.
 *
 * `minX > maxX` means the artwork wraps through longitude zero; the rectangle is unrolled past the
 * seam so drawing stays a single translate, and tile lookups fold x back into the world.
 */
export interface CanvasRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export const templateRect = (template: Template): CanvasRect => {
  const { minX, minY, maxX, maxY } = template.bbox
  return {
    x: minX,
    y: minY,
    width: maxX > minX ? maxX - minX : maxX + WORLD_PIXELS - minX,
    height: maxY - minY,
  }
}

export interface TilePlacement {
  readonly key: TileKey
  /** Where the tile's top-left corner lands in rect-local pixels. */
  readonly drawX: number
  readonly drawY: number
}

/** Every canvas tile the rectangle touches, with its rect-local draw position. */
export const tilesInRect = (rect: CanvasRect): TilePlacement[] => {
  const placements: TilePlacement[] = []
  const firstTileX = Math.floor(rect.x / TILE_SIZE)
  const lastTileX = Math.ceil((rect.x + rect.width) / TILE_SIZE) - 1
  const firstTileY = Math.floor(rect.y / TILE_SIZE)
  const lastTileY = Math.ceil((rect.y + rect.height) / TILE_SIZE) - 1
  for (let ty = firstTileY; ty <= lastTileY; ty++) {
    for (let tx = firstTileX; tx <= lastTileX; tx++) {
      const worldX =
        ((tx % (WORLD_PIXELS / TILE_SIZE)) + WORLD_PIXELS / TILE_SIZE) % (WORLD_PIXELS / TILE_SIZE)
      placements.push({
        key: tileKey({ x: worldX, y: ty }),
        drawX: tx * TILE_SIZE - rect.x,
        drawY: ty * TILE_SIZE - rect.y,
      })
    }
  }
  return placements
}

/** Decoded pixels the image cache keeps before it drops the least recently used images. */
const IMAGE_CACHE_PIXELS = 32 * 1024 * 1024

interface CachedImage {
  readonly image: Promise<HTMLImageElement>
  /** Decoded size once loaded; pending loads count as nothing. */
  pixels: number
}

/** Insertion order is recency: a hit moves its entry to the end. */
const imageCache = new Map<string, CachedImage>()
let cachedPixels = 0

const evictImages = (): void => {
  for (const [key, entry] of imageCache) {
    if (cachedPixels <= IMAGE_CACHE_PIXELS) return
    if (entry.pixels === 0) continue
    imageCache.delete(key)
    cachedPixels -= entry.pixels
  }
}

const loadImage = (url: Promise<string>, cors = false): Promise<HTMLImageElement> =>
  url.then(
    (src) =>
      new Promise((resolve, reject) => {
        const image = new Image()
        // CORS-clean, so drawing a basemap tile never taints the canvas.
        if (cors) image.crossOrigin = 'anonymous'
        image.onload = () => {
          // The decoded image stays drawable; only the blob behind an authenticated read is freed.
          if (src.startsWith('blob:')) URL.revokeObjectURL(src)
          resolve(image)
        }
        image.onerror = () => {
          if (src.startsWith('blob:')) URL.revokeObjectURL(src)
          reject(new Error(`image failed to load: ${src}`))
        }
        image.src = src
      }),
  )

/**
 * Load an image once and share it while it stays among the most recently used. `FrameImages` holds
 * what a drawing keeps using, so eviction only costs a later reload.
 */
const cachedImage = (
  cacheKey: string,
  url: () => Promise<string>,
  cors = false,
): Promise<HTMLImageElement> => {
  const hit = imageCache.get(cacheKey)
  if (hit !== undefined) {
    imageCache.delete(cacheKey)
    imageCache.set(cacheKey, hit)
    return hit.image
  }
  const entry: CachedImage = {
    image: loadImage(url(), cors).then(
      (image) => {
        if (imageCache.get(cacheKey) === entry) {
          entry.pixels = image.naturalWidth * image.naturalHeight
          cachedPixels += entry.pixels
          evictImages()
        }
        return image
      },
      (error) => {
        if (imageCache.get(cacheKey) === entry) imageCache.delete(cacheKey)
        throw error
      },
    ),
    pixels: 0,
  }
  imageCache.set(cacheKey, entry)
  return entry.image
}

const tileImage = (hash: string): Promise<HTMLImageElement> =>
  cachedImage(`tile:${hash}`, () => tileImageUrl(hash))

export const chunkImage = (hash: string): Promise<HTMLImageElement> =>
  cachedImage(`chunk:${hash}`, () => chunkImageUrl(hash))

/** Destination rectangle for one slippy-map tile in canvas-pixel coordinates. */
const osmTileDrawRect = (
  tileX: number,
  tileY: number,
  span: number,
  deviceScale: number,
): CanvasRect => ({
  x: tileX * span,
  y: tileY * span,
  // Canvas filtering samples just outside each independently drawn image. Extend toward the next
  // tile by one physical pixel so that sample comes from an opaque neighbour instead of the cleared
  // canvas. Later tiles paint over the overlap, so map detail is neither shifted nor duplicated.
  width: span + 1 / Math.max(Number.EPSILON, deviceScale),
  height: span + 1 / Math.max(Number.EPSILON, deviceScale),
})

const osmImage = (z: number, x: number, y: number): Promise<HTMLImageElement> =>
  cachedImage(
    `osm:${z}/${x}/${y}`,
    () => Promise.resolve(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`),
    true,
  )

/** One chunk's draw position in world (canvas-pixel) coordinates. */
export interface ChunkPlacement {
  readonly hash: string
  readonly x: number
  readonly y: number
}

/** One captured canvas tile in world pixels, with every template whose capture covers it. */
export interface TimelapseTile {
  readonly key: TileKey
  readonly x: number
  readonly y: number
  readonly templates: readonly Template[]
}

/** Several templates' timelapse captures arranged on one world canvas. */
export interface TimelapseLayout {
  /** The union of every capture rectangle: the viewer's pan limit and opening view. */
  readonly bounds: CanvasRect
  /** The union of the artwork alone. */
  readonly art: CanvasRect
  /**
   * Only the tiles some template captures, once per draw position. Gaps between captures hold
   * none. A key repeats only when captures span every longitude and the tile is cut by the start.
   */
  readonly tiles: readonly TimelapseTile[]
  readonly chunks: readonly ChunkPlacement[]
}

/** Move x by whole worlds into [start, start + WORLD_PIXELS). */
const wrapInto = (x: number, start: number): number =>
  start + ((((x - start) % WORLD_PIXELS) + WORLD_PIXELS) % WORLD_PIXELS)

const unionRect = (rects: readonly CanvasRect[]): CanvasRect => {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  const x = Math.min(...rects.map((rect) => rect.x))
  const y = Math.min(...rects.map((rect) => rect.y))
  return {
    x,
    y,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y,
  }
}

/**
 * Lay templates out on one world canvas from their own timelapse captures.
 *
 * Longitude wraps, so the layout starts after the widest empty span between captures. Templates on
 * both sides of the world seam then sit next to each other instead of a world apart.
 */
export const timelapseLayout = (templates: readonly Template[]): TimelapseLayout => {
  const captures = templates.map((template) => {
    const rect = timelapseCaptureRect(template.bbox)
    return { template, rect: { ...rect, x: wrapInto(rect.x, 0) } }
  })
  // Seeding the reach with the rightmost edge one world back makes the first gap the seam gap.
  let reach =
    captures.reduce((edge, { rect }) => Math.max(edge, rect.x + rect.width), 0) - WORLD_PIXELS
  let start = 0
  let widest = Number.NEGATIVE_INFINITY
  for (const { rect } of captures.toSorted((left, right) => left.rect.x - right.rect.x)) {
    if (rect.x - reach > widest) {
      widest = rect.x - reach
      start = rect.x
    }
    reach = Math.max(reach, rect.x + rect.width)
  }
  const placed = captures.map(({ template, rect }) => ({
    template,
    rect: rect.x < start ? { ...rect, x: rect.x + WORLD_PIXELS } : rect,
  }))

  // Keyed by draw position: a tile cut by the layout's start also belongs at its far end.
  const tiles = new Map<string, { key: TileKey; x: number; y: number; templates: Template[] }>()
  for (const { template, rect } of placed) {
    for (const placement of tilesInRect(rect)) {
      const x = rect.x + placement.drawX
      const y = rect.y + placement.drawY
      const tile = tiles.get(`${x}/${y}`)
      if (tile !== undefined) tile.templates.push(template)
      else tiles.set(`${x}/${y}`, { key: placement.key, x, y, templates: [template] })
    }
  }

  return {
    bounds: unionRect(placed.map(({ rect }) => rect)),
    art: unionRect(
      placed.map(({ template, rect }) => {
        const art = templateRect(template)
        return { ...art, x: wrapInto(art.x, rect.x) }
      }),
    ),
    tiles: [...tiles.values()],
    chunks: placed.flatMap(({ template, rect }) =>
      template.chunks.flatMap((chunk) => {
        const coord = parseTileKey(chunk.tile)
        if (coord === null) return []
        // A chunk is its tile clipped to the bbox, so only the tile holding the left edge starts
        // at minX. Comparing tile columns keeps a seam-crossing chunk from snapping back to minX.
        const left =
          coord.x === Math.floor(template.bbox.minX / TILE_SIZE)
            ? template.bbox.minX
            : coord.x * TILE_SIZE
        return [
          {
            hash: chunk.hash,
            x: wrapInto(left, rect.x),
            y: Math.max(coord.y * TILE_SIZE, template.bbox.minY),
          },
        ]
      }),
    ),
  }
}

/**
 * The decoded images one drawing uses, and when to draw again. A drawing asks for each image
 * synchronously; one that is not decoded yet starts loading and asks for the next drawing once it
 * is. Each drawing keeps only the images it used, so panning and scrubbing release what scrolled
 * away.
 */
export class FrameImages {
  #held = new Map<string, HTMLImageElement>()
  #drawn = new Map<string, HTMLImageElement>()
  readonly #pending = new Set<string>()
  /** Last decoded observation per tile, independent of the frame being drawn. */
  readonly #presented = new Map<TileKey, HTMLImageElement>()

  readonly #redraw: () => void
  #queued = false

  /** `redraw` draws the host's current view; it runs at most once per `invalidate` burst. */
  constructor(redraw: () => void) {
    this.#redraw = redraw
  }

  /**
   * Ask for a drawing. Requests before it runs share one. A microtask, not requestAnimationFrame:
   * rAF never fires in an occluded tab, so a zoom or a scrub done while the window is covered
   * would silently draw nothing.
   */
  invalidate(): void {
    if (this.#queued) return
    this.#queued = true
    queueMicrotask(() => {
      this.#queued = false
      this.#redraw()
    })
  }

  #get(key: string, load: () => Promise<HTMLImageElement>): HTMLImageElement | null {
    const held = this.#held.get(key)
    if (held !== undefined) {
      this.#drawn.set(key, held)
      return held
    }
    if (!this.#pending.has(key)) {
      this.#pending.add(key)
      load()
        .then((image) => {
          this.#held.set(key, image)
          this.invalidate()
        })
        // A failed image stays undrawn: the basemap or the last observation shows through.
        .catch(() => {})
        .finally(() => this.#pending.delete(key))
    }
    return null
  }

  /**
   * Replace the canvas with a layout's `view` (world pixels), its origin at the canvas origin.
   * `scale` is device pixels per world pixel; `basemapZoom` the slippy zoom for the map beneath.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    {
      layout,
      view,
      scale,
      basemapZoom,
      hashFor,
      overlayAlpha,
    }: {
      readonly layout: TimelapseLayout
      readonly view: CanvasRect
      readonly scale: number
      readonly basemapZoom: number
      readonly hashFor: (key: TileKey) => string | undefined
      readonly overlayAlpha: number
    },
  ): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    ctx.setTransform(scale, 0, 0, scale, -view.x * scale, -view.y * scale)
    this.#drawn = new Map()
    const span = osmSpan(basemapZoom)
    const worldTiles = 2 ** basemapZoom
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    const lastOsmY = Math.min(worldTiles - 1, Math.floor((view.y + view.height) / span))
    for (let ty = Math.max(0, Math.floor(view.y / span)); ty <= lastOsmY; ty++) {
      for (
        let tx = Math.floor(view.x / span);
        tx <= Math.floor((view.x + view.width) / span);
        tx++
      ) {
        const x = ((tx % worldTiles) + worldTiles) % worldTiles
        const image = this.#get(`osm:${basemapZoom}/${x}/${ty}`, () => osmImage(basemapZoom, x, ty))
        if (image === null) continue
        const tile = osmTileDrawRect(tx, ty, span, scale)
        ctx.drawImage(image, tile.x, tile.y, tile.width, tile.height)
      }
    }

    // wplace's own answer to moiré, measured off its GL calls: LINEAR below 1:1, NEAREST above.
    ctx.imageSmoothingEnabled = scale < 1
    for (const tile of layout.tiles) {
      if (
        tile.x + TILE_SIZE < view.x ||
        tile.x > view.x + view.width ||
        tile.y + TILE_SIZE < view.y ||
        tile.y > view.y + view.height
      )
        continue
      const hash = hashFor(tile.key)
      if (hash === undefined) continue
      const loaded = this.#get(`tile:${hash}`, () => tileImage(hash))
      if (loaded !== null) this.#presented.set(tile.key, loaded)
      // A requested frame shows only once decoded. Pending, missing and failed images keep the last
      // valid observation instead of exposing the basemap as a false blank. An undefined hash means
      // the selected time predates this tile's first observation, so nothing later leaks back.
      const image = loaded ?? this.#presented.get(tile.key)
      if (image !== undefined) ctx.drawImage(image, tile.x, tile.y)
    }

    if (overlayAlpha > 0) {
      ctx.globalAlpha = overlayAlpha
      for (const chunk of layout.chunks) {
        const image = this.#get(`chunk:${chunk.hash}`, () => chunkImage(chunk.hash))
        if (image !== null) ctx.drawImage(image, chunk.x, chunk.y)
      }
      ctx.globalAlpha = 1
    }
    this.#held = this.#drawn
  }
}
