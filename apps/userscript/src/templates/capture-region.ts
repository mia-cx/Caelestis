import {
  MAX_REGION_DOCUMENT_PIXELS,
  type PresenceRect,
  type RegionShapePixels,
  TRANSPARENT_INDEX,
  uuidV7,
} from '@caelestis/shared'
import { overlayCommittedWorldArtwork } from './current-artwork.js'
import type { ImportedTemplate } from './import.js'

/** The pixels a capture keeps: their bounding rectangle, and the masks of each part inside it. */
export interface RegionSelection {
  readonly rect: PresenceRect
  readonly parts: readonly RegionShapePixels[]
}

export interface RegionCapture {
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
  /** One palette index per pixel; `TRANSPARENT_INDEX` outside the selection or where unpainted. */
  readonly indices: Uint8Array
  readonly opaque: number
}

/** Clear every pixel no part of the selection covers, and count what is left. */
export const maskToSelection = (indices: Uint8Array, selection: RegionSelection): number => {
  const { rect, parts } = selection
  const kept = new Uint8Array(rect.w * rect.h)
  for (const part of parts) {
    for (let row = 0; row < part.rect.h; row++) {
      for (let column = 0; column < part.rect.w; column++) {
        if (part.mask[row * part.rect.w + column] !== 1) continue
        kept[(part.rect.y + row - rect.y) * rect.w + part.rect.x + column - rect.x] = 1
      }
    }
  }
  let opaque = 0
  for (let at = 0; at < indices.length; at++) {
    if (kept[at] !== 1) indices[at] = TRANSPARENT_INDEX
    else if (indices[at] !== TRANSPARENT_INDEX) opaque++
  }
  return opaque
}

/**
 * Snapshot the committed world art under a selection, one image pixel per Wplace pixel.
 *
 * The result is a fresh array that no later change to the canvas can touch. Drafts, template
 * overlays, and mismatch markers never reach it: it reads committed tile pixels only.
 */
export const captureRegion = async (selection: RegionSelection): Promise<RegionCapture> => {
  const { rect } = selection
  if (rect.w * rect.h > MAX_REGION_DOCUMENT_PIXELS)
    throw new Error('That selection spans too much of the canvas. Select a smaller area.')
  const indices = new Uint8Array(rect.w * rect.h).fill(TRANSPARENT_INDEX)
  await overlayCommittedWorldArtwork(indices, rect.x, rect.y, rect.w, rect.h)
  const opaque = maskToSelection(indices, selection)
  if (opaque === 0) throw new Error('There is no artwork inside that selection.')
  return { originX: rect.x, originY: rect.y, width: rect.w, height: rect.h, indices, opaque }
}

/** A capture as a new image template, still at the place it was captured from. */
export const templateFromCapture = (capture: RegionCapture): ImportedTemplate => ({
  id: `local-${uuidV7()}`,
  name: `Capture ${capture.originX}, ${capture.originY}`,
  source: 'image',
  sortOrder: 0,
  originX: capture.originX,
  originY: capture.originY,
  width: capture.width,
  height: capture.height,
  indices: capture.indices,
  moved: 0,
  opaque: capture.opaque,
})
