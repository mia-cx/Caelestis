import { type ArchiveProgressSample, DAY_SECONDS, type ProgressSample } from '@caelestis/shared'

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
): readonly ProgressSample[] => {
  const scopeCount = histories.length
  const changes = new Map<number, Map<number, ProgressSample>>()
  for (const [scope, samples] of histories.entries()) {
    for (const sample of samples) {
      const entries = changes.get(sample.at) ?? new Map<number, ProgressSample>()
      entries.set(scope, sample)
      changes.set(sample.at, entries)
    }
  }
  const latest = new Array<ProgressSample | undefined>(scopeCount)
  const revisions = new Array<string | null>(scopeCount).fill(null)
  let presentCount = 0
  let knownCount = 0
  let correctSum = 0
  let mismatchedSum = 0
  let totalSum = 0
  let revisionCount = 0
  let revisionKey: string | null = null
  return [...changes]
    .sort(([a], [b]) => a - b)
    .map(([at, entries]) => {
      let allBoundary = true
      for (const [scope, sample] of entries) {
        if (!sample.boundary) allBoundary = false
        const prev = latest[scope]
        if (prev === undefined) {
          presentCount += 1
        } else {
          totalSum -= prev.total
          if (prev.correct !== null && prev.mismatched !== null) {
            knownCount -= 1
            correctSum -= prev.correct
            mismatchedSum -= prev.mismatched
          }
          if (prev.revision !== undefined) revisionCount -= 1
        }
        latest[scope] = sample
        totalSum += sample.total
        if (sample.correct !== null && sample.mismatched !== null) {
          knownCount += 1
          correctSum += sample.correct
          mismatchedSum += sample.mismatched
        }
        if (sample.revision !== undefined) revisionCount += 1
        const nextRevision = sample.revision ?? null
        if (revisions[scope] !== nextRevision) {
          revisions[scope] = nextRevision
          revisionKey = null
        }
      }
      const complete = scopeCount > 0 && presentCount === scopeCount && knownCount === scopeCount
      if (revisionCount > 0 && revisionKey === null) revisionKey = JSON.stringify(revisions)
      return {
        at,
        correct: complete ? correctSum : null,
        mismatched: complete ? mismatchedSum : null,
        total: totalSum,
        ...(allBoundary ? { boundary: true as const } : {}),
        ...(revisionCount > 0 && revisionKey !== null ? { revision: revisionKey } : {}),
      }
    })
}

/** Native observations and known retained states supersede archives; empty boundaries do not. */
export const mergeObservedProgress = (
  archive: readonly ArchiveProgressSample[],
  observed: readonly ProgressSample[],
  current?: Omit<ProgressSample, 'total'>,
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
      total: observed.at(-1)?.total ?? archive.at(-1)?.total ?? 0,
      archive: false,
    })
  return [...byTime.values()].sort((a, b) => a.at - b.at)
}
