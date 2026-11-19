import {
  type PresenceRect,
  REGION_CLAIM_TTL_MS,
  type RegionClaim,
  rectIntersection,
} from './presence.js'
import {
  MAX_REGION_DOCUMENT_PIXELS,
  MAX_REGION_DOCUMENT_WORK,
  MAX_REGION_ITEMS,
  type RegionDocument,
  type RegionItem,
  type RegionShape,
  type RegionShapePixels,
  regionDocumentBounds,
  regionDocumentPixels,
  regionDocumentWork,
  regionShapeBounds,
  regionShapeRaster,
} from './region-shape.js'

/**
 * Claim documents as claims: when two touch, how a document splits into independent claims, when
 * a claim expires, and why one cannot be saved.
 *
 * Results are cached by document identity, so the same document object in gives the same pixels
 * out without rasterising again. Whoever receives a document that equals one it already holds
 * keeps the held object (`reuseDocument`) so the caches survive the round trip.
 */

/** When a claim lapses; servers predating claim expiry send none and the TTL applies. */
export const claimExpiry = (region: Pick<RegionClaim, 'expiresAt' | 'createdAt'>): number =>
  region.expiresAt ?? region.createdAt + REGION_CLAIM_TTL_MS

/** Whether two documents describe the same items, whatever objects hold them. */
export const sameDocument = (a: RegionDocument, b: RegionDocument): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * `incoming`, holding on to what is already held where nothing changed: the held object when it
 * is equal throughout, else `incoming` with the held document when only metadata changed.
 */
export const reuseDocument = <T extends { readonly document: RegionDocument }>(
  held: T | undefined,
  incoming: T,
): T => {
  if (held === undefined) return incoming
  if (JSON.stringify(held) === JSON.stringify(incoming)) return held
  return sameDocument(held.document, incoming.document)
    ? { ...incoming, document: held.document }
    : incoming
}

const pixelCache = new WeakMap<RegionDocument, RegionShapePixels | null>()

/** A document's pixels, rasterised once per document object. */
export const claimDocumentPixels = (document: RegionDocument): RegionShapePixels | null => {
  let pixels = pixelCache.get(document)
  if (pixels === undefined) {
    pixels = regionDocumentPixels(document)
    pixelCache.set(document, pixels)
  }
  return pixels
}

/** Pixels over a rect; a null mask covers the whole rect, so a rectangle never rasterises. */
interface Coverage {
  readonly rect: PresenceRect
  readonly mask: Uint8Array | null
}

/** Work allowance shared by many adjacency tests; a test that runs out answers "not touching". */
export interface AdjacencyBudget {
  remaining: number
}

/**
 * The adjacency rule claims are grouped and displayed by: two sets of pixels touch when they share
 * a pixel or have pixels touching at an edge or corner, the same eight-neighbour rule as
 * `regionPixelComponents`. Bounds only narrow the search; empty mask pixels never join.
 */
const coverageTouches = (a: Coverage, b: Coverage, budget?: AdjacencyBudget): boolean => {
  const bounds = a.rect
  const overlap = rectIntersection(
    { x: bounds.x - 1, y: bounds.y - 1, w: bounds.w + 2, h: bounds.h + 2 },
    b.rect,
  )
  if (overlap === null) return false
  const spend = (): boolean => budget === undefined || --budget.remaining >= 0
  for (let y = overlap.y; y < overlap.y + overlap.h; y++) {
    for (let x = overlap.x; x < overlap.x + overlap.w; x++) {
      if (!spend()) return false
      if (b.mask !== null && b.mask[(y - b.rect.y) * b.rect.w + x - b.rect.x] !== 1) continue
      if (a.mask === null) return true
      for (let ny = Math.max(y - 1, bounds.y); ny <= Math.min(y + 1, bounds.y + bounds.h - 1); ny++)
        for (
          let nx = Math.max(x - 1, bounds.x);
          nx <= Math.min(x + 1, bounds.x + bounds.w - 1);
          nx++
        ) {
          if (!spend()) return false
          if (a.mask[(ny - bounds.y) * bounds.w + nx - bounds.x] === 1) return true
        }
    }
  }
  return false
}

const shapeCoverage = (shape: RegionShape): Coverage =>
  shape.kind === 'rectangle'
    ? { rect: regionShapeBounds(shape), mask: null }
    : regionShapeRaster(shape)

/** Whether two shapes' pixels touch, by the claim adjacency rule. */
export const regionShapesTouch = (a: RegionShape, b: RegionShape): boolean =>
  coverageTouches(shapeCoverage(a), shapeCoverage(b))

/** Whether two rasters touch, by the claim adjacency rule, within a shared work budget. */
export const pixelsTouch = (
  a: RegionShapePixels,
  b: RegionShapePixels,
  budget: AdjacencyBudget,
): boolean => coverageTouches(a, b, budget)

