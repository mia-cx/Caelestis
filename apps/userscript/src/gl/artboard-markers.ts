import { BLANK, MATCH, type MismatchClass, TRANSPARENT_INDEX, WRONG } from '@caelestis/shared'
import { intersectRects, type PixelRect } from '../geometry.js'
import { type NativePixelSnapshot, nativePixelWindow } from '../native-pixels.js'
import type { Appearance } from '../templates/appearance.js'
import type { PlacedPixels } from '../templates/catalog.js'
import { packMismatchMark } from '../templates/mismatch-marks.js'
import { classifyPixel, countsUnpainted } from '../templates/pixel-tally.js'
import { pixelRect, type SparsePixels } from '../templates/sparse-pixels.js'

const MARKER_CHUNK_SIZE = 1_024

export interface ArtboardMarkerBatch {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly marks: Uint32Array
}

export interface ArtboardMarkerWork {
  readonly mismatch: readonly ArtboardMarkerBatch[]
  readonly selected: readonly {
    readonly index: number
    readonly batches: readonly ArtboardMarkerBatch[]
  }[]
}

interface MutableBatch {
  readonly x: number
  readonly y: number
  readonly marks: Set<number>
}

const appendMark = (
  batches: Map<string, MutableBatch>,
  x: number,
  y: number,
  wanted: number,
): void => {
  const chunkX = Math.floor(x / MARKER_CHUNK_SIZE)
  const chunkY = Math.floor(y / MARKER_CHUNK_SIZE)
  const key = `${chunkX}/${chunkY}`
  let batch = batches.get(key)
  if (batch === undefined) {
    batch = { x: chunkX * MARKER_CHUNK_SIZE, y: chunkY * MARKER_CHUNK_SIZE, marks: new Set() }
    batches.set(key, batch)
  }
  batch.marks.add(packMismatchMark(x - batch.x, y - batch.y, wanted))
}

const deleteMark = (
  batches: Map<string, MutableBatch>,
  x: number,
  y: number,
  wanted: number,
): void => {
  const key = `${Math.floor(x / MARKER_CHUNK_SIZE)}/${Math.floor(y / MARKER_CHUNK_SIZE)}`
  const batch = batches.get(key)
  if (batch === undefined) return
  batch.marks.delete(packMismatchMark(x - batch.x, y - batch.y, wanted))
  if (batch.marks.size === 0) batches.delete(key)
}

const freezeBatches = (batches: Map<string, MutableBatch>): ArtboardMarkerBatch[] =>
  [...batches.values()].map((batch) => ({
    x: batch.x,
    y: batch.y,
    width: MARKER_CHUNK_SIZE,
    height: MARKER_CHUNK_SIZE,
    marks: new Uint32Array(
      [...batch.marks].sort((left, right) => (left & 0xfffff) - (right & 0xfffff)),
    ),
  }))

interface MarkerIndexEntry {
  readonly source: SparsePixels
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
  readonly hiddenKey: string
  readonly hidden: ReadonlySet<number>
  readonly known: Uint8Array
  readonly classification: Uint8Array
  readonly wrong: Map<string, MutableBatch>
  readonly unpainted: Map<string, MutableBatch>
  readonly selected: Map<number, Map<string, MutableBatch>>
  asserted: number
  unpaintedCount: number
  cachedIncludeUnpainted: boolean | null
  cached: ArtboardMarkerWork | null
}

const hiddenKeyFor = (appearance: Appearance): string =>
  [...appearance.hiddenColours].sort((left, right) => left - right).join(',')

const selectedBatches = (entry: MarkerIndexEntry, wanted: number) => {
  let batches = entry.selected.get(wanted)
  if (batches === undefined) {
    batches = new Map()
    entry.selected.set(wanted, batches)
  }
  return batches
}

const removeClassification = (
  entry: MarkerIndexEntry,
  classification: MismatchClass,
  x: number,
  y: number,
  wanted: number,
): void => {
  if (classification === WRONG) deleteMark(entry.wrong, x, y, wanted)
  if (classification !== BLANK) return
  deleteMark(entry.unpainted, x, y, wanted)
  const selected = entry.selected.get(wanted)
  if (selected === undefined) return
  deleteMark(selected, x, y, wanted)
  if (selected.size === 0) entry.selected.delete(wanted)
}

const addClassification = (
  entry: MarkerIndexEntry,
  classification: MismatchClass,
  x: number,
  y: number,
  wanted: number,
): void => {
  if (classification === WRONG) appendMark(entry.wrong, x, y, wanted)
  if (classification !== BLANK) return
  appendMark(entry.unpainted, x, y, wanted)
  appendMark(selectedBatches(entry, wanted), x, y, wanted)
}

/**
 * Retain alliance marker classifications and patch only native pixels Wplace changed. Pixels classify
 * and the unpainted threshold applies by the same rules as world tiles (`pixel-tally.ts`).
 */
export class ArtboardMarkerIndex {
  private entry: MarkerIndexEntry | null = null
  private compared = 0

