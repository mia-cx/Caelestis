import {
  BLANK,
  MATCH,
  type MismatchClass,
  type MismatchMask,
  mismatchClassAt,
  PALETTE_SIZE,
  parseTileKey,
  TILE_SIZE,
  type TileCoord,
  TRANSPARENT_INDEX,
  WORLD_PIXELS,
} from '@caelestis/shared'
import { count } from '../debug.js'
import {
  comparisonDraftPixelAt,
  comparisonDraftPixels,
  draftedPixelOffsets,
  draftPixels,
} from '../draft-pixels.js'
import { UNPAINTED } from '../native-pixels.js'
import { onTilePixels } from '../pixel-changes.js'
import { pixelObservationOf } from '../pixel-observation.js'
import { measureProfile, registerProfileMemorySource } from '../profile.js'
import {
  beginServerMismatchFrame,
  serverMismatchMaskFor as currentServerMismatchMaskFor,
  endServerMismatchFrame,
  onServerMismatchesChanged,
} from '../server-mismatch.js'
import {
  ensureTilePixels,
  onTilePixelsAvailable,
  onTilePixelsEvicted,
  tilePixels,
} from '../tile-pixels.js'
import { artboardProgressCounts } from './artboard-accounting.js'
import {
  announceCaptureScope,
  captureScopeTiles,
  forgetProgressPixels,
  onCaptureScopeChange,
  requestProgressPixels,
  settleProgressPixels,
  worldTemplates,
} from './capture-scope.js'
import {
  appearanceOf,
  onLocalChange,
  type PlacedTemplate,
  type TemplateArtwork,
  wrapsX,
} from './catalog.js'
import { claimedHiddenFor } from './colour-filter.js'
import { nearestColourTarget } from './colour-navigation.js'
import { MarkList, markSeed } from './mark-list.js'
import { markWanted, packMismatchMark } from './mismatch-marks.js'
import { type ScanJob, type ScanOutcome, scanTile } from './mismatch-scan.js'
import { forgetInWorker, hasWorker, releaseInWorker, scanInWorker } from './mismatch-worker.js'
import {
  classifyPixel,
  colourProgressFrom,
  countsUnpainted,
  type Part,
  type ProgressCounts,
  progressFrom,
  Tally,
} from './pixel-tally.js'
import { horizontalSpans, sourceXAt } from './placement.js'
import type {
  Mismatches,
  TemplateDraftPixelDelta,
  TemplatePixelAccounting,
  TilePixelAccounting,
} from './progress-types.js'
import { pixelAt, pixelRect, type SparsePixels } from './sparse-pixels.js'
import {
  type TemplateTileKey,
  templateIdOf,
  templateTileKey,
  tileOf,
  tileSuffix,
} from './template-tile.js'

/*
 * Which pixels of a template the canvas disagrees with, per tile, and the progress counts that
 * follow from it. {@link pixelAccounting} is the whole public interface.
 *
 * Found here rather than in a shader. A template has a handful of wrong pixels and the screen has
 * millions of fragments; asking the question per fragment would make the cost scale with the wrong
 * thing, badly enough to take the GPU down. Asking it per pixel, once, and handing the answers to
 * the renderer as a list makes it scale with the number of answers.
 *
 * Once per tile per filter change, not per frame. The comparison walks the part of the template that
 * falls inside one tile — a million pixels at the very most — which is fine to do occasionally and
 * ruinous to do sixty times a second, hence the cache.
 */

/** The server a copy came from, whose masks newer exact pixels can supersede. */
const serverUrlOf = (template: PlacedTemplate): string | undefined =>
  template.origin === 'server' ? template.server.url : undefined

// A native observation replaces the mask held at that moment, not future server corrections.
const observedMasks = new WeakSet<Uint8Array>()
const serverMismatchMaskFor = (template: PlacedTemplate, tile: TileCoord): MismatchMask | null => {
  const mask = currentServerMismatchMaskFor(template, tile)
  return mask !== null && observedMasks.has(mask.packed) ? null : mask
}

interface Cached extends Omit<ScanOutcome, 'wrong' | 'unpainted'> {
  /**
   * The two kinds of disagreement, kept apart.
   *
   * Whether the second kind counts is not a property of the tile — it depends on how much of the
   * *template* is still unpainted, which is not knowable while scanning one tile of it. Deciding at
   * the point the answer is read means the threshold, and the switch above it, cost nothing to change
   * their mind about: no tile is rescanned for either.
   */
  readonly wrong: MarkList
  readonly unpainted: MarkList
  /** Identity, not contents: a new local tile or server mask is the signal to redo the answer. */
  readonly source: Uint8Array
  /** Identity of the template artwork this answer was computed against; survives eviction. */
  readonly artwork: TemplateArtwork
  readonly key: string
  /** Which coordinate lists this scan actually retained. Progress counts are always complete. */
  readonly wrongComplete: boolean
  readonly unpaintedComplete: boolean
  /** The two merged, built the first time they are asked for together. */
  both: Mismatches | null
  /** Unpainted marks of one wanted colour, for the selected-colour guide, built when first asked. */
  readonly colours: Map<number, Mismatches>
}

/**
 * Tiles a worker is already looking at, against the tile array they were asked about.
 *
 * Without this, every frame between asking and answering asks again — sixty scans in flight for one
 * tile, each with its own band copied out of it.
 */
interface PendingScan {
  readonly source: Uint8Array
  readonly artwork: TemplateArtwork
  /**
   * What the job was asked about, beyond the two byte arrays.
   *
   * The origin, the moved count and the hidden colours all change the answer while leaving both
   * arrays identical, so a reply that matched on identity alone would be stored under its old
   * signature and leave obsolete markers on screen.
   */
  readonly signature: string
  /**
   * How many patches the tile had taken when the job was built.
   *
   * A scan snapshots the draft layer into its job. A paint landing while it runs patches the cached
   * answer, and a reply computed against the pre-paint draft would overwrite that patch while
   * matching on every other term.
   */
  readonly patches: number
  /** A full answer may satisfy progress-only work, but not the other way around. */
  readonly markers: boolean
  readonly wrong: boolean
  readonly unpainted: boolean
}

/** Marker-domain counts the unpainted threshold is judged on: display filters applied. */
interface Coverage {
  readonly asserted: number
  readonly unpainted: number
}

/** Everything held for one template's part of one tile. */
interface TileEntry {
  readonly templateId: string
  answer: Cached | null
  /** Leaves with the answer: the threshold is judged over the answers in hand. */
  coverage: Part<Coverage> | null
  /**
   * Outlives the answer, so panning does not erase progress behind you. Deliberately uncapped: a
   * template can be far larger than a viewport, and evicting a scanned tile would make its progress
   * run backwards. It holds counters and identities, never pixels or coordinates.
   */
  progress: Part<ProgressCounts> | null
  inFlight: PendingScan | null
  /** Patches applied, so a scan can tell whether the ground moved under it. */
  patches: number
  /** The server whose mask newer exact pixels superseded, until those pixels are evicted. */
  superseded: string | undefined
}

/** Every template tile's entry. Entries with answers sit in least-recently-used order. */
const entries = new Map<TemplateTileKey, TileEntry>()
const keysByTemplate = new Map<string, Set<TemplateTileKey>>()

