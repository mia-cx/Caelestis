import {
  BLANK,
  MATCH,
  type MismatchClass,
  PALETTE_SIZE,
  TRANSPARENT_INDEX,
  WRONG,
} from '@caelestis/shared'
import type { Appearance } from './appearance.js'
import type { TemplateArtwork } from './catalog.js'
import type { TemplateColourProgress, TemplateProgress } from './progress-types.js'

/**
 * The accounting rules every pixel source shares: how a placed pixel classifies against the wanted
 * one, when unpainted pixels are worth marking, and how classified counts become progress. World
 * tiles and the alliance artboard differ only in where the placed pixels come from.
 *
 * `scanTile` spells `classifyPixel` out inline, because it is stringified into a worker.
 */

/** How a placed pixel compares with the wanted one; `empty` is the source's "nothing placed". */
export const classifyPixel = (wanted: number, placed: number, empty: number): MismatchClass =>
  placed === wanted ? MATCH : placed === empty ? BLANK : WRONG

/**
 * Whether a template is finished enough for its unpainted pixels to be worth marking.
 *
 * Judged over the pixels known so far, with display filters applied, because a template is only
 * ever partly loaded. The known pixels are the ones in front of someone, so the ratio settles as
 * more of them arrive rather than being wrong until the last one does.
 */
export const countsUnpainted = (
  appearance: Pick<Appearance, 'markUnpainted' | 'unpaintedLimit'>,
  asserted: number,
  unpainted: number,
): boolean =>
  appearance.markUnpainted && asserted > 0 && unpainted / asserted <= appearance.unpaintedLimit

/** Classified counts of one template; `byColour` is `[completed, mismatched, unpainted]` per index. */
export interface ProgressCounts {
  readonly completed: number
  readonly mismatched: number
  readonly unpainted: number
  /** Pixels classified at all; the rest are not known yet. */
  readonly asserted: number
  readonly byColour: Uint32Array
}

/** One template's slot in `byColour`, laid out so a `MismatchClass` is its offset. */
export const colourSlot = (index: number, classification: MismatchClass): number =>
  index * 3 + classification

/** Progress from counted pixels; with no counts every pixel is still unknown. */
export const progressFrom = (
  counts: ProgressCounts | undefined,
  opaque: number,
): TemplateProgress => {
  const total = Math.max(0, opaque)
  if (counts === undefined) return { completed: 0, mismatched: 0, unpainted: 0, known: 0, total }
  const known = Math.min(total, counts.asserted)
  return {
    completed: Math.min(known, counts.completed),
    mismatched: Math.min(known, counts.mismatched),
    unpainted: Math.min(known, counts.unpainted),
    known,
    total,
  }
}

/** Total requested pixels by palette index, cached by artwork so they survive eviction. */
const colourTotals = new WeakMap<TemplateArtwork, Uint32Array>()

/** Null for an evicted artwork whose totals were never counted. */
export const colourTotalsFor = (artwork: TemplateArtwork): Uint32Array | null => {
  const cached = colourTotals.get(artwork)
  if (cached !== undefined) return cached
  const pixels = artwork.pixels
  if (pixels === null) return null
  const totals = new Uint32Array(PALETTE_SIZE)
  for (const chunk of pixels.chunks.values()) {
    for (const index of chunk.indices) {
      if (index < PALETTE_SIZE && index !== TRANSPARENT_INDEX)
        totals[index] = (totals[index] ?? 0) + 1
    }
  }
  colourTotals.set(artwork, totals)
  return totals
}

/** Exact progress for every colour the artwork contains. */
export const colourProgressFrom = (
  artwork: TemplateArtwork,
  counts: ProgressCounts | undefined,
): readonly TemplateColourProgress[] => {
  const totals = colourTotalsFor(artwork)
  if (totals === null) return []
  const current = counts?.byColour
  const progress: TemplateColourProgress[] = []
  for (let index = 0; index < totals.length; index++) {
    const total = totals[index] ?? 0
    if (total === 0) continue
    const completed = Math.min(total, current?.[colourSlot(index, MATCH)] ?? 0)
    const mismatched = Math.min(total - completed, current?.[colourSlot(index, WRONG)] ?? 0)
    const unpainted = Math.min(
      total - completed - mismatched,
      current?.[colourSlot(index, BLANK)] ?? 0,
    )
    progress.push({
      index,
      completed,
      mismatched,
      unpainted,
      known: completed + mismatched + unpainted,
      total,
    })
  }
  return progress
}

/** Counts and the template artwork and signature they were counted against. */
export interface Part<C> {
  readonly artwork: TemplateArtwork
  readonly key: string
  readonly counts: C
}

const sameBasis = (left: Part<unknown>, right: Part<unknown>): boolean =>
  left.artwork === right.artwork && left.key === right.key

/** How parts fold into a total. `subtract` answers null once nothing is left. */
export interface Folding<P, T> {
  readonly add: (total: T | undefined, part: P) => T
  readonly subtract: (total: T, part: P) => T | null
}

/** Where an entry keeps its part of one tally. */
export interface Slot<E, P> {
  readonly get: (entry: E) => Part<P> | null
  readonly set: (entry: E, part: Part<P> | null) => void
}

/**
 * One running total per template, summed from parts its entries hold.
 *
 * A total only ever sums parts counted on one basis: setting a part drops the template's parts on
 * any other artwork or signature first, so a moved or re-imported template starts again rather
 * than adding new counts to old ones.
 */
export class Tally<E, P, T> {
  private readonly totals = new Map<string, Part<T>>()

  constructor(
    private readonly folding: Folding<P, T>,
    private readonly slot: Slot<E, P>,
  ) {}

  /** Replace `entry`'s part; `siblings` are the template's other entries. */
  set(templateId: string, entry: E, part: Part<P>, siblings: Iterable<E>): void {
    for (const sibling of siblings) {
      const held = this.slot.get(sibling)
      if (held !== null && !sameBasis(held, part)) this.clear(templateId, sibling)
    }
    this.clear(templateId, entry)
    this.slot.set(entry, part)
    const total = this.totals.get(templateId)
    this.totals.set(templateId, {
      artwork: part.artwork,
      key: part.key,
      counts: this.folding.add(total?.counts, part.counts),
    })
  }

  /** Take `entry`'s part out of the total. */
  clear(templateId: string, entry: E): void {
    const part = this.slot.get(entry)
    if (part === null) return
    this.slot.set(entry, null)
    const total = this.totals.get(templateId)
    if (total === undefined || !sameBasis(total, part)) return
    const counts = this.folding.subtract(total.counts, part.counts)
    if (counts === null) this.totals.delete(templateId)
    else this.totals.set(templateId, { ...total, counts })
  }

  /** The template's total, when it was counted against this artwork and signature. */
  current(templateId: string, artwork: TemplateArtwork, key: string): T | undefined {
    const total = this.totals.get(templateId)
    return total !== undefined && total.artwork === artwork && total.key === key
      ? total.counts
      : undefined
  }

  delete(templateId: string): void {
    this.totals.delete(templateId)
  }

  values(): IterableIterator<Part<T>> {
    return this.totals.values()
  }
}
