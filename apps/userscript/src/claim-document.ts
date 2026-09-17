import {
  MAX_REGION_DOCUMENT_PIXELS,
  MAX_REGION_DOCUMENT_WORK,
  MAX_REGION_ITEMS,
  type PresenceRect,
  type RegionDocument,
  type RegionItem,
  type RegionShapePixels,
  rectIntersection,
  regionDocumentBounds,
  regionDocumentPixels,
  regionDocumentWork,
  regionShapeBounds,
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

const documentsCache = new WeakMap<RegionDocument, readonly RegionDocument[]>()

export const claimDocuments = (document: RegionDocument): readonly RegionDocument[] => {
  const cached = documentsCache.get(document)
  if (cached !== undefined) return cached
  const bounds = document.items.map((item) => regionShapeBounds(item.shape))
  const parents = document.items.map((_, index) => index)
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index] as number] as number
      index = parents[index] as number
    }
    return index
  }
  for (let right = 0; right < bounds.length; right++) {
    for (let left = 0; left < right; left++) {
      if (rectIntersection(bounds[left] as PresenceRect, bounds[right] as PresenceRect) !== null)
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
