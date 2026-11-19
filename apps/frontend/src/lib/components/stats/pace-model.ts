import type {
  HistoryBucket,
  PainterHistoryResponse,
  PainterTotal,
  WplaceUserId,
} from '@caelestis/shared'
import {
  archiveCountsFor,
  type ObservedProgressSample,
  observedProgressIntervals,
} from './progress-history.js'
import {
  clipSeries,
  interpolateValue,
  lerpRate,
  PACE_WINDOWS,
  type PacePoint,
  type PaceRatePoint,
  type PainterHistorySource,
  rollingIntervalPace,
  rollingPaceSeries,
  type TimeWindow,
} from './progress-pace.js'

type PaceWindow = (typeof PACE_WINDOWS)[number]

/** The coarsest bucket a rolling window can draw from: it needs at least two buckets. */
export const maxPaceResolution = (windowSeconds: number): number => windowSeconds / 2
export const paceWindowUsable = (windowSeconds: number, bucketSeconds: number): boolean =>
  bucketSeconds <= maxPaceResolution(windowSeconds)

/** A window's place from shortest (0) to longest (1), which sets its line's colour and width. */
const paceRank = (window: PaceWindow): number =>
  PACE_WINDOWS.indexOf(window) / (PACE_WINDOWS.length - 1)

/**
 * Cumulative placements at the end of each bucket from `start`, zero-filled where a bucket is
 * missing. A bucket still open at `to` has no end count yet, so it is left out.
 */
export const cumulativePlacements = (
  buckets: readonly { readonly bucketStart: number; readonly placed: number }[],
  resolution: number,
  start: number,
  to: number,
): PacePoint[] => {
  const byStart = new Map<number, number>()
  for (const bucket of buckets) {
    byStart.set(bucket.bucketStart, (byStart.get(bucket.bucketStart) ?? 0) + bucket.placed)
  }
  const filled: PacePoint[] = []
  let cumPlaced = 0
  for (let t = Math.ceil(start / resolution) * resolution; t + resolution <= to; t += resolution) {
    cumPlaced += byStart.get(t) ?? 0
    filled.push({ t, cumPlaced })
  }
  return filled
}

/** Correct pixels as `v`, with the mismatched pixels stacked above them. */
export interface ProgressPoint extends PaceRatePoint {
  readonly mismatched: number
  readonly archive: boolean
}

export const lerpProgress = (
  a: ProgressPoint,
  b: ProgressPoint,
  fraction: number,
): ProgressPoint => ({
  ...lerpRate(a, b, fraction),
  mismatched: a.mismatched + (b.mismatched - a.mismatched) * fraction,
  archive: a.archive || b.archive,
})

/**
 * Observed progress as lines, broken at coverage gaps and where imported archive data hands over
 * to native observations. A revision changes the artwork at an instant, so the line holds the
 * preceding level until the revision's first sample and steps there.
 */
export const progressSegments = (samples: readonly ObservedProgressSample[]): ProgressPoint[][] => {
  const segments: ProgressPoint[][] = []
  let segment: ProgressPoint[] | null = null
  let revision: string | undefined
  for (const sample of samples) {
    if (sample.correct === null || sample.mismatched === null) {
      segment = null
      continue
    }
    if (segment === null) {
      segment = []
      segments.push(segment)
    }
    const previous = segment.at(-1)
    if (
      previous !== undefined &&
      segment.length > 1 &&
      segment.some((point) => point.archive) !== (previous.archive || sample.archive)
    ) {
      segment = [previous]
      segments.push(segment)
    }
    if (previous !== undefined && revision !== sample.revision)
      segment.push({ ...previous, t: sample.at })
    segment.push({
      t: sample.at,
      v: sample.correct,
      mismatched: sample.mismatched,
      archive: sample.archive,
    })
    revision = sample.revision
  }
  return segments
}

/** Everyone's rolling pace for one window, from observed net progress. */
export type PaceLine = PaceWindow & {
  readonly rank: number
  readonly segments: readonly PaceRatePoint[][]
  /** Where the imported archive intervals this window counts end, or -Infinity without any. */
  readonly importedUntil: number
}

/** One line per rolling window; daily archive intervals count only for windows of a day or more. */
export const paceLines = (samples: readonly ObservedProgressSample[], to: number): PaceLine[] => {
  const intervals = observedProgressIntervals(samples).filter((interval) => interval.to <= to)
  return PACE_WINDOWS.map((pace) => {
    const counted = intervals.filter(
      (interval) => !interval.archive || archiveCountsFor(pace.seconds),
    )
    return {
      ...pace,
      rank: paceRank(pace),
      segments: rollingIntervalPace(counted, pace.seconds),
      importedUntil: counted.findLast((interval) => interval.archive)?.to ?? -Infinity,
    }
  })
}

type UsableHistory = PainterHistoryResponse & {
  readonly resolution: number
  readonly coverageStart: number
}