const entryFor = (key: TemplateTileKey): TileEntry => {
  const held = entries.get(key)
  if (held !== undefined) return held
  const templateId = templateIdOf(key)
  const entry: TileEntry = {
    templateId,
    answer: null,
    coverage: null,
    progress: null,
    inFlight: null,
    patches: 0,
    superseded: undefined,
  }
  entries.set(key, entry)
  const keys = keysByTemplate.get(templateId)
  if (keys === undefined) keysByTemplate.set(templateId, new Set([key]))
  else keys.add(key)
  return entry
}

function* entriesOf(templateId: string): Generator<TileEntry> {
  for (const key of keysByTemplate.get(templateId) ?? []) {
    const entry = entries.get(key)
    if (entry !== undefined) yield entry
  }
}

const dropEntry = (key: TemplateTileKey, entry: TileEntry): void => {
  entries.delete(key)
  const keys = keysByTemplate.get(entry.templateId)
  keys?.delete(key)
  if (keys?.size === 0) keysByTemplate.delete(entry.templateId)
}

/** Add or subtract sparse scan tuples from one template's dense palette counters. */
const mergeColourProgress = (target: Uint32Array, packed: Uint32Array, direction: 1 | -1): void => {
  for (let at = 0; at < packed.length; at += 4) {
    const index = packed[at]
    if (index === undefined || index >= PALETTE_SIZE) continue
    const targetAt = index * 3
    for (let offset = 0; offset < 3; offset++) {
      const value = packed[at + offset + 1] ?? 0
      target[targetAt + offset] =
        direction === 1
          ? (target[targetAt + offset] ?? 0) + value
          : Math.max(0, (target[targetAt + offset] ?? 0) - value)
    }
  }
}

const coverageTally = new Tally<TileEntry, Coverage, Coverage>(
  {
    add: (total, part) => ({
      asserted: (total?.asserted ?? 0) + part.asserted,
      unpainted: (total?.unpainted ?? 0) + part.unpainted,
    }),
    subtract: (total, part) => {
      const asserted = total.asserted - part.asserted
      return asserted <= 0 ? null : { asserted, unpainted: total.unpainted - part.unpainted }
    },
  },
  {
    get: (entry) => entry.coverage,
    set: (entry, part) => {
      entry.coverage = part
    },
  },
)

/** A part's `byColour` holds a scan's sparse `[index, completed, mismatched, unpainted]` tuples. */
const progressTally = new Tally<TileEntry, ProgressCounts, ProgressCounts>(
  {
    add: (total, part) => {
      const byColour = total?.byColour ?? new Uint32Array(PALETTE_SIZE * 3)
      mergeColourProgress(byColour, part.byColour, 1)
      return {
        completed: (total?.completed ?? 0) + part.completed,
        mismatched: (total?.mismatched ?? 0) + part.mismatched,
        unpainted: (total?.unpainted ?? 0) + part.unpainted,
        asserted: (total?.asserted ?? 0) + part.asserted,
        byColour,
      }
    },
    subtract: (total, part) => {
      const asserted = total.asserted - part.asserted
      if (asserted <= 0) return null
      mergeColourProgress(total.byColour, part.byColour, -1)
      return {
        completed: total.completed - part.completed,
        mismatched: total.mismatched - part.mismatched,
        unpainted: total.unpainted - part.unpainted,
        asserted,
        byColour: total.byColour,
      }
    },
  },
  {
    get: (entry) => entry.progress,
    set: (entry, part) => {
      entry.progress = part
    },
  },
)

type ScanCounts = Pick<
  ScanOutcome,
  'completed' | 'mismatched' | 'progressUnpainted' | 'progressAsserted' | 'progressByColour'
>

const setProgress = (
  cacheKey: TemplateTileKey,
  artwork: TemplateArtwork,
  key: string,
  outcome: ScanCounts,
): void => {
  const entry = entryFor(cacheKey)
  progressTally.set(
    entry.templateId,
    entry,
    {
      artwork,
      key,
      counts: {
        completed: outcome.completed,
        mismatched: outcome.mismatched,
        unpainted: outcome.progressUnpainted,
        asserted: outcome.progressAsserted,
        byColour: outcome.progressByColour,
      },
    },
    entriesOf(entry.templateId),
  )
}

const setCoverage = (cacheKey: TemplateTileKey, answer: Cached): void => {
  const entry = entryFor(cacheKey)
  coverageTally.set(
    entry.templateId,
    entry,
    {
      artwork: answer.artwork,
      key: answer.key,
      counts: { asserted: answer.asserted, unpainted: answer.unpainted.live },
    },
    entriesOf(entry.templateId),
  )
}

type AnswerKind = 'configured' | 'unpainted'

const collectionFor = (
  kind: AnswerKind,
): { readonly wrong: boolean; readonly unpainted: boolean } => ({
  wrong: kind !== 'unpainted',
  unpainted: true,
})

const satisfies = (
  entry: Cached,
  collection: { readonly wrong: boolean; readonly unpainted: boolean },
): boolean =>
  (!collection.wrong || entry.wrongComplete) && (!collection.unpainted || entry.unpaintedComplete)

/** Whether this template's unpainted pixels are shown, judged over the tiles scanned so far. */
const showsUnpainted = (template: PlacedTemplate): boolean => {
  const appearance = appearanceOf(template)
  if (!appearance.markUnpainted) return false
  const total = coverageTally.current(template.id, template.artwork, signature(template))
  return total !== undefined && countsUnpainted(appearance, total.asserted, total.unpainted)
}

const answerFrom = (entry: Cached, kind: AnswerKind, template: PlacedTemplate): Mismatches => {
  if (kind === 'unpainted') return entry.unpainted
  if (!showsUnpainted(template)) return entry.wrong
  // Built even while one side is empty: the first mark of the other kind then patches this list
  // rather than replacing the answer with a newly merged one.
  if (entry.both === null) {
    entry.both = MarkList.of(
      [...entry.wrong.liveMarks(), ...entry.unpainted.liveMarks()],
      entry.wrong.seed,
    )
  }
  return entry.both
}

/** The selected-colour guide's marks, filtered from the unpainted list once and then patched. */
const colourAnswerFrom = (entry: Cached, colour: number): Mismatches => {
  const held = entry.colours.get(colour)
  if (held !== undefined) return held
  const marks = entry.unpainted.liveMarks().filter((mark) => markWanted(mark) === colour)
  const list = MarkList.of(marks, entry.unpainted.seed)
  entry.colours.set(colour, list)
  return list
}

const MAX_CACHED_ANSWERS = 512
const MAX_CACHED_ANSWER_BYTES = 32 * 1024 * 1024

const mismatchMemoryBytes = (): number => {
  const buffers = new Set<ArrayBufferLike>()
  // Lists counted once each, block tables included; a narrow rescan can carry a list over.
  const lists = new Set<MarkList>()
  for (const entry of entries.values()) {
    if (entry.progress !== null) buffers.add(entry.progress.counts.byColour.buffer)
    const answer = entry.answer
    if (answer === null) continue
    lists.add(answer.wrong)
    lists.add(answer.unpainted)
    if (answer.both !== null) lists.add(answer.both)
    for (const list of answer.colours.values()) lists.add(list)
    buffers.add(answer.progressByColour.buffer)
  }
  for (const total of progressTally.values()) buffers.add(total.counts.byColour.buffer)
  let bytes = 0
  for (const list of lists) bytes += list.byteLength
  for (const buffer of buffers) bytes += buffer.byteLength
  return bytes
}