  private create(template: PlacedPixels, appearance: Appearance): MarkerIndexEntry {
    const hiddenKey = hiddenKeyFor(appearance)
    return {
      source: template.pixels,
      originX: template.originX,
      originY: template.originY,
      width: template.width,
      height: template.height,
      hiddenKey,
      hidden: new Set(appearance.hiddenColours),
      known: new Uint8Array(template.width * template.height),
      classification: new Uint8Array(template.width * template.height),
      wrong: new Map(),
      unpainted: new Map(),
      selected: new Map(),
      asserted: 0,
      unpaintedCount: 0,
      cachedIncludeUnpainted: null,
      cached: null,
    }
  }

  private matchesPixels(
    entry: MarkerIndexEntry,
    template: PlacedPixels,
    appearance: Appearance,
  ): boolean {
    return (
      entry.source === template.pixels &&
      entry.originX === template.originX &&
      entry.originY === template.originY &&
      entry.width === template.width &&
      entry.height === template.height &&
      entry.hiddenKey === hiddenKeyFor(appearance)
    )
  }

  isCurrent(template: PlacedPixels, appearance: Appearance): boolean {
    if (this.entry === null || !this.matchesPixels(this.entry, template, appearance)) return false
    const includeUnpainted = countsUnpainted(
      appearance,
      this.entry.asserted,
      this.entry.unpaintedCount,
    )
    return this.entry.cached !== null && this.entry.cachedIncludeUnpainted === includeUnpainted
  }

  hasCurrentPixels(template: PlacedPixels, appearance: Appearance): boolean {
    return this.entry !== null && this.matchesPixels(this.entry, template, appearance)
  }

  private patch(
    entry: MarkerIndexEntry,
    template: PlacedPixels,
    pixels: NativePixelSnapshot,
    dirty: PixelRect,
  ): void {
    const templateRect = {
      x: template.originX,
      y: template.originY,
      width: template.width,
      height: template.height,
    }
    const overlap = intersectRects(dirty, templateRect)
    if (overlap === null) return
    const actual = nativePixelWindow(pixels, overlap)
    const wantedHere = pixelRect(
      template.pixels,
      overlap.x - template.originX,
      overlap.y - template.originY,
      overlap.width,
      overlap.height,
    )
    this.compared += overlap.width * overlap.height
    for (let y = 0; y < overlap.height; y++) {
      for (let x = 0; x < overlap.width; x++) {
        const localX = overlap.x - template.originX + x
        const localY = overlap.y - template.originY + y
        const at = localY * template.width + localX
        const actualAt = y * overlap.width + x
        const wanted = wantedHere[actualAt] as number
        const asserted = wanted !== TRANSPARENT_INDEX && !entry.hidden.has(wanted)
        const nextKnown = asserted && actual.known[actualAt] === 1 ? 1 : 0
        const nextClassification =
          nextKnown === 0
            ? MATCH
            : classifyPixel(wanted, actual.indices[actualAt] as number, TRANSPARENT_INDEX)
        const previousKnown = entry.known[at] ?? 0
        const previousClassification = (entry.classification[at] ?? MATCH) as MismatchClass
        if (previousKnown === nextKnown && previousClassification === nextClassification) continue
        const worldX = template.originX + localX
        const worldY = template.originY + localY
        if (previousKnown === 1) entry.asserted--
        if (previousClassification === BLANK) entry.unpaintedCount--
        removeClassification(entry, previousClassification, worldX, worldY, wanted)
        entry.known[at] = nextKnown
        entry.classification[at] = nextClassification
        if (nextKnown === 1) entry.asserted++
        if (nextClassification === BLANK) entry.unpaintedCount++
        addClassification(entry, nextClassification, worldX, worldY, wanted)
        entry.cached = null
      }
    }
  }

  update(
    template: PlacedPixels,
    pixels: NativePixelSnapshot,
    appearance: Appearance,
    dirty: readonly PixelRect[] | null,
  ): ArtboardMarkerWork {
    this.compared = 0
    if (this.entry === null || !this.matchesPixels(this.entry, template, appearance)) {
      this.entry = this.create(template, appearance)
      this.patch(this.entry, template, pixels, {
        x: template.originX,
        y: template.originY,
        width: template.width,
        height: template.height,
      })
    } else if (dirty === null) {
      this.patch(this.entry, template, pixels, {
        x: template.originX,
        y: template.originY,
        width: template.width,
        height: template.height,
      })
    } else {
      for (const rect of dirty) this.patch(this.entry, template, pixels, rect)
    }

    const entry = this.entry
    const includeUnpainted = countsUnpainted(appearance, entry.asserted, entry.unpaintedCount)
    if (entry.cached !== null && entry.cachedIncludeUnpainted === includeUnpainted)
      return entry.cached
    const mismatch = new Map(entry.wrong)
    if (includeUnpainted) {
      for (const [key, unpainted] of entry.unpainted) {
        const held = mismatch.get(key)
        if (held === undefined) {
          mismatch.set(key, unpainted)
          continue
        }
        mismatch.set(key, {
          x: held.x,
          y: held.y,
          marks: new Set([...held.marks, ...unpainted.marks]),
        })
      }
    }
    entry.cached = {
      mismatch: freezeBatches(mismatch),
      selected: [...entry.selected]
        .sort(([left], [right]) => left - right)
        .map(([index, batches]) => ({ index, batches: freezeBatches(batches) })),
    }
    entry.cachedIncludeUnpainted = includeUnpainted
    return entry.cached
  }

