import {
  parseTileKey,
  type Template,
  TILE_SIZE,
  type TileKey,
  tileKey,
  timelapseCaptureRect,
  WORLD_PIXELS,
} from '@caelestis/shared'
import { chunkImageUrl, tileImageUrl } from '$lib/api/client'

export { OSM_TILE_SIZE, osmSpan, osmZoomFor } from './osm-geometry.js'

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

/**
 * Return every whole tile touched by the template. The viewer uses these tiles as its boundary.
 */
export const tileUnionRect = (template: Template): CanvasRect => {
  let minTX = Number.POSITIVE_INFINITY
  let minTY = Number.POSITIVE_INFINITY
  let maxTX = Number.NEGATIVE_INFINITY
  let maxTY = Number.NEGATIVE_INFINITY
  for (const chunk of template.chunks) {
    const coord = parseTileKey(chunk.tile)
    if (coord === null) continue
    minTX = Math.min(minTX, coord.x)
    minTY = Math.min(minTY, coord.y)
    maxTX = Math.max(maxTX, coord.x)
    maxTY = Math.max(maxTY, coord.y)
  }
  if (!Number.isFinite(minTX)) return templateRect(template)
  return {
    x: minTX * TILE_SIZE,
    y: minTY * TILE_SIZE,
    width: (maxTX - minTX + 1) * TILE_SIZE,
    height: (maxTY - minTY + 1) * TILE_SIZE,
  }
}

/** The bbox padded by `margin` × its own size on each side, clamped to `bounds`. */
export const paddedRect = (inner: CanvasRect, margin: number, bounds: CanvasRect): CanvasRect => {
  const padX = Math.round(inner.width * margin)
  const padY = Math.round(inner.height * margin)
  const x = Math.max(bounds.x, inner.x - padX)
  const y = Math.max(bounds.y, inner.y - padY)
  return {
    x,
    y,
    width: Math.min(bounds.x + bounds.width, inner.x + inner.width + padX) - x,
    height: Math.min(bounds.y + bounds.height, inner.y + inner.height + padY) - y,
  }
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

const imageCache = new Map<string, Promise<HTMLImageElement>>()

const loadImage = (url: Promise<string>, cors = false): Promise<HTMLImageElement> =>
  url.then(
    (src) =>
      new Promise((resolve, reject) => {
        const image = new Image()
        // CORS-clean, so drawing a basemap tile never taints the canvas.
        if (cors) image.crossOrigin = 'anonymous'
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error(`image failed to load: ${src}`))
        image.src = src
      }),
  )

const cachedImage = (
  cacheKey: string,
  url: () => Promise<string>,
  cors = false,
): Promise<HTMLImageElement> => {
  const hit = imageCache.get(cacheKey)
  if (hit !== undefined) return hit
  const image = loadImage(url(), cors).catch((error) => {
    imageCache.delete(cacheKey)
    throw error
  })
  imageCache.set(cacheKey, image)
  return image
}

export const tileImage = (hash: string): Promise<HTMLImageElement> =>
  cachedImage(`tile:${hash}`, () => tileImageUrl(hash))

export const chunkImage = (hash: string): Promise<HTMLImageElement> =>
  cachedImage(`chunk:${hash}`, () => chunkImageUrl(hash))

/** Destination rectangle for one slippy-map tile in canvas-pixel coordinates. */
export const osmTileDrawRect = (
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

export const osmImage = (z: number, x: number, y: number): Promise<HTMLImageElement> =>
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
 * Draw the observed canvas under a rect: each tile the server holds is painted where it belongs,
 * unobserved tiles stay transparent so the checkerboard beneath shows "never scanned" honestly.
 * Images arrive asynchronously; `onDirty` fires after each landing so the caller can composite.
 */
export const drawCanvasTiles = (
  ctx: CanvasRenderingContext2D,
  rect: CanvasRect,
  hashFor: (key: TileKey) => string | undefined,
  signal: AbortSignal,
  onDirty: () => void,
): void => {
  for (const placement of tilesInRect(rect)) {
    const hash = hashFor(placement.key)
    if (hash === undefined) continue
    tileImage(hash)
      .then((image) => {
        if (signal.aborted) return
        ctx.drawImage(image, placement.drawX, placement.drawY)
        onDirty()
      })
      .catch(() => {})
  }
}

/** Draw a template's chunks over a rect at the given opacity. */
export const drawTemplateChunks = (
  ctx: CanvasRenderingContext2D,
  rect: CanvasRect,
  template: Template,
  alpha: number,
  signal: AbortSignal,
  onDirty: () => void,
): void => {
  for (const chunk of template.chunks) {
    const coord = parseTileKey(chunk.tile)
    if (coord === null) continue
    // A chunk is the intersection of its bounding box and tile. Its top-left uses the later start
    // on each axis. The rectangle only translates it.
    const drawX = Math.max(coord.x * TILE_SIZE, template.bbox.minX) - rect.x
    const drawY = Math.max(coord.y * TILE_SIZE, template.bbox.minY) - rect.y
    chunkImage(chunk.hash)
      .then((image) => {
        if (signal.aborted) return
        ctx.save()
        ctx.globalAlpha = alpha
        ctx.drawImage(image, drawX, drawY)
        ctx.restore()
        onDirty()
      })
      .catch(() => {})
  }
}