const cachedAnswerBytes = (entry: Cached): number => {
  let bytes = entry.wrong.byteLength + entry.unpainted.byteLength + (entry.both?.byteLength ?? 0)
  for (const list of entry.colours.values()) bytes += list.byteLength
  return bytes
}

/** Hold an answer and move its entry to the most recently used end. */
const remember = (cacheKey: TemplateTileKey, answer: Cached): void => {
  const entry = entryFor(cacheKey)
  entry.answer = answer
  entries.delete(cacheKey)
  entries.set(cacheKey, entry)
}

/** Bumped whenever a cached answer is patched, so a listener can tell that anything happened. */
let changed = 0

/** Monotonic token for UI caches that derive progress from mismatch state. */
const mismatchRevision = (): number => changed

const changeListeners: Array<() => void> = []
const draftChangeListeners: Array<() => void> = []

/** Call every listener; one that throws must not stop the rest. */
const emit = (listeners: readonly (() => void)[], failure: string): void => {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      count(failure)
    }
  }
}

/**
 * One notification per task, however many answers changed in it.
 *
 * The listener is a full redraw, and a tile re-read announces every pixel that moved, so without
 * coalescing a neighbouring group painting two hundred pixels of your template means two hundred
 * synchronous repaints in one microtask. Coalescing is safe because the listener asks "draw the
 * current state", not "draw this change".
 */
let notifyScheduled = false

const notifyChanged = (): void => {
  if (notifyScheduled) return
  notifyScheduled = true
  queueMicrotask(() => {
    notifyScheduled = false
    emit(changeListeners, 'mismatch:listener-failed')
  })
}

/**
 * How long scanning may take in one frame, in milliseconds.
 *
 * A budget in time rather than in tiles. A scan is up to a million comparisons but usually far
 * fewer — a template covers only part of a tile, and most tiles are not covered at all — so spending
 * a slice of the frame does the cheap ones together and still never blocks on the expensive ones.
 *
 * Eight milliseconds leaves room in a 16ms frame for MapLibre to draw the map it is in the middle
 * of. This is checked *between* tiles, so one scan can still overrun it; the guarantee is that the
 * budget bounds the queue, not any single scan.
 */
const SCAN_BUDGET_MS = 8
let scanDeadline = 0
let requestedThisFrame: Set<TemplateTileKey> | null = null

/** Called once per frame by the renderer, before it asks for anything. */
const beginMismatchFrame = (): void => {
  scanDeadline = performance.now() + SCAN_BUDGET_MS
  requestedThisFrame = new Set()
  beginServerMismatchFrame()
}

/**
 * Keep every answer the current viewport requested plus a bounded offscreen working set.
 *
 * Eviction only considers offscreen answers after the frame has assembled, so a dense viewport
 * remains complete while nearby pan-back can reuse work it already paid for.
 */
const endMismatchFrame = (): void => {
  const requested = requestedThisFrame
  requestedThisFrame = null
  scanDeadline = 0
  if (requested === null) {
    endServerMismatchFrame()
    return
  }
  // Summed here rather than kept as a running total: lists grow as they are patched and gain block
  // tables when first drawn, neither of which passes through the cache.
  let answers = 0
  let cacheBytes = 0
  for (const entry of entries.values()) {
    if (entry.answer === null) continue
    answers++
    cacheBytes += cachedAnswerBytes(entry.answer)
  }
  for (const [cacheKey, entry] of entries) {
    if (answers <= MAX_CACHED_ANSWERS && cacheBytes <= MAX_CACHED_ANSWER_BYTES) break
    if (entry.answer === null || requested.has(cacheKey)) continue
    answers--
    cacheBytes -= cachedAnswerBytes(entry.answer)
    entry.answer = null
    coverageTally.clear(entry.templateId, entry)
    stale.delete(cacheKey)
  }
  for (const [cacheKey, entry] of entries) {
    if (entry.answer !== null || entry.inFlight !== null) continue
    entry.patches = 0
    if (
      entry.progress === null &&
      entry.superseded === undefined &&
      !stale.has(cacheKey) &&
      !staleProgress.has(cacheKey)
    )
      dropEntry(cacheKey, entry)
  }
  endServerMismatchFrame()
}

/**
 * Answers a frame asked for and could not afford, to be redone when the page is idle.
 *
 * A tile that has just been re-fetched needs a full rescan, and waiting for a frame to pay for it
 * means the work happens during the frame — competing with the map for the same milliseconds, at
 * exactly the moment someone is panning. Idle time is free, and until it arrives the previous answer
 * is still on screen. Both queues are visited in the order their tiles went stale.
 */
const stale = new Set<TemplateTileKey>()
/** Progress-only tiles invalidated by paint; their previous aggregate remains visible until replaced. */
const staleProgress = new Set<TemplateTileKey>()

const markStale = (cacheKey: TemplateTileKey): void => {
  entryFor(cacheKey)
  stale.add(cacheKey)
}

const markProgressStale = (cacheKey: TemplateTileKey): void => {
  entryFor(cacheKey)
  staleProgress.add(cacheKey)
}

const hasStaleTile = (tile: TileCoord): boolean => {
  const suffix = tileSuffix(tile)
  return (
    [...stale].some((cacheKey) => cacheKey.endsWith(suffix)) ||
    [...staleProgress].some((cacheKey) => cacheKey.endsWith(suffix))
  )
}

let idleScheduled = false

type IdleWindow = typeof globalThis & {
  requestIdleCallback?: (callback: (deadline: { timeRemaining: () => number }) => void) => void
}

const runIdleScan = (deadline: { timeRemaining: () => number }): void => {
  idleScheduled = false
  // Borrow the frame budget: the same guard, spending idle time instead of a frame's.
  scanDeadline = performance.now() + Math.max(deadline.timeRemaining(), 1)
  let ranOutOfTime = false
  const templatesById = new Map(worldTemplates().map((template) => [template.id, template]))
  for (const cacheKey of [...stale]) {
    if (performance.now() >= scanDeadline) {
      ranOutOfTime = true
      break
    }
    const tile = tileOf(cacheKey)
    const template = templatesById.get(templateIdOf(cacheKey))
    if (template === undefined || tile === null) {
      stale.delete(cacheKey)
      continue
    }
    mismatchesIn(template, tile)
    count('mismatch:rescanned while idle')
  }
  for (const cacheKey of [...staleProgress]) {
    if (performance.now() >= scanDeadline) {
      ranOutOfTime = true
      break
    }
    const tile = tileOf(cacheKey)
    const template = templatesById.get(templateIdOf(cacheKey))
    if (template === undefined || tile === null) {
      staleProgress.delete(cacheKey)
      settleProgressPixels(cacheKey)
      continue
    }
    progressIn(template, tile)
    count('mismatch:progress-only rescanned while idle')
  }
  scanDeadline = 0
  // A key can remain stale because its canvas pixels have not arrived yet. Retrying that key on a
  // zero-delay timer spins forever when the fetch fails. Pixel capture wakes the queue below; only
  // a scan that actually exhausted its time slice needs another immediate idle turn.
  if (ranOutOfTime && (stale.size > 0 || staleProgress.size > 0)) scheduleIdleScan()
  notifyChanged()
}

