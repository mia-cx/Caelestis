import type { MismatchMarks } from './mismatch-marks.js'

/** Set on a slot whose mark was removed. The coordinate stays, so the sorted run stays sorted. */
export const DEAD_MARK = 0x8000_0000

const COORDINATE_MASK = 0xf_ffff

const coordinateOf = (mark: number): number => mark & COORDINATE_MASK

/**
 * Room for marks added after a scan: an eighth of the list, and at least 16 slots.
 *
 * Proportional rather than capped, so the compaction that a full tail triggers comes once per that
 * many additions and costs each of them a constant share, however many marks the tile has.
 */
const tailRoom = (sorted: number): number => Math.max(16, sorted >>> 3)

/** Change log length a consumer can catch up from before it must re-read every slot. */
const LOG_LIMIT = 65_536

/**
 * One tile's marker list, patched one painted pixel at a time without copying it.
 *
 * Slots `[0, sorted)` hold the scan's marks in row-major order. A removed mark stays in its slot
 * flagged `DEAD_MARK`, so undoing the paint revives that slot. A coordinate with no slot appends to
 * a tail after the sorted run, found again through a coordinate index. Every change touches one
 * slot, which `changesSince` names, so a GPU copy re-uploads that slot and nothing else.
 *
 * `slots` is replaced only by compaction, which drops dead slots and merges the tail back into one
 * sorted run once either outgrows its share. A consumer holding the old `slots` re-reads everything.
 * Both shares are proportional to the list, so compaction amortises to a constant per change.
 */
export class MarkList {
  /** Live and dead marks in `[0, length)`, then spare room for the tail. */
  slots: Uint32Array
  length: number
  /** Slots `[0, sorted)` are in row-major order; the tail after them is in append order. */
  sorted: number
  live: number
  /** Bumped by every changed slot. */
  revision = 0
  private log: number[] = []
  private logStart = 0
  /** Tail slots by coordinate. */
  private readonly tail = new Map<number, number>()

  private constructor(slots: Uint32Array, length: number) {
    this.slots = slots
    this.length = length
    this.sorted = length
    this.live = length
  }

  /** Copy one sorted scan result into a patchable list with room for marks painted later. */
  static of(marks: MismatchMarks): MarkList {
    const slots = new Uint32Array(marks.length + tailRoom(marks.length))
    slots.set(marks)
    return new MarkList(slots, marks.length)
  }

  /** Use these marks as the slots, without room to grow. See `fixedMarkList`. */
  static wrap(marks: MismatchMarks): MarkList {
    return new MarkList(marks, marks.length)
  }

  /** The slot holding this coordinate, live or dead, or -1. */
  find(coordinate: number): number {
    let low = 0
    let high = this.sorted
    while (low < high) {
      const middle = (low + high) >>> 1
      if (coordinateOf(this.slots[middle] as number) < coordinate) low = middle + 1
      else high = middle
    }
    if (low < this.sorted && coordinateOf(this.slots[low] as number) === coordinate) return low
    return this.tail.get(coordinate) ?? -1
  }

  has(coordinate: number): boolean {
    const slot = this.find(coordinate)
    return slot >= 0 && ((this.slots[slot] as number) & DEAD_MARK) === 0
  }

  /** Mark this pixel, reviving its slot when it had one. */
  add(mark: number): void {
    const slot = this.find(coordinateOf(mark))
    if (slot >= 0) {
      const held = this.slots[slot] as number
      if (held === mark) return
      if ((held & DEAD_MARK) !== 0) this.live++
      this.write(slot, mark)
      return
    }
    if (this.length === this.slots.length) this.compact()
    this.live++
    this.tail.set(coordinateOf(mark), this.length)
    this.write(this.length++, mark)
  }

  /** Clear this pixel's mark, keeping its slot for a later undo. */
  remove(coordinate: number): void {
    const slot = this.find(coordinate)
    if (slot < 0) return
    const held = this.slots[slot] as number
    if ((held & DEAD_MARK) !== 0) return
    this.live--
    this.write(slot, (held | DEAD_MARK) >>> 0)
    const dead = this.length - this.live
    if (dead > tailRoom(this.sorted) && dead * 4 > this.length) this.compact()
  }

  /**
   * Slots changed after `revision`, in change order and possibly repeated, or null when the log no
   * longer reaches back that far. Null also follows compaction, which replaces `slots`.
   */
  changesSince(revision: number): readonly number[] | null {
    if (revision < this.logStart || revision > this.revision) return null
    return this.log.slice(revision - this.logStart)
  }

  /** The live marks in row-major order, as a fresh scan would list them. */
  values(): MismatchMarks {
    const sorted: number[] = []
    for (let slot = 0; slot < this.sorted; slot++) {
      const mark = this.slots[slot] as number
      if ((mark & DEAD_MARK) === 0) sorted.push(mark)
    }
    const tail: number[] = []
    for (let slot = this.sorted; slot < this.length; slot++) {
      const mark = this.slots[slot] as number
      if ((mark & DEAD_MARK) === 0) tail.push(mark)
    }
    tail.sort((left, right) => coordinateOf(left) - coordinateOf(right))
    const merged = new Uint32Array(sorted.length + tail.length)
    let left = 0
    let right = 0
    for (let write = 0; write < merged.length; write++) {
      const next =
        right >= tail.length ||
        (left < sorted.length &&
          coordinateOf(sorted[left] as number) <= coordinateOf(tail[right] as number))
          ? sorted[left++]
          : tail[right++]
      merged[write] = next as number
    }
    return merged
  }

  get byteLength(): number {
    return this.slots.byteLength
  }

  private write(slot: number, mark: number): void {
    this.slots[slot] = mark
    this.revision++
    if (this.log.length >= LOG_LIMIT) {
      this.log = []
      this.logStart = this.revision
      return
    }
    this.log.push(slot)
  }

  /** Drop dead slots and merge the tail into one sorted run, in fresh `slots`. */
  private compact(): void {
    const marks = this.values()
    this.slots = new Uint32Array(marks.length + tailRoom(marks.length))
    this.slots.set(marks)
    this.length = marks.length
    this.sorted = marks.length
    this.live = marks.length
    this.tail.clear()
    this.revision++
    this.log = []
    this.logStart = this.revision
  }
}

const wrapped = new WeakMap<MismatchMarks, MarkList>()

/**
 * A list nobody patches, wrapped without copying, and once, so its GPU copy is kept across frames.
 *
 * The marks themselves become the slots, so the list must not be patched: it has no spare room and
 * would compact into a copy on its first `add`.
 */
export const fixedMarkList = (marks: MismatchMarks): MarkList => {
  const held = wrapped.get(marks)
  if (held !== undefined) return held
  const list = MarkList.wrap(marks)
  wrapped.set(marks, list)
  return list
}
