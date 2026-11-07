import type { MismatchMarks } from './mismatch-marks.js'

/** Set on a slot whose mark was removed. The coordinate stays, so the sorted run stays sorted. */
export const DEAD_MARK = 0x8000_0000

const COORDINATE_MASK = 0xf_ffff

const coordinateOf = (mark: number): number => mark & COORDINATE_MASK

/** Blocks of 32 × 32 pixels, 32 to a row, cover any tile-local 10-bit coordinate. */
const BLOCK_SHIFT = 5
export const MARK_BLOCK_SIZE = 1 << BLOCK_SHIFT
export const MARK_BLOCKS_PER_ROW = 32
const MARK_BLOCKS = MARK_BLOCKS_PER_ROW * MARK_BLOCKS_PER_ROW

/** Bits of each pixel's sampling hash. A sample rate keeps the pixels hashed below its share. */
const HASH_BITS = 22
export const MARK_HASH_LIMIT = 2 ** HASH_BITS

/** The block holding a tile-local coordinate, numbered row by row. */
const markBlock = (coordinate: number): number =>
  ((coordinate >>> (10 + BLOCK_SHIFT)) & (MARK_BLOCKS_PER_ROW - 1)) * MARK_BLOCKS_PER_ROW +
  ((coordinate & 0x3ff) >>> BLOCK_SHIFT)

/** Per-tile hash seed, so neighbouring tiles do not sample the same pattern. */
export const markSeed = (tileX: number, tileY: number): number =>
  (Math.imul(tileX, 73_856_093) ^ Math.imul(tileY, 19_349_663)) >>> 0

/** The marker shader's hash, exactly: a pixel's side of any sample rate depends on it alone. */
export const markHash = (coordinate: number, seed: number): number => {
  let value = (coordinate ^ seed) >>> 0
  value = Math.imul(value ^ (value >>> 16), 0x7feb_352d) >>> 0
  value = Math.imul(value ^ (value >>> 15), 0x846c_a68b) >>> 0
  return (value ^ (value >>> 16)) >>> (32 - HASH_BITS)
}

/** Sort key: the block first, then the sampling hash within it. */
const keyOf = (coordinate: number, seed: number): number =>
  (markBlock(coordinate) * MARK_HASH_LIMIT + markHash(coordinate, seed)) >>> 0

/** These marks reordered by key, in a fresh array. Two 16-bit radix passes for large lists. */
const sortedByKey = (marks: ArrayLike<number>, seed: number): Uint32Array => {
  const length = marks.length
  let keys = new Uint32Array(length)
  let order = Uint32Array.from(marks)
  for (let at = 0; at < length; at++) keys[at] = keyOf(coordinateOf(order[at] as number), seed)
  if (length < 4_096) {
    const indices = Array.from({ length }, (_, at) => at)
    indices.sort((left, right) => (keys[left] as number) - (keys[right] as number))
    return Uint32Array.from(indices, (at) => order[at] as number)
  }
  let nextKeys = new Uint32Array(length)
  let nextOrder = new Uint32Array(length)
  for (const shift of [0, 16]) {
    const starts = new Uint32Array(0x1_0001)
    for (let at = 0; at < length; at++) {
      const digit = (((keys[at] as number) >>> shift) & 0xffff) + 1
      starts[digit] = (starts[digit] as number) + 1
    }
    for (let digit = 1; digit < starts.length; digit++)
      starts[digit] = (starts[digit] as number) + (starts[digit - 1] as number)
    for (let at = 0; at < length; at++) {
      const key = keys[at] as number
      const digit = (key >>> shift) & 0xffff
      const to = starts[digit] as number
      starts[digit] = to + 1
      nextKeys[to] = key
      nextOrder[to] = order[at] as number
    }
    ;[keys, nextKeys] = [nextKeys, keys]
    ;[order, nextOrder] = [nextOrder, order]
  }
  return order
}

/**
 * Room for marks added after a scan: an eighth of the list, between 16 and 16,384 slots.
 *
 * The tail is submitted whole for the shader to sample, so its size is vertex work the budget
 * cannot bound; the cap keeps that to at most 16,384 points. Below the cap, room is proportional to
 * the list, so the compaction a full tail triggers costs each addition a constant share. Above it,
 * a million-mark list compacts once per 16,384 additions, about 61 slot moves for each of them.
 */
const MAX_TAIL = 16_384
const tailRoom = (sorted: number): number => Math.min(MAX_TAIL, Math.max(16, sorted >>> 3))

/**
 * Most changes the log holds. Past it, the oldest half is dropped.
 *
 * Lists nobody draws are patched too, so this bounds their logs to a few kilobytes. A consumer
 * keeps catching up slot by slot as long as it reads within the last half of the window, which a
 * renderer drawing every frame does; only one further behind re-reads every slot.
 */
const LOG_LIMIT = 1_024

/**
 * One tile's marker list, patched one painted pixel at a time without copying it.
 *
 * Slots `[0, sorted)` are ordered by 32 × 32-pixel block, then by each pixel's sampling hash. So a
 * block's marks are one run, and the marks a sample rate keeps are that run's first part: the
 * renderer submits those and nothing else. A removed mark stays in its slot flagged `DEAD_MARK`, so
 * undoing the paint revives that slot. A coordinate with no slot appends to a tail after the sorted
 * run, found again through a coordinate index. Every change touches one slot, which `changesSince`
 * names, so a GPU copy re-uploads that slot and nothing else.
 *
 * `slots` is replaced only by compaction, which drops dead slots and sorts the tail back into the
 * run once either outgrows its share. A consumer holding the old `slots` re-reads everything.
 * Both shares grow with the list (see `tailRoom` for the tail's cap), so compaction amortises to a
 * small share of the list per change.
 */