// Safari has no requestIdleCallback.
const scheduleIdleScan = (): void => {
  if (idleScheduled) return
  const idle = (globalThis as IdleWindow).requestIdleCallback
  idleScheduled = true
  if (idle !== undefined) {
    idle(runIdleScan)
    return
  }
  setTimeout(() => runIdleScan({ timeRemaining: () => SCAN_BUDGET_MS }), 0)
}

/** The switches, not what is on screen — see `claimedHiddenFor` for why the two differ. */
const assertedHidden = (template: PlacedTemplate): readonly number[] =>
  claimedHiddenFor(appearanceOf(template))

/**
 * Everything that changes what a scan finds, so a stale entry is never returned.
 *
 * "Count unpainted" is deliberately not part of it, nor is its threshold. Both decide which of two
 * lists to hand back, not what goes in them, so neither is a reason to look at a tile again.
 */
const progressSignature = (template: PlacedTemplate): string =>
  `${template.originX},${template.originY},${wrapsX(template) ? 1 : 0}|${template.moved}`

const signature = (template: PlacedTemplate): string =>
  `${progressSignature(template)}|${assertedHidden(template).join(',')}`

/** Whether a part or answer was counted against this template's artwork and signature. */
const onBasis = (
  held: { readonly artwork: TemplateArtwork; readonly key: string } | null | undefined,
  template: PlacedTemplate,
  key: string,
): boolean => held != null && held.artwork === template.artwork && held.key === key

/**
 * The tile's answer, when it is still good for this template.
 *
 * Without a source, any answer computed against this artwork and signature will do: it is what the
 * screen shows until a rescan replaces it. With one, it must also have read exactly those pixels and
 * not be waiting on a rescan.
 */
const fresh = (
  cacheKey: TemplateTileKey,
  source: Uint8Array | null,
  template: PlacedTemplate,
  key: string,
): Cached | undefined => {
  const answer = entries.get(cacheKey)?.answer
  if (answer == null || !onBasis(answer, template, key)) return undefined
  if (source === null) return answer
  return answer.source === source && !stale.has(cacheKey) ? answer : undefined
}

/**
 * Cold progress must cover the template, not merely the part currently in the viewport.
 *
 * The marker renderer naturally asks only about visible tiles, and progress built from that alone
 * treats every offscreen pixel as unknown until somebody pans over it. Queue every compact
 * local-template tile in idle time; exact capture remains bounded by the tile chase limit and wakes
 * this queue as tiles land.
 */
const queueIncompleteLocalProgress = (template: PlacedTemplate): void => {
  // An evicted template keeps the progress it had; scanning resumes when its pixels return.
  if (template.origin === 'server' || template.opaque <= 0 || template.artwork.pixels === null)
    return
  const key = progressSignature(template)
  const total = progressTally.current(template.id, template.artwork, key)
  if (total !== undefined && total.asserted >= template.opaque) return

  let pending = false
  let captureChanged = false
  for (const tileKey of template.tiles) {
    const tile = parseTileKey(tileKey)
    if (tile === null) continue
    const cacheKey = templateTileKey(template.id, tile)
    if (onBasis(entries.get(cacheKey)?.progress, template, key) && !staleProgress.has(cacheKey))
      continue
    markProgressStale(cacheKey)
    if (requestProgressPixels(cacheKey)) captureChanged = true
    pending = true
  }
  if (pending) {
    // Before the idle scan can read a stale retained copy and drop the key: a later frame is too
    // late to notice the scope grew, and the refresh it triggers is what corrects that read.
    if (captureChanged) announceCaptureScope()
    scheduleIdleScan()
    if (captureChanged) notifyChanged()
  }
}

/** A world template's counts over its scanned tiles, queueing the tiles not scanned yet. */
const worldCounts = (template: PlacedTemplate): ProgressCounts | undefined => {
  queueIncompleteLocalProgress(template)
  return progressTally.current(template.id, template.artwork, progressSignature(template))
}

/**
 * Counts from the template's pixel source. World tiles and the alliance artboard differ only here:
 * a world template sums its scanned tiles, an alliance template counts the open editor's native art.
 */
const countsFor = (template: PlacedTemplate): ProgressCounts | undefined =>
  template.surface.kind === 'world' ? worldCounts(template) : artboardProgressCounts(template)

/** What an answer is read from: a server's classification mask, or the tile's canvas pixels. */
interface TileSource {
  readonly bytes: Uint8Array
  readonly mask: MismatchMask | null
}

/** Which coordinate lists a scan retains; null for progress-only work. */
type Collection = { readonly wrong: boolean; readonly unpainted: boolean } | null

/**
 * Everything the comparison needs, gathered for whichever thread is going to run it.
 *
 * The two differ in one thing: what to send. A worker gets the rows the template actually covers,
 * sliced out so the copy is of the band rather than of a million pixels, and those slices are ours
 * to give away. Run here, nothing is copied at all — the arrays go in as they are, indexed from row
 * zero, which is what `bandTop` says.
 */
const buildJob = (
  template: PlacedTemplate,
  tile: TileCoord,
  source: TileSource,
  forWorker: boolean,
  collection: Collection,
): ScanJob => {
  const { mask } = source
  const tileLeft = tile.x * TILE_SIZE
  const tileTop = tile.y * TILE_SIZE
  const span = horizontalSpans(template).find(
    (candidate) => candidate.worldStart < tileLeft + TILE_SIZE && candidate.worldEnd > tileLeft,
  )
  const rowsTop = tileTop + (mask?.top ?? 0)
  const top = Math.max(template.originY, rowsTop)
  const bottom = Math.min(template.originY + template.height, rowsTop + (mask?.height ?? TILE_SIZE))
  const bandTop = forWorker ? Math.max(0, Math.min(TILE_SIZE, top - tileTop)) : 0
  const bandBottom = forWorker
    ? Math.max(bandTop, Math.min(TILE_SIZE, bottom - tileTop))
    : TILE_SIZE
  const band = (pixels: Uint8Array | null): Uint8Array | null => {
    if (pixels === null) return null
    return forWorker ? pixels.slice(bandTop * TILE_SIZE, bandBottom * TILE_SIZE) : pixels
  }
  const common = {
    templateKey: template.id,
    indices: null,
    width: template.width,
    height: template.height,
    originX: span === undefined ? template.originX : span.worldStart - span.sourceStart,
    originY: template.originY,
    tileX: tile.x,
    tileY: tile.y,
    tileSize: TILE_SIZE,
    bandTop,
    // The draft layer, kept beside the server's pixels rather than merged into them. A pixel placed
    // and not submitted is not on the server, so comparing against the server alone says a pixel
    // just fixed is still wrong; the comparison resolves the two rather than either owning the other.
    draft: band(
      mask === null
        ? comparisonDraftPixels(tile)
        : comparisonDraftPixels(tile, pixelObservationOf(mask.packed)),
    ),
    // A pixel we are not claiming cannot be wrong: the wildcard asserts no colour, a filtered colour
    // is one the user has said to stop caring about, and the sentinel is a state rather than a hue.
    ignored: [TRANSPARENT_INDEX, UNPAINTED, ...assertedHidden(template)],
    transparent: TRANSPARENT_INDEX,
    unpainted: UNPAINTED,
    collectMarkers: collection !== null,
    collectWrong: collection?.wrong ?? false,
    collectUnpainted: collection?.unpainted ?? false,
  }
  if (mask === null) return { ...common, kind: 'pixels', server: band(source.bytes) }
  return {
    ...common,
    kind: 'mask',
    maskLeft: mask.left,
    maskTop: mask.top,
    maskWidth: mask.width,
    maskHeight: mask.height,
    maskPacked: forWorker ? mask.packed.slice() : mask.packed,
  }
}