  comparedPixels(): number {
    return this.compared
  }
}

/** A template whose pixels are in memory, with the appearance its markers follow. */
export interface ResidentTemplate {
  readonly template: PlacedPixels & { readonly id: string }
  readonly appearance: Appearance
}

/**
 * How long a moved template rests before its markers are compared at the new place.
 *
 * A comparison reads every pixel of the template, far too slow to repeat on each frame of a drag
 * or a held arrow key.
 */
const MARKER_SETTLE_MS = 150

/**
 * Every artboard template's marker work, kept current against the artboard's native pixels. A
 * template that moved hides its markers until it rests, then compares once at its new place.
 */
export class ArtboardMarkerTracker {
  private pixelsDirty = true
  private readonly dirtyRects: PixelRect[] = []
  private readonly held = new Map<
    string,
    {
      readonly index: ArtboardMarkerIndex
      readonly work: ArtboardMarkerWork
      readonly originX: number
      readonly originY: number
    }
  >()
  /** Where and when each moved template last changed place, until its markers catch up. */
  private readonly movedAt = new Map<
    string,
    { readonly x: number; readonly y: number; readonly at: number }
  >()
  /** Moving templates that skipped a native pixel change, so they compare in full once at rest. */
  private readonly missedPixels = new Set<string>()

  /** The native pixels changed everywhere. */
  invalidateAll(): void {
    this.pixelsDirty = true
    this.dirtyRects.length = 0
  }

  /** The native pixels changed inside these artboard rects. */
  invalidate(rects: readonly PixelRect[]): void {
    this.dirtyRects.push(...rects)
  }

  /** The marker work for a template as of the last `update`, if it has any. */
  work(id: string): ArtboardMarkerWork | undefined {
    return this.held.get(id)?.work
  }

  /**
   * Bring every resident template's markers up to date, reading the native pixels only when some
   * comparison needs them. Returns the templates still settling after a move, whose markers belong
   * to where they were, and how many pixels were compared.
   */
  update(
    resident: readonly ResidentTemplate[],
    now: number,
    readPixels: () => NativePixelSnapshot,
  ): { readonly placing: ReadonlySet<string>; readonly comparedPixels: number } {
    const residentIds = new Set(resident.map(({ template }) => template.id))
    const placing = new Set<string>()
    for (const { template } of resident) {
      const held = this.held.get(template.id)
      if (
        held === undefined ||
        (held.originX === template.originX && held.originY === template.originY)
      ) {
        this.movedAt.delete(template.id)
        continue
      }
      const last = this.movedAt.get(template.id)
      if (last === undefined || last.x !== template.originX || last.y !== template.originY) {
        this.movedAt.set(template.id, { x: template.originX, y: template.originY, at: now })
        placing.add(template.id)
      } else if (now - last.at < MARKER_SETTLE_MS) placing.add(template.id)
    }
    for (const id of this.movedAt.keys()) if (!residentIds.has(id)) this.movedAt.delete(id)
    for (const id of this.missedPixels) if (!residentIds.has(id)) this.missedPixels.delete(id)
    const staleIds = new Set(
      resident
        .filter(({ template, appearance }) => {
          if (placing.has(template.id)) return false
          if (this.missedPixels.has(template.id)) return true
          const held = this.held.get(template.id)
          return held === undefined || !held.index.isCurrent(template, appearance)
        })
        .map(({ template }) => template.id),
    )
    let comparedPixels = 0
    if (this.pixelsDirty || this.dirtyRects.length > 0 || staleIds.size > 0) {
      const regions = readPixels()
      const pixelsChanged = this.pixelsDirty || this.dirtyRects.length > 0
      for (const { template, appearance } of resident) {
        if (placing.has(template.id)) {
          if (pixelsChanged) this.missedPixels.add(template.id)
          continue
        }
        const held = this.held.get(template.id)
        const rebuild =
          this.missedPixels.delete(template.id) ||
          this.pixelsDirty ||
          held === undefined ||
          !held.index.hasCurrentPixels(template, appearance)
        const intersectsDirty = this.dirtyRects.some(
          (dirty) =>
            dirty.x < template.originX + template.width &&
            dirty.x + dirty.width > template.originX &&
            dirty.y < template.originY + template.height &&
            dirty.y + dirty.height > template.originY,
        )
        if (!rebuild && !intersectsDirty && !staleIds.has(template.id)) continue
        const index = held?.index ?? new ArtboardMarkerIndex()
        const work = index.update(template, regions, appearance, rebuild ? null : this.dirtyRects)
        comparedPixels += index.comparedPixels()
        this.held.set(template.id, {
          index,
          work,
          originX: template.originX,
          originY: template.originY,
        })
      }
      this.pixelsDirty = false
      this.dirtyRects.length = 0
    }
    for (const id of this.held.keys()) if (!residentIds.has(id)) this.held.delete(id)
    return { placing, comparedPixels }
  }
}
