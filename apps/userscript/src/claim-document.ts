import {
  MAX_REGION_DOCUMENT_PIXELS,
  MAX_REGION_DOCUMENT_WORK,
  MAX_REGION_ITEMS,
  type RegionDocument,
  type RegionItem,
  type RegionShape,
  type RegionShapePixels,
  rectIntersection,
  regionDocumentBounds,
  regionDocumentPixels,
  regionDocumentWork,
  regionShapeBounds,
  regionShapePixels,
} from '@caelestis/shared'

const pixelCache = new WeakMap<RegionDocument, RegionShapePixels | null>()

export const claimDocumentPixels = (document: RegionDocument): RegionShapePixels | null => {
  let pixels = pixelCache.get(document)
  if (pixels === undefined) {
    pixels = regionDocumentPixels(document)
    pixelCache.set(document, pixels)
  }
  return pixels
}

const shapePixelCache = new WeakMap<RegionShape, RegionShapePixels>()

const shapePixels = (shape: RegionShape): RegionShapePixels => {
  let pixels = shapePixelCache.get(shape)
  if (pixels === undefined) {
    pixels = regionShapePixels(shape)
    shapePixelCache.set(shape, pixels)
  }
  return pixels
}

/**
 * Whether two shapes share a pixel or have pixels touching at an edge or corner, matching
 * regionPixelComponents. Expanded bounds only narrow the search; empty mask pixels never join.
 */
export const regionShapesTouch = (a: RegionShape, b: RegionShape): boolean => {
  const bounds = regionShapeBounds(a)
  const overlap = rectIntersection(
    { x: bounds.x - 1, y: bounds.y - 1, w: bounds.w + 2, h: bounds.h + 2 },
    regionShapeBounds(b),
  )
  if (overlap === null) return false
  if (a.kind === 'rectangle' && b.kind === 'rectangle') return true
  const left = a.kind === 'rectangle' ? null : shapePixels(a)
  const right = b.kind === 'rectangle' ? null : shapePixels(b)
  for (let y = overlap.y; y < overlap.y + overlap.h; y++) {
    for (let x = overlap.x; x < overlap.x + overlap.w; x++) {
      if (right !== null && right.mask[(y - right.rect.y) * right.rect.w + x - right.rect.x] !== 1)
        continue
      if (left === null) return true
      for (
        let ny = Math.max(y - 1, bounds.y);
        ny <= Math.min(y + 1, bounds.y + bounds.h - 1);
        ny++
      ) {
        for (
          let nx = Math.max(x - 1, bounds.x);
          nx <= Math.min(x + 1, bounds.x + bounds.w - 1);
          nx++
        ) {
          if (left.mask[(ny - bounds.y) * bounds.w + nx - bounds.x] === 1) return true
        }
      }
    }
  }
  return false
}

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

export const claimDocumentsLimitError = (documents: readonly RegionDocument[]): string | null => {
  if (documents.some((document) => document.items.length > MAX_REGION_ITEMS))
    return `A claim holds at most ${MAX_REGION_ITEMS} shapes.`
  if (documents.some((document) => regionDocumentWork(document) > MAX_REGION_DOCUMENT_WORK))
    return 'This claim is too complex to draw; shrink or remove some shapes before saving.'
  return null
}

/** Explain document failures before they can be mistaken for routing failures. */
export const claimDocumentError = (document: RegionDocument): string | null => {
  const bounds = regionDocumentBounds(document)
  if (bounds === null) return 'Add a shape before saving this claim.'
  if (bounds.w * bounds.h > MAX_REGION_DOCUMENT_PIXELS)
    return 'This claim spans too much of the canvas. Move its shapes closer or split it.'
  if (claimDocumentPixels(document)?.count === 0)
    return 'This claim contains no pixels. Adjust or remove its subtracting shapes.'
  return null
}