type ListedOutcome = Omit<ScanOutcome, 'wrong' | 'unpainted'> & Pick<Cached, 'wrong' | 'unpainted'>

const listed = (outcome: ScanOutcome, seed: number): ListedOutcome => ({
  ...outcome,
  wrong: MarkList.of(outcome.wrong, seed),
  unpainted: MarkList.of(outcome.unpainted, seed),
})

const store = (
  cacheKey: TemplateTileKey,
  source: Uint8Array,
  artwork: TemplateArtwork,
  key: string,
  progressKey: string,
  outcome: ListedOutcome,
  wrongComplete = true,
  unpaintedComplete = true,
): Cached => {
  const answer: Cached = {
    source,
    artwork,
    key,
    ...outcome,
    wrongComplete,
    unpaintedComplete,
    both: null,
    colours: new Map(),
  }
  staleProgress.delete(cacheKey)
  setCoverage(cacheKey, answer)
  setProgress(cacheKey, artwork, progressKey, answer)
  remember(cacheKey, answer)
  count('mismatch:tiles scanned')
  count('mismatch:pixels marked', outcome.wrong.live)
  count('mismatch:pixels unpainted', outcome.unpainted.live)
  return answer
}

/**
 * Retarget a scan job at the template's pixels under its tile, which is all a scan reads.
 *
 * The scan indexes its pixels by the job's origin and width, so a window the size of the overlap
 * reads exactly as the whole template did, and dense pixels exist only for the tile being scanned.
 * The key names the tile and the template's origin, so a worker holding it can tell a move from a
 * repeat. The origin is wrapped into the world: a template across the antimeridian scans each side
 * from a different virtual origin without having moved.
 */
const tileWindow = <J extends ScanJob>(job: J, wanted: SparsePixels) => {
  const tileLeft = job.tileX * job.tileSize
  const tileTop = job.tileY * job.tileSize
  const left = Math.max(job.originX, tileLeft)
  const top = Math.max(job.originY, tileTop)
  const width = Math.max(0, Math.min(job.originX + job.width, tileLeft + job.tileSize) - left)
  const height = Math.max(0, Math.min(job.originY + job.height, tileTop + job.tileSize) - top)
  const sourceX = left - job.originX
  const sourceY = top - job.originY
  const originX = ((job.originX % WORLD_PIXELS) + WORLD_PIXELS) % WORLD_PIXELS
  return {
    job: {
      ...job,
      templateKey: `${job.templateKey}|${job.tileX}/${job.tileY}|${originX},${job.originY}`,
      originX: left,
      originY: top,
      width,
      height,
    },
    read: () => pixelRect(wanted, sourceX, sourceY, width, height),
  }
}

/** Scan one tile on this thread. */
const scanWindow = (job: ScanJob, wanted: SparsePixels): ScanOutcome => {
  const window = tileWindow(job, wanted)
  return scanTile(window.job, window.read())
}

const scanListed = (job: ScanJob, wanted: SparsePixels): ListedOutcome =>
  listed(scanWindow(job, wanted), markSeed(job.tileX, job.tileY))

const requestScan = (
  template: PlacedTemplate,
  wanted: SparsePixels,
  source: Uint8Array,
  cacheKey: TemplateTileKey,
  key: string,
  job: ScanJob,
  markers = true,
): void => {
  const artwork = template.artwork
  const asked = signature(template)
  const entry = entryFor(cacheKey)
  const patchesAtStart = entry.patches
  const wrong = job.collectMarkers !== false && job.collectWrong !== false
  const unpainted = job.collectMarkers !== false && job.collectUnpainted !== false
  const pending = entry.inFlight
  if (
    pending !== null &&
    pending.source === source &&
    pending.artwork === artwork &&
    pending.signature === asked &&
    pending.patches === patchesAtStart
  ) {
    // Let a narrow answer land before asking the worker for a broader projection: replacing the
    // owner here would discard an unpainted-only reply, so the selected-colour guide would wait for
    // the slower wrong-colour scan. The next render requests only whichever projection the cached
    // narrow answer still lacks.
    if (pending.markers) stale.delete(cacheKey)
    staleProgress.delete(cacheKey)
    return
  }
  // A narrow scan can reuse only projections that were current when this job began. Starting
  // the job removes the scheduling flag, so checking staleness at reply time is too late.
  const compatible = fresh(cacheKey, source, template, key)
  // Identity by object, so the reply can tell "the entry is still mine" from "the answer is still
  // good". Folding the two together would leave an invalidated scan's entry behind, pinning its
  // captured tile (a megabyte) after the tile cache evicted its own copy.
  const mine: PendingScan = {
    source,
    artwork,
    signature: asked,
    patches: patchesAtStart,
    markers,
    wrong,
    unpainted,
  }
  entry.inFlight = mine
  if (markers) stale.delete(cacheKey)
  staleProgress.delete(cacheKey)
  const window = tileWindow(job, wanted)
  void scanInWorker(window.job, window.read, wanted).then((outcome) => {
    // Looked up again: a later request, or the template's removal, means this reply is nobody's.
    const current = entries.get(cacheKey)
    if (current?.inFlight !== mine) return
    current.inFlight = null
    if (outcome === null || current.patches !== patchesAtStart) {
      // Either no worker to be had, or the ground moved under this scan while it ran. Both mean the
      // answer is not usable and the tile still needs one, so ask again rather than dropping it.
      if (markers) markStale(cacheKey)
      markProgressStale(cacheKey)
      scheduleIdleScan()
      return
    }
    if (markers) {
      stale.delete(cacheKey)
      staleProgress.delete(cacheKey)
      store(
        cacheKey,
        source,
        artwork,
        key,
        progressSignature(template),
        {
          ...outcome,
          wrong:
            !wrong && compatible !== undefined
              ? compatible.wrong
              : MarkList.of(outcome.wrong, markSeed(job.tileX, job.tileY)),
          unpainted:
            !unpainted && compatible !== undefined
              ? compatible.unpainted
              : MarkList.of(outcome.unpainted, markSeed(job.tileX, job.tileY)),
        },
        wrong || compatible?.wrongComplete === true,
        unpainted || compatible?.unpaintedComplete === true,
      )
    } else {
      setProgress(cacheKey, artwork, progressSignature(template), outcome)
      staleProgress.delete(cacheKey)
      count('mismatch:progress-only tiles scanned')
    }
    changed++
    notifyChanged()
  })
}

/**
 * The disagreements between one template and one tile.
 *
 * Null means "not answerable yet" — the tile's pixels have not been captured — which is different
 * from an empty result, and the caller should draw nothing rather than assume agreement.
 *
 * A tile whose answer is out of date keeps showing the one it has. It is wrong by exactly the pixels
 * that have changed since, and those are patched into it as they change, so a recompute is a
 * background refresh rather than a correction — where returning null would blink every marker on the
 * tile out for as long as the rescan took.
 */
