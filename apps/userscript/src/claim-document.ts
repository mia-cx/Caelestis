import {
  MAX_REGION_DOCUMENT_PIXELS,
  type RegionDocument,
  type RegionShapePixels,
  regionDocumentBounds,
  regionDocumentPixels,
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