export class MarkList {
  /** Live and dead marks in `[0, length)`, then spare room for the tail. */
  slots: Uint32Array
  length: number
  /** Slots `[0, sorted)` are in key order; the tail after them is in append order. */
  sorted: number
  live: number
  /** Bumped by every changed slot. */
  revision = 0
  private log: number[] = []
  private logStart = 0
  /** Tail slots by coordinate. */
  private readonly tail = new Map<number, number>()
  /** Where each block's run starts in the current `slots`, with the run's end last. */
  private starts: Uint32Array | null = null
  private ends: { readonly threshold: number; readonly at: Uint32Array } | null = null

  private constructor(
    slots: Uint32Array,
    length: number,
    /** The tile's hash seed; see `markSeed`. */
    readonly seed: number,
  ) {
    this.slots = slots
    this.length = length
    this.sorted = length
    this.live = length
  }

  /** Copy marks, in any order, into a patchable list with room for marks painted later. */
  static of(marks: ArrayLike<number>, seed: number): MarkList {
    const slots = new Uint32Array(marks.length + tailRoom(marks.length))
    slots.set(sortedByKey(marks, seed))
    return new MarkList(slots, marks.length, seed)
  }

  /** First sorted slot whose key is at least `key`, searching `[low, high)`. */
  private lowerBound(key: number, low = 0, high = this.sorted): number {
    while (low < high) {
      const middle = (low + high) >>> 1
      if (keyOf(coordinateOf(this.slots[middle] as number), this.seed) < key) low = middle + 1
      else high = middle
    }
    return low
  }

  /** The slot holding this coordinate, live or dead, or -1. */
  find(coordinate: number): number {
    const key = keyOf(coordinate, this.seed)
    // Distinct pixels can share a key; they sit together, so check each.
    for (let slot = this.lowerBound(key); slot < this.sorted; slot++) {
      const held = coordinateOf(this.slots[slot] as number)
      if (held === coordinate) return slot
      if (keyOf(held, this.seed) !== key) break
    }
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

  /** The start of each block's run in the sorted slots, then the run's end. Valid until compaction. */
  blockStarts(): Uint32Array {
    if (this.starts !== null) return this.starts
    const starts = new Uint32Array(MARK_BLOCKS + 1)
    for (let block = 0; block < MARK_BLOCKS; block++)
      starts[block] = this.lowerBound(block * MARK_HASH_LIMIT)
    starts[MARK_BLOCKS] = this.sorted
    this.starts = starts
    return starts
  }

  /**
   * Where each block's kept marks end, for a sample with hash `threshold`.
   *
   * Kept for the last threshold asked about, until compaction. Patches never move a slot, so the
   * ends stay true while painting, and a renderer drawing at a steady rate searches nothing.
   */
  sampledEnds(threshold: number): Uint32Array {
    if (this.ends?.threshold === threshold) return this.ends.at
    const starts = this.blockStarts()
    // Rewritten in place: the table's size never changes, and zooming changes thresholds often.
    const at = this.ends?.at ?? new Uint32Array(MARK_BLOCKS)
    for (let block = 0; block < MARK_BLOCKS; block++)
      at[block] = this.lowerBound(
        block * MARK_HASH_LIMIT + threshold,
        starts[block] as number,
        starts[block + 1] as number,
      )
    this.ends = { threshold, at }
    return at
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
    const live: number[] = []
    for (let slot = 0; slot < this.length; slot++) {
      const mark = this.slots[slot] as number
      if ((mark & DEAD_MARK) === 0) live.push(mark)
    }
    return Uint32Array.from(live).sort((left, right) => coordinateOf(left) - coordinateOf(right))
  }

  /** The slots and the block tables drawing has built for them. */
  get byteLength(): number {
    return this.slots.byteLength + (this.starts?.byteLength ?? 0) + (this.ends?.at.byteLength ?? 0)
  }

  private write(slot: number, mark: number): void {
    this.slots[slot] = mark
    this.revision++
    this.log.push(slot)
    if (this.log.length <= LOG_LIMIT) return
    const dropped = LOG_LIMIT >>> 1
    this.log.splice(0, dropped)
    this.logStart += dropped
  }

  /** Drop dead slots and sort the tail into the run, in fresh `slots`. */
  private compact(): void {
    const live: number[] = []
    for (let slot = 0; slot < this.length; slot++) {
      const mark = this.slots[slot] as number
      if ((mark & DEAD_MARK) === 0) live.push(mark)
    }
    this.slots = new Uint32Array(live.length + tailRoom(live.length))
    this.slots.set(sortedByKey(live, this.seed))
    this.length = live.length
    this.sorted = live.length
    this.live = live.length
    this.tail.clear()
    this.starts = null
    this.ends = null
    this.revision++
    this.log = []
    this.logStart = this.revision
  }
}

const fixed = new WeakMap<MismatchMarks, MarkList>()

/** A list nobody patches, ordered once and kept, so its GPU copy is kept across frames. */
export const fixedMarkList = (marks: MismatchMarks, seed: number): MarkList => {
  const held = fixed.get(marks)
  if (held !== undefined) return held
  const list = MarkList.of(marks, seed)
  fixed.set(marks, list)
  return list
}