const mismatchAnswer = (
  template: PlacedTemplate,
  tile: TileCoord,
  kind: AnswerKind,
): Mismatches | null => {
  const cacheKey = templateTileKey(template.id, tile)
  requestedThisFrame?.add(cacheKey)
  const key = signature(template)
  const requested = collectionFor(kind)
  const entry = entries.get(cacheKey)
  const held = entry?.answer ?? undefined
  // Once a tile has a complete drawable answer, refresh all of its collected projections
  // together. A narrow outline refresh must not replace it with an incomplete marker result.
  const collection = {
    wrong: requested.wrong || held?.wrongComplete === true,
    unpainted: requested.unpainted || held?.unpaintedComplete === true,
  }
  /** The last answer for this artwork and signature, whatever it read. */
  const last = (): Mismatches | null => {
    const answer = fresh(cacheKey, null, template, key)
    return answer !== undefined && satisfies(answer, collection)
      ? answerFrom(answer, kind, template)
      : null
  }
  const wanted = template.artwork.pixels
  // Evicted: answer from the last scan, and scan nothing until the pixels are back.
  if (wanted === null) return last()

  const mask = serverMismatchMaskFor(template, tile)
  const superseded = entry?.superseded
  const serverUrl = serverUrlOf(template)
  if (entry !== undefined && superseded !== undefined && superseded !== serverUrl)
    entry.superseded = undefined
  const fromMask = mask !== null && superseded !== serverUrl ? mask : null
  const bytes = fromMask?.packed ?? tilePixels(tile)
  if (bytes === null) {
    // Keep the completed projection while an invalidated server mask or native tile reloads.
    // A changed template cannot reuse coordinates classified against its previous pixels/position.
    markStale(cacheKey)
    ensureTilePixels(tile)
    return last()
  }
  const source: TileSource = { bytes, mask: fromMask }

  const current = fresh(cacheKey, bytes, template, key)
  if (current !== undefined && satisfies(current, collection)) {
    remember(cacheKey, current)
    return answerFrom(current, kind, template)
  }

  if (hasWorker()) {
    requestScan(
      template,
      wanted,
      bytes,
      cacheKey,
      key,
      buildJob(template, tile, source, true, {
        wrong: collection.wrong && current?.wrongComplete !== true,
        unpainted: collection.unpainted && current?.unpaintedComplete !== true,
      }),
    )
    return held === undefined || !satisfies(held, collection)
      ? null
      : answerFrom(held, kind, template)
  }

  // No worker: canvas scans here share the frame budget and announce their answer; a server mask
  // expands at once, inside the frame that asked for it.
  const canvas = source.mask === null
  if (canvas && performance.now() >= scanDeadline) {
    markStale(cacheKey)
    scheduleIdleScan()
    if (held === undefined || !satisfies(held, collection)) return null
    count('mismatch:showed the previous answer while busy')
    return answerFrom(held, kind, template)
  }
  stale.delete(cacheKey)
  const answer = store(
    cacheKey,
    bytes,
    template.artwork,
    key,
    progressSignature(template),
    measureProfile(canvas ? 'Mismatch scan' : 'Server mismatch expansion', () =>
      scanListed(buildJob(template, tile, source, false, collection), wanted),
    ),
    collection.wrong,
    collection.unpainted,
  )
  if (canvas) {
    changed++
    notifyChanged()
  }
  return answerFrom(answer, kind, template)
}

/** Mismatches shown by the magenta marker, including unpainted only when its appearance allows it. */
const mismatchesIn = (template: PlacedTemplate, tile: TileCoord): Mismatches | null =>
  mismatchAnswer(template, tile, 'configured')

/**
 * Refresh local progress without producing marker coordinates.
 *
 * Marker visibility must not be a hidden prerequisite for the tree and paint-palette totals. This
 * uses the same comparison and worker, but asks it for aggregate counts only; no mismatch list enters
 * the marker cache or the GPU path.
 */
const progressIn = (template: PlacedTemplate, tile: TileCoord): boolean => {
  const cacheKey = templateTileKey(template.id, tile)
  requestedThisFrame?.add(cacheKey)
  const progressKey = progressSignature(template)
  if (
    onBasis(entries.get(cacheKey)?.progress, template, progressKey) &&
    !staleProgress.has(cacheKey)
  ) {
    settleProgressPixels(cacheKey)
    return true
  }
  const wanted = template.artwork.pixels
  if (wanted === null) return false

  const pixels = tilePixels(tile)
  if (pixels === null) {
    const captureChanged = requestProgressPixels(cacheKey)
    ensureTilePixels(tile)
    if (captureChanged) notifyChanged()
    return false
  }
  settleProgressPixels(cacheKey)
  const source: TileSource = { bytes: pixels, mask: null }
  if (hasWorker()) {
    requestScan(
      template,
      wanted,
      pixels,
      cacheKey,
      signature(template),
      buildJob(template, tile, source, true, null),
      false,
    )
    return true
  }
  if (performance.now() >= scanDeadline) return false

  const outcome = measureProfile('Mismatch progress scan', () =>
    scanWindow(buildJob(template, tile, source, false, null), wanted),
  )
  setProgress(cacheKey, template.artwork, progressKey, outcome)
  staleProgress.delete(cacheKey)
  changed++
  count('mismatch:progress-only tiles scanned')
  notifyChanged()
  return true
}

/**
 * Materialize every array a tile consumer can ask for from one cached classification record.
 *
 * The configured projection collects both coordinate lists in the same scan. The three returned
 * projections therefore cannot come from different source pixels, different draft moments, or
 * different worker replies. Merging the two is left to the configured projection, which needs it
 * only while unpainted pixels are shown.
 */
const tileAccountingFor = (
  template: PlacedTemplate,
  tile: TileCoord,
): TilePixelAccounting | null => {
  const markers = mismatchAnswer(template, tile, 'configured')
  if (markers === null) return null
  const answer = entries.get(templateTileKey(template.id, tile))?.answer
  if (answer == null || !answer.wrongComplete || !answer.unpaintedComplete) return null
  return { mismatched: answer.wrong, unpainted: answer.unpainted, markers }
}

/** The server mask for this tile, unless newer exact pixels superseded it. */
const currentMask = (template: PlacedTemplate, tile: TileCoord): MismatchMask | null => {
  const mask = serverMismatchMaskFor(template, tile)
  return mask !== null &&
    entries.get(templateTileKey(template.id, tile))?.superseded !== serverUrlOf(template)
    ? mask
    : null
}

/** Which list a pixel belongs in, given its class; null for none. */
const listOf = (classification: MismatchClass): 'wrong' | 'unpainted' | null =>
  classification === MATCH ? null : classification === BLANK ? 'unpainted' : 'wrong'

/**
 * Update the cached answers for a batch of changed pixels on one tile, instead of asking it again.
 *
 * Painting is the moment this matters. A placed pixel changes exactly one cell, and the write that
 * carried it already said which and to what — so rescanning a tile to find out whether the marker
 * should go is a million comparisons to learn one, on the interaction that most needs to stay
 * responsive.
 *
 * A pixel costs a lookup in each list and one slot write. The lists are patched in place rather
 * than copied, so the work follows the batch, not the number of marks on the tile.
 */