/** The painter history a window draws from, when its tier is fine enough for that window. */
export const painterSource = (
  histories: readonly PainterHistorySource[],
  pace: PaceWindow,
): UsableHistory | undefined => {
  const history = histories.find((source) => source.window === pace.key)?.history
  if (history?.resolution === undefined || history.coverageStart === undefined) return undefined
  if (!paceWindowUsable(pace.seconds, history.resolution)) return undefined
  return { ...history, resolution: history.resolution, coverageStart: history.coverageStart }
}

export interface PainterLine {
  readonly painter: PainterTotal
  readonly window: PaceWindow['key']
  readonly rank: number
  readonly series: PaceRatePoint[]
}

/** One line per chosen painter per enabled window, from that window's own painter history. */
export const painterLines = (
  selection: {
    readonly windows: ReadonlySet<string>
    readonly painters: ReadonlySet<WplaceUserId>
  },
  painters: readonly PainterTotal[],
  histories: readonly PainterHistorySource[],
  to: number,
): PainterLine[] =>
  PACE_WINDOWS.flatMap((pace) => {
    const source = selection.windows.has(pace.key) ? painterSource(histories, pace) : undefined
    if (source === undefined) return []
    return painters.flatMap((painter) => {
      if (!selection.painters.has(painter.wplaceUserId)) return []
      const own = source.buckets.filter((bucket) => bucket.wplaceUserId === painter.wplaceUserId)
      const series = rollingPaceSeries(
        cumulativePlacements(own, source.resolution, source.coverageStart, to),
        source.resolution,
        pace.seconds,
      )
      return series.length === 0
        ? []
        : [{ painter, window: pace.key, rank: paceRank(pace), series }]
    })
  })

/** Anything observed before the right edge, as opposed to only the current counts there. */
const observedBefore = (samples: readonly ObservedProgressSample[], to: number): boolean =>
  samples.some((sample) => sample.at < to)

/**
 * Whether the plot has anything to show. Painter buckets are written per report while template
 * buckets wait for the counter flush, so the plot also opens when only painters have reported.
 */
export const hasActivity = (
  samples: readonly ObservedProgressSample[],
  buckets: readonly HistoryBucket[],
  histories: readonly PainterHistorySource[],
  to: number,
): boolean => {
  const anchor = samples.findLast((sample) => sample.at === to)
  return (
    observedBefore(samples, to) ||
    (anchor?.correct ?? 0) + (anchor?.mismatched ?? 0) > 0 ||
    buckets.some((bucket) => bucket.placed > 0) ||
    histories.some((source) => source.history.buckets.length > 0)
  )
}

/**
 * The brush's miniature of the whole range: observed progress, correct and mismatched stacked, or
 * cumulative placements when nothing was observed before `to`.
 */
export const brushSeries = (
  samples: readonly ObservedProgressSample[],
  segments: readonly ProgressPoint[][],
  buckets: readonly HistoryBucket[],
  range: { readonly from: number; readonly to: number; readonly resolution: number },
): PaceRatePoint[][] => {
  const { from, to, resolution } = range
  if (!observedBefore(samples, to)) {
    return [
      cumulativePlacements(buckets, resolution, from, to).map((point) => ({
        t: point.t,
        v: point.cumPlaced,
      })),
    ]
  }
  return segments.map((segment) =>
    clipSeries(segment, from, to, lerpProgress).map((point) => ({
      t: point.t,
      v: point.v + point.mismatched,
    })),
  )
}

/** Every time the crosshair can rest on: the observations in `window` and each line's vertices. */
export const snapTimes = (
  samples: readonly ObservedProgressSample[],
  lines: readonly (readonly { readonly t: number }[])[],
  window: TimeWindow,
): number[] => {
  const times = new Set<number>()
  for (const sample of samples) {
    if (sample.at >= window.from && sample.at <= window.to) times.add(sample.at)
  }
  for (const line of lines) {
    for (const point of line) times.add(point.t)
  }
  return [...times].sort((a, b) => a - b)
}

/** Progress at one time, rounded to whole pixels; null where nothing covers it. */
export interface Readout {
  readonly t: number
  readonly correct: number | null
  readonly mismatched: number | null
  /** The value is an imported archive snapshot. */
  readonly archive: boolean
}

/** The observation at `t`, or else the drawn segments interpolated there. */
export const readoutAt = (
  samples: readonly ObservedProgressSample[],
  segments: readonly ProgressPoint[][],
  t: number,
): Readout => {
  const sample = samples.find((candidate) => candidate.at === t)
  const along = (value: (point: ProgressPoint) => number): number | null =>
    segments.map((segment) => interpolateValue(segment, t, value)).find((v) => v !== null) ?? null
  const correct = sample === undefined ? along((point) => point.v) : sample.correct
  const mismatched = sample === undefined ? along((point) => point.mismatched) : sample.mismatched
  return {
    t,
    correct: correct === null ? null : Math.round(correct),
    mismatched: mismatched === null ? null : Math.round(mismatched),
    archive: sample?.archive === true,
  }
}
