import {
  type ArchiveProgressSample,
  DAY_SECONDS,
  type ProgressSample,
  type ProgressWindow,
} from '@caelestis/shared'
import { inProgressWindow } from '#lib/progress-window.js'

/** Consecutive UTC capture dates count as daily observations despite hour-level drift. */
const isDailyArchiveInterval = (interval: {
  readonly from: number
  readonly to: number
}): boolean => Math.floor(interval.to / DAY_SECONDS) - Math.floor(interval.from / DAY_SECONDS) <= 1

/** Archive captures are daily, so only pace windows of a day or more may count their intervals. */
export const archiveCountsFor = (windowSeconds: number): boolean => windowSeconds >= DAY_SECONDS

export interface ObservedProgressSample extends ProgressSample {
  readonly archive: boolean
}

/** Signed matching-pixel changes between known observations, never across explicit gaps. */
export const observedProgressIntervals = (samples: readonly ObservedProgressSample[]) =>
  samples.flatMap((sample, index) => {
    const before = samples[index - 1]
    if (
      before?.correct == null ||
      sample.correct === null ||
      sample.at <= before.at ||
      before.revision !== sample.revision
    )
      return []
    const interval = { from: before.at, to: sample.at }
    return [
      {
        ...interval,
        pixels: sample.correct - before.correct,
        archive: before.archive,
        dailyObservation: before.archive && isDailyArchiveInterval(interval),
      },
    ]
  })

/** Combine scopes at fixed observation times; a scope without coverage stays unknown. */
export const combineProgressSamples = (
  histories: readonly (readonly ProgressSample[])[],
  windows: readonly (ProgressWindow | undefined)[] = [],
): readonly ProgressSample[] => {
  const changes = new Map<number, Map<number, ProgressSample>>()
  for (const [scope, samples] of histories.entries()) {
    for (const sample of samples) {
      const entries = changes.get(sample.at) ?? new Map<number, ProgressSample>()
      entries.set(scope, sample)
      changes.set(sample.at, entries)
    }
  }
  const latest = new Map<number, ProgressSample>()
  return [...changes]
    .sort(([a], [b]) => a - b)
    .map(([at, entries]) => {
      for (const [scope, sample] of entries) latest.set(scope, sample)
      const active = histories.flatMap((_, scope) =>
        inProgressWindow(at, windows[scope]) ? [scope] : [],
      )
      const held = active.map((scope) => latest.get(scope))
      const complete =
        held.length > 0 &&
        held.every((sample) => sample?.correct != null && sample.mismatched !== null)
      return {
        at,
        correct: complete ? held.reduce((sum, sample) => sum + (sample?.correct ?? 0), 0) : null,
        mismatched: complete
          ? held.reduce((sum, sample) => sum + (sample?.mismatched ?? 0), 0)
          : null,
        total: held.reduce((sum, sample) => sum + (sample?.total ?? 0), 0),
        ...([...entries.values()].every((sample) => sample.boundary)
          ? { boundary: true as const }
          : {}),
        ...(held.some((sample) => sample?.revision !== undefined)
          ? {
              revision: JSON.stringify(
                histories.map((_, scope) =>
                  inProgressWindow(at, windows[scope])
                    ? (latest.get(scope)?.revision ?? null)
                    : null,
                ),
              ),
            }
          : {}),
      }
    })
}

/** Native observations and known retained states supersede archives; empty boundaries do not. */
export const mergeObservedProgress = (
  archive: readonly ArchiveProgressSample[],
  observed: readonly ProgressSample[],
  current?: Omit<ProgressSample, 'total'> & Partial<Pick<ProgressSample, 'total'>>,
): readonly ObservedProgressSample[] => {
  const firstLive = Math.min(
    current?.at ?? Infinity,
    ...observed
      .filter(
        (sample) => !sample.boundary || (sample.correct !== null && sample.mismatched !== null),
      )
      .map((sample) => sample.at),
  )
  const byTime = new Map<number, ObservedProgressSample>(
    archive
      .filter((sample) => sample.at < firstLive)
      .map((sample) => [sample.at, { ...sample, archive: true }]),
  )
  for (const sample of observed) {
    if (sample.boundary && sample.at < firstLive && archive.length > 0) continue
    byTime.set(sample.at, { ...sample, archive: false })
  }
  if (current !== undefined)
    byTime.set(current.at, {
      ...current,
      total: current.total ?? observed.at(-1)?.total ?? archive.at(-1)?.total ?? 0,
      archive: false,
    })
  return [...byTime.values()].sort((a, b) => a.at - b.at)
}