const patchTile = (tile: TileCoord, triples: readonly number[]): void => {
  // Counted whether or not this patch changes anything, so a scan in flight can see that the ground
  // moved under it and drop its result. A template's first scan has an in-flight entry and no
  // answer yet, so that counts too.
  //
  // The answered keys are a snapshot rather than a live iteration, because `remember` re-inserts
  // the entry it patches, which would move it behind a live iterator and show it to us twice.
  const suffix = tileSuffix(tile)
  const answered: Array<readonly [TemplateTileKey, TileEntry]> = []
  let invalidatedProgressOnly = false
  for (const [cacheKey, entry] of entries) {
    if (!cacheKey.endsWith(suffix)) continue
    if (entry.answer !== null || entry.inFlight !== null) entry.patches++
    if (entry.answer !== null) answered.push([cacheKey, entry])
    else if (entry.progress !== null) {
      markProgressStale(cacheKey)
      invalidatedProgressOnly = true
    }
  }
  if (invalidatedProgressOnly) {
    changed++
    count('mismatch:progress-only tile invalidated')
  }
  // Read once per batch. A tile re-read announces every pixel that moved — hundreds to thousands in
  // one go — so nothing per template belongs inside the pixel loop.
  const templatesById = new Map(worldTemplates().map((template) => [template.id, template]))
  const server = tilePixels(tile)
  for (const [cacheKey, entry] of answered) {
    const answer = entry.answer
    if (answer === null) continue
    const template = templatesById.get(entry.templateId)
    if (template === undefined || answer.artwork !== template.artwork) continue
    const pixels = template.artwork.pixels
    if (pixels === null) {
      // Evicted pixels cannot patch the answer; rescan once they are back.
      markStale(cacheKey)
      markProgressStale(cacheKey)
      continue
    }
    const hidden = assertedHidden(template)
    const serverMask = currentMask(template, tile)
    const observed = serverMask === null ? 0 : pixelObservationOf(serverMask.packed)
    let { completed, mismatched, progressUnpainted, progressByColour } = answer
    let patchedPixels = 0

    for (let i = 0; i < triples.length; i += 3) {
      const tileX = triples[i] as number
      const tileY = triples[i + 1] as number
      const localX = sourceXAt(template, tile.x * TILE_SIZE + tileX)
      const localY = tile.y * TILE_SIZE + tileY - template.originY
      if (localX === null || localY < 0 || localY >= template.height) continue
      const wanted = pixelAt(pixels, localX, localY)
      const at = tileY * TILE_SIZE + tileX

      const progressAsserted = wanted !== TRANSPARENT_INDEX && wanted !== UNPAINTED
      const hiddenFromMarkers = progressAsserted && hidden.includes(wanted)
      const asserted = progressAsserted && !hiddenFromMarkers

      // The same split the scan makes, so a patched answer and a rescanned one agree. Whether the
      // unpainted list is *shown* is decided when the answer is read, and a pixel that moves in or
      // out of that list can change the ratio it is decided by. Undefined: not knowable yet.
      const drafted = comparisonDraftPixelAt(tile, at, observed)
      const classification: MismatchClass | null =
        drafted !== UNPAINTED
          ? classifyPixel(wanted, drafted, UNPAINTED)
          : serverMask !== null
            ? mismatchClassAt(serverMask, tileX, tileY)
            : server === null
              ? null
              : classifyPixel(wanted, server[at] as number, UNPAINTED)
      const belongs = !asserted
        ? null
        : classification === null
          ? undefined
          : listOf(classification)

      if (belongs === undefined) {
        markStale(cacheKey)
        scheduleIdleScan()
        continue
      }

      const coordinate = tileX | (tileY << 10)
      const already = answer.wrong.has(coordinate)
        ? 'wrong'
        : answer.unpainted.has(coordinate)
          ? 'unpainted'
          : null
      // Marker lists deliberately carry no state for filtered colours, so they cannot tell us what
      // this pixel counted as before the patch. Re-scan that tile in idle time instead of guessing
      // and corrupting the progress total.
      if (
        hiddenFromMarkers ||
        (already === null && (!answer.wrongComplete || !answer.unpaintedComplete))
      ) {
        markStale(cacheKey)
        scheduleIdleScan()
        changed++
        notifyChanged()
        continue
      }
      if (already === belongs) continue

      const mark = packMismatchMark(tileX, tileY, wanted)
      const colour = answer.colours.get(wanted)
      if (already === 'wrong') answer.wrong.remove(coordinate)
      if (already === 'unpainted') {
        answer.unpainted.remove(coordinate)
        colour?.remove(coordinate)
      }
      if (belongs === 'wrong') answer.wrong.add(mark)
      if (belongs === 'unpainted') {
        answer.unpainted.add(mark)
        colour?.add(mark)
      }
      if (already === null) answer.both?.add(mark)
      else if (belongs === null) answer.both?.remove(coordinate)

      if (progressAsserted) {
        if (already === 'wrong') mismatched--
        else if (already === 'unpainted') progressUnpainted--
        else completed--
        if (belongs === 'wrong') mismatched++
        else if (belongs === 'unpainted') progressUnpainted++
        else completed++

        let colourAt = -1
        for (let tuple = 0; tuple < progressByColour.length; tuple += 4) {
          if (progressByColour[tuple] === wanted) {
            colourAt = tuple
            break
          }
        }
        // Copied once per batch, since the counts recorded for this answer still point at it.
        if (colourAt < 0) {
          const next = new Uint32Array(progressByColour.length + 4)
          next.set(progressByColour)
          colourAt = progressByColour.length
          next[colourAt] = wanted
          progressByColour = next
        } else if (progressByColour === answer.progressByColour) {
          progressByColour = progressByColour.slice()
        }
        const previousOffset = already === 'wrong' ? 2 : already === 'unpainted' ? 3 : 1
        const nextOffset = belongs === 'wrong' ? 2 : belongs === 'unpainted' ? 3 : 1
        progressByColour[colourAt + previousOffset] = Math.max(
          0,
          (progressByColour[colourAt + previousOffset] ?? 0) - 1,
        )
        progressByColour[colourAt + nextOffset] = (progressByColour[colourAt + nextOffset] ?? 0) + 1
      }
      patchedPixels++
      changed++
      count(belongs === null ? 'mismatch:pixel fixed' : `mismatch:pixel became ${belongs}`)
    }
    if (patchedPixels === 0) continue

    const patched: Cached = {
      ...answer,
      completed,
      mismatched,
      progressUnpainted,
      progressByColour,
    }
    setCoverage(cacheKey, patched)
    setProgress(cacheKey, patched.artwork, progressSignature(template), patched)
    remember(cacheKey, patched)
  }
}

/**
 * Notified when a cached answer changes outside a frame.
 *
 * Painting is not a map movement, so nothing asks MapLibre to draw when it happens — and a marker
 * that has been cleared in memory but not on screen is indistinguishable from one that has not been
 * cleared at all. This is what turns a patch, or a worker's answer, into a repaint.
 */
const onMismatchesChanged = (listener: () => void): void => {
  changeListeners.push(listener)
}

const MAX_PATCHED_PIXELS = 32

const draftSourceIds = new WeakMap<Uint8Array, number>()
const serverTileRevisions = new Map<string, number>()
let nextDraftSourceId = 1
let nextServerTileRevision = 1

const draftSourceBasis = (source: Uint8Array, tile: string): string => {
  let sourceId = draftSourceIds.get(source)
  if (sourceId === undefined) {
    sourceId = nextDraftSourceId++
    draftSourceIds.set(source, sourceId)
  }
  return `${sourceId}:${serverTileRevisions.get(tile) ?? 0}`
}

