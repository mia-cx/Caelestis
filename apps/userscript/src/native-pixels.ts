import { TRANSPARENT_INDEX } from '@caelestis/shared'
import { intersectRects, type PixelRect } from './geometry.js'

/** Index meaning "nobody has painted here", in native art or a draft. Distinct from every palette entry. */
export const UNPAINTED = 255

/** One uncomposited native layer. Its empty index means unpainted art or an absent draft. */
export interface NativePixelRegion extends PixelRect {
  readonly pixels: Uint8Array
  readonly emptyIndex: number
  /** Distinguishes a drafted transparent pixel from a draft canvas pixel with no draft. */
  readonly present?: Uint8Array
}

/** Native committed art and its sparse draft overlay, kept separate until a consumer resolves it. */
export interface NativePixelSnapshot {
  readonly committed: readonly NativePixelRegion[]
  readonly draft: readonly NativePixelRegion[]
}

export interface NativePixelWindow extends PixelRect {
  /** Palette indices, with every known unpainted pixel normalized to `TRANSPARENT_INDEX`. */
  readonly indices: Uint8Array
  /** Zero means neither committed art nor a draft has established this pixel. */
  readonly known: Uint8Array
  /** One means `indices` came from the draft layer rather than committed art. */
  readonly drafted: Uint8Array
}

export interface NativePixel {
  readonly index: number
  readonly source: 'committed' | 'draft'
}

const regionPixel = (region: NativePixelRegion, x: number, y: number): number | undefined =>
  region.pixels[(y - region.y) * region.width + (x - region.x)]

const draftPresent = (region: NativePixelRegion, at: number, index: number): boolean =>
  region.present?.[at] === 1 || index !== region.emptyIndex

const draftIndex = (region: NativePixelRegion, at: number, index: number): number =>
  region.present?.[at] === 1 && index === region.emptyIndex ? TRANSPARENT_INDEX : index

/** Resolve one native pixel. Drafts win, including an explicit transparent draft. */
export const nativePixelAt = (
  snapshot: NativePixelSnapshot,
  x: number,
  y: number,
  includeDraft = true,
): NativePixel | null => {
  const column = Math.floor(x)
  const row = Math.floor(y)
  if (includeDraft) {
    for (let at = snapshot.draft.length - 1; at >= 0; at--) {
      const region = snapshot.draft[at]
      if (
        region === undefined ||
        column < region.x ||
        row < region.y ||
        column >= region.x + region.width ||
        row >= region.y + region.height
      )
        continue
      const offset = (row - region.y) * region.width + (column - region.x)
      const index = region.pixels[offset]
      if (index === undefined || !draftPresent(region, offset, index)) continue
      return { index: draftIndex(region, offset, index), source: 'draft' }
    }
  }
  for (let at = snapshot.committed.length - 1; at >= 0; at--) {
    const region = snapshot.committed[at]
    if (
      region === undefined ||
      column < region.x ||
      row < region.y ||
      column >= region.x + region.width ||
      row >= region.y + region.height
    )
      continue
    const index = regionPixel(region, column, row)
    if (index === undefined) continue
    return {
      index: index === region.emptyIndex ? TRANSPARENT_INDEX : index,
      source: 'committed',
    }
  }
  return null
}

/**
 * Resolve a rectangular native-pixel window once for progress, markers, picking, and navigation.
 * Unknown cells remain distinct from known unpainted cells.
 */
export const nativePixelWindow = (
  snapshot: NativePixelSnapshot,
  rect: PixelRect,
): NativePixelWindow => {
  const length = rect.width * rect.height
  const indices = new Uint8Array(length).fill(TRANSPARENT_INDEX)
  const known = new Uint8Array(length)
  const drafted = new Uint8Array(length)

  for (const region of snapshot.committed) {
    const overlap = intersectRects(rect, region)
    if (overlap === null) continue
    for (let y = overlap.y; y < overlap.y + overlap.height; y++) {
      let sourceAt = (y - region.y) * region.width + (overlap.x - region.x)
      let targetAt = (y - rect.y) * rect.width + (overlap.x - rect.x)
      for (let x = 0; x < overlap.width; x++, sourceAt++, targetAt++) {
        const index = region.pixels[sourceAt]
        if (index === undefined) continue
        indices[targetAt] = index === region.emptyIndex ? TRANSPARENT_INDEX : index
        known[targetAt] = 1
      }
    }
  }

  for (const region of snapshot.draft) {
    const overlap = intersectRects(rect, region)
    if (overlap === null) continue
    for (let y = overlap.y; y < overlap.y + overlap.height; y++) {
      let sourceAt = (y - region.y) * region.width + (overlap.x - region.x)
      let targetAt = (y - rect.y) * rect.width + (overlap.x - rect.x)
      for (let x = 0; x < overlap.width; x++, sourceAt++, targetAt++) {
        const index = region.pixels[sourceAt]
        if (index === undefined || !draftPresent(region, sourceAt, index)) continue
        indices[targetAt] = draftIndex(region, sourceAt, index)
        known[targetAt] = 1
        drafted[targetAt] = 1
      }
    }
  }

  return { ...rect, indices, known, drafted }
}