const documentsCache = new WeakMap<RegionDocument, readonly RegionDocument[]>()

/**
 * The self-contained claims within a document: shapes whose pixels touch, adding or cutting,
 * belong together, and a subtractor across two regions joins them. Each claim keeps its items
 * in document order, so compositing is unchanged. Groups that only cut are dropped.
 */
export const claimDocuments = (document: RegionDocument): readonly RegionDocument[] => {
  const cached = documentsCache.get(document)
  if (cached !== undefined) return cached
  const parents = document.items.map((_, index) => index)
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index] as number] as number
      index = parents[index] as number
    }
    return index
  }
  for (let right = 0; right < document.items.length; right++) {
    for (let left = 0; left < right; left++) {
      if (root(left) === root(right)) continue
      if (
        regionShapesTouch(
          (document.items[left] as RegionItem).shape,
          (document.items[right] as RegionItem).shape,
        )
      )
        parents[root(right)] = root(left)
    }
  }
  const groups = new Map<number, RegionItem[]>()
  document.items.forEach((item, index) => {
    const key = root(index)
    const items = groups.get(key) ?? []
    items.push(item)
    groups.set(key, items)
  })
  const documents = [...groups.values()]
    .filter((items) => items.some((item) => item.op === 'add'))
    .map((items) => ({ items }))
  documentsCache.set(document, documents)
  return documents
}

const ADD_A_SHAPE = 'Add a shape before saving this claim.'
const noPixels = (subject: 'claim' | 'selection'): string =>
  `This ${subject} contains no pixels. Adjust or remove its subtracting shapes.`

/** Why a set of claims breaks the per-claim shape limits, or null. */
export const claimDocumentsLimitError = (documents: readonly RegionDocument[]): string | null => {
  if (documents.some((document) => document.items.length > MAX_REGION_ITEMS))
    return `A claim holds at most ${MAX_REGION_ITEMS} shapes.`
  if (documents.some((document) => regionDocumentWork(document) > MAX_REGION_DOCUMENT_WORK))
    return 'This claim is too complex to draw; shrink or remove some shapes before saving.'
  return null
}

/** Why one claim cannot be saved, explained before it can be mistaken for a routing failure. */
export const claimDocumentError = (document: RegionDocument): string | null => {
  const bounds = regionDocumentBounds(document)
  if (bounds === null) return ADD_A_SHAPE
  if (bounds.w * bounds.h > MAX_REGION_DOCUMENT_PIXELS)
    return 'This claim spans too much of the canvas. Move its shapes closer or split it.'
  if (claimDocumentPixels(document)?.count === 0) return noPixels('claim')
  return null
}

/**
 * The claims a working document saves as, each touching group its own claim, and why it cannot
 * be saved yet. Empty groups drop out; past the limits there is nothing to save.
 */
export const claimSet = (
  document: RegionDocument,
): { readonly documents: readonly RegionDocument[]; readonly error: string | null } => {
  const grouped = claimDocuments(document)
  const limit = claimDocumentsLimitError(grouped)
  if (limit !== null) return { documents: [], error: limit }
  const documents = grouped.filter((part) => claimDocumentPixels(part)?.count !== 0)
  if (document.items.length === 0) return { documents, error: null }
  if (documents.length === 0)
    return { documents, error: grouped.length === 0 ? ADD_A_SHAPE : noPixels('claim') }
  return {
    documents,
    error: documents.map(claimDocumentError).find((error) => error !== null) ?? null,
  }
}

/**
 * Why a capture selection cannot be used: past the limits for the whole document, which
 * rasterises as one, too wide, or covering nothing.
 */
export const selectionError = (document: RegionDocument): string | null => {
  const limit = documentLimitError(document, 'selection')
  if (limit !== null) return limit
  const rect = regionDocumentBounds(document)
  if (rect !== null && rect.w * rect.h > MAX_REGION_DOCUMENT_PIXELS)
    return 'This selection spans too much of the canvas. Select a smaller area.'
  if (document.items.length > 0 && !((claimDocumentPixels(document)?.count ?? 0) > 0))
    return noPixels('selection')
  return null
}

/** Why adding to a working document would break the limits, per claim or for a selection. */
export const documentLimitError = (
  document: RegionDocument,
  purpose: 'claim' | 'selection',
): string | null => {
  if (purpose === 'claim') return claimDocumentsLimitError(claimDocuments(document))
  if (document.items.length > MAX_REGION_ITEMS)
    return `A selection holds at most ${MAX_REGION_ITEMS} shapes.`
  if (regionDocumentWork(document) > MAX_REGION_DOCUMENT_WORK)
    return 'This selection is too complex to draw; shrink or remove some shapes.'
  return null
}