onTilePixels((tile, triples, source) => {
  const suffix = tileSuffix(tile)
  if (source === 'observed') {
    const pixels = tilePixels(tile)
    for (const [cacheKey, entry] of entries) {
      if (pixels === null || !cacheKey.endsWith(suffix)) continue
      for (const held of [entry.answer, entry.inFlight]) {
        if (held !== null && pixelObservationOf(held.source) <= pixelObservationOf(pixels))
          observedMasks.add(held.source)
      }
    }
  }
  if (source === 'server' && triples.length > 0) {
    serverTileRevisions.set(`${tile.x}/${tile.y}`, nextServerTileRevision++)
  }
  const before = changed
  if (triples.length / 3 > MAX_PATCHED_PIXELS) {
    const pixels = tilePixels(tile)
    const templatesById = new Map(worldTemplates().map((template) => [template.id, template]))
    let invalidated = false
    for (const [cacheKey, entry] of entries) {
      if (!cacheKey.endsWith(suffix)) continue
      const held = entry.answer ?? entry.inFlight
      if (held !== null) {
        const drawn = templatesById.get(entry.templateId)
        const serverUrl = drawn === undefined ? undefined : serverUrlOf(drawn)
        if (source === 'server' && held.source !== pixels && serverUrl !== undefined) {
          entry.superseded = serverUrl
        }
        entry.patches++
      }
      if (entry.answer !== null) markStale(cacheKey)
      else if (entry.progress !== null) markProgressStale(cacheKey)
      else continue
      invalidated = true
    }
    if (invalidated) {
      changed++
    }
  } else if (triples.length > 0) {
    patchTile(tile, triples)
  }
  if (hasStaleTile(tile)) scheduleIdleScan()
  if (source === 'draft') emit(draftChangeListeners, 'mismatch:draft-listener-failed')
  if (changed === before) return
  notifyChanged()
})

onTilePixelsAvailable((tile) => {
  if (hasStaleTile(tile)) scheduleIdleScan()
})

onServerMismatchesChanged(() => {
  changed++
  notifyChanged()
})

/** Subscribe specifically to native draft placement, repaint, undo, and clear operations. */
const onDraftsChanged = (listener: () => void): void => {
  draftChangeListeners.push(listener)
}

onTilePixelsEvicted((tile) => {
  const suffix = tileSuffix(tile)
  for (const [cacheKey, entry] of entries) {
    if (cacheKey.endsWith(suffix)) entry.superseded = undefined
  }
  serverTileRevisions.delete(`${tile.x}/${tile.y}`)
})

/** Forget everything for a template that has gone, so its tiles are not held alive by the cache. */
const forgetTemplate = (id: string): void => {
  for (const cacheKey of keysByTemplate.get(id) ?? []) {
    entries.delete(cacheKey)
    stale.delete(cacheKey)
    staleProgress.delete(cacheKey)
  }
  keysByTemplate.delete(id)
  coverageTally.delete(id)
  progressTally.delete(id)
  forgetProgressPixels(id)
  forgetInWorker(id)
}

let knownTemplateIds = new Set<string>()
onLocalChange(() => {
  const templates = worldTemplates()
  const current = new Set(templates.map((template) => template.id))
  for (const id of knownTemplateIds) {
    if (!current.has(id)) forgetTemplate(id)
  }
  knownTemplateIds = current
  // Evicted pixels leave the worker as well; answers and progress keyed on the artwork stay.
  for (const template of templates) {
    if (template.artwork.pixels === null) releaseInWorker(template.id)
  }
})

const categoryOf = (classification: MismatchClass) =>
  classification === MATCH ? 'completed' : classification === BLANK ? 'unpainted' : 'mismatched'

/** Sparse per-pixel draft corrections over captured server pixels, independent of scan coverage. */
const draftPixelDeltasFor = (template: PlacedTemplate): TemplateDraftPixelDelta[] => {
  const deltas: TemplateDraftPixelDelta[] = []
  const pixels = template.artwork.pixels
  if (pixels === null) return deltas
  for (const key of template.tiles) {
    const tile = parseTileKey(key)
    if (tile === null) continue
    const server = tilePixels(tile)
    const draft = draftPixels(tile)
    const mask = currentMask(template, tile)
    if (draft === null) continue
    const source = server ?? mask?.packed
    if (source === undefined) continue
    for (const offset of draftedPixelOffsets(tile)) {
      const tileX = offset % TILE_SIZE
      const tileY = (offset - tileX) / TILE_SIZE
      const localX = sourceXAt(template, tile.x * TILE_SIZE + tileX)
      const localY = tile.y * TILE_SIZE + tileY - template.originY
      if (localX === null || localY < 0 || localY >= template.height) continue
      const wanted = pixelAt(pixels, localX, localY)
      if (wanted >= PALETTE_SIZE || wanted === TRANSPARENT_INDEX) continue
      const serverClass =
        server !== null
          ? classifyPixel(wanted, server[offset] as number, UNPAINTED)
          : mask === null
            ? null
            : mismatchClassAt(mask, tileX, tileY)
      if (serverClass === null) continue
      const from = categoryOf(serverClass)
      const to = categoryOf(classifyPixel(wanted, draft[offset] as number, UNPAINTED))
      const delta: TemplateDraftPixelDelta = {
        key: `${tile.x}/${tile.y}/${offset}`,
        basis: draftSourceBasis(source, `${tile.x}/${tile.y}`),
        index: wanted,
        completed: 0,
        mismatched: 0,
        unpainted: 0,
      }
      deltas.push(from === to ? delta : { ...delta, [from]: -1, [to]: 1 })
    }
  }
  return deltas.sort((left, right) => left.key.localeCompare(right.key))
}

/**
 * The deep module seam for template accounting.
 *
 * Capture, worker scheduling, server-mask selection, draft precedence, cache invalidation and
 * per-pixel patching stay behind this interface. Callers receive only stable typed-array projections
 * and aggregates from the one managed record.
 */
export const pixelAccounting = Object.freeze({
  read: (template: PlacedTemplate): TemplatePixelAccounting => ({
    get progress() {
      return progressFrom(countsFor(template), template.opaque)
    },
    get colours() {
      return colourProgressFrom(template.artwork, countsFor(template))
    },
    get draftPixelDeltas() {
      return draftPixelDeltasFor(template)
    },
    tile: (tile) => tileAccountingFor(template, tile),
    unpainted: (tile, colour) => {
      if (mismatchAnswer(template, tile, 'unpainted') === null) return null
      const answer = entries.get(templateTileKey(template.id, tile))?.answer
      return answer == null ? null : colourAnswerFrom(answer, colour)
    },
    ensure: (tile) => progressIn(template, tile),
    nearest: (index, kind, reference, exclude) =>
      nearestColourTarget(index, kind, reference, template.id, exclude),
  }),
  frame: <Result>(read: () => Result): Result => {
    beginMismatchFrame()
    try {
      return read()
    } finally {
      endMismatchFrame()
    }
  },
  captureScopeTiles,
  onCaptureScopeChange,
  onChange: onMismatchesChanged,
  onDraftChange: onDraftsChanged,
  memoryBytes: mismatchMemoryBytes,
  revision: mismatchRevision,
})
registerProfileMemorySource('Mismatch cache', mismatchMemoryBytes)
