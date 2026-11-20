import { BLANK, MATCH, PALETTE_SIZE, TRANSPARENT_INDEX } from '@caelestis/shared'
import { artboardPixelsFor } from '../active-artboard.js'
import type { ArtboardPixels } from '../gl/artboard-pixels.js'
import { type NativePixelSnapshot, nativePixelWindow } from '../native-pixels.js'
import type { PlacedPixels, PlacedTemplate, TemplateArtwork } from './catalog.js'
import { classifyPixel, colourSlot, type ProgressCounts } from './pixel-tally.js'
import type { ColourTargetKind } from './progress-types.js'
import { forEachPixel, type SparsePixels } from './sparse-pixels.js'

/**
 * The alliance artboard as a pixel source for template accounting: Wplace's native art, read as
 * one snapshot per template rather than per tile. Native art normalizes an empty pixel to the
 * transparent index, so that is this source's "nothing placed".
 */

const nativeWindow = (template: PlacedPixels, pixels: NativePixelSnapshot) =>
  nativePixelWindow(pixels, {
    x: template.originX,
    y: template.originY,
    width: template.width,
    height: template.height,
  })

const countArtboard = (template: PlacedPixels, pixels: NativePixelSnapshot): ProgressCounts => {
  const { known, indices } = nativeWindow(template, pixels)
  const byColour = new Uint32Array(PALETTE_SIZE * 3)
  const counts = { completed: 0, mismatched: 0, unpainted: 0, asserted: 0, byColour }
  forEachPixel(template.pixels, (wanted, at) => {
    if (wanted === TRANSPARENT_INDEX || known[at] !== 1) return
    const classification = classifyPixel(wanted, indices[at] as number, TRANSPARENT_INDEX)
    counts.asserted++
    if (classification === MATCH) counts.completed++
    else if (classification === BLANK) counts.unpainted++
    else counts.mismatched++
    const slot = colourSlot(wanted, classification)
    byColour[slot] = (byColour[slot] ?? 0) + 1
  })
  return counts
}

interface Counted {
  readonly originX: number
  readonly originY: number
  readonly revision: number
  readonly counts: ProgressCounts
}

/** The last count per template pixels, shared by every progress reader. */
const counted = new WeakMap<SparsePixels, Counted>()

/**
 * Classified counts from the native artboard pixels Wplace has loaded. Reuses the last count while
 * the template's pixels, its origin and the read's revision hold.
 */
export const artboardCounts = (template: PlacedPixels, pixels: ArtboardPixels): ProgressCounts => {
  const held = counted.get(template.pixels)
  if (
    held !== undefined &&
    held.revision === pixels.revision &&
    held.originX === template.originX &&
    held.originY === template.originY
  )
    return held.counts
  const counts = countArtboard(template, pixels)
  counted.set(template.pixels, {
    originX: template.originX,
    originY: template.originY,
    revision: pixels.revision,
    counts,
  })
  return counts
}

/** Counts by artwork, so an evicted template keeps the counts it had when its pixels left. */
const lastCounts = new WeakMap<TemplateArtwork, ProgressCounts>()

/** An alliance template's counts against the editor showing its surface, if one is open. */
export const artboardProgressCounts = (template: PlacedTemplate): ProgressCounts | undefined => {
  const pixels = template.artwork.pixels
  if (pixels === null) return lastCounts.get(template.artwork)
  const counts = artboardCounts({ ...template, pixels }, artboardPixelsFor(template.surface))
  lastCounts.set(template.artwork, counts)
  return counts
}

export interface ArtboardColourTarget {
  readonly x: number
  readonly y: number
  readonly kind: ColourTargetKind
}

/** Known native artboard pixels that still need one palette colour. */
export const artboardColourTargets = (
  template: PlacedPixels,
  pixels: NativePixelSnapshot,
  index: number,
): readonly ArtboardColourTarget[] => {
  const { known, indices } = nativeWindow(template, pixels)
  const targets: ArtboardColourTarget[] = []
  forEachPixel(template.pixels, (wanted, at) => {
    if (wanted !== index || known[at] !== 1) return
    const classification = classifyPixel(wanted, indices[at] as number, TRANSPARENT_INDEX)
    if (classification === MATCH) return
    targets.push({
      x: template.originX + (at % template.width),
      y: template.originY + Math.floor(at / template.width),
      kind: classification === BLANK ? 'unpainted' : 'mismatched',
    })
  })
  return targets
}
