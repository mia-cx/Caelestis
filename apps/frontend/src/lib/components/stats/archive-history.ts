import { type ArchiveHistory, type ArchiveProgressSample, DAY_SECONDS } from '@caelestis/shared'
import { observedProgressIntervals } from './progress-history.js'

/** Sum only complete observations for the entire selected scope, preserving explicit gaps. */
export const combineArchiveSamples = (
  histories: readonly ArchiveHistory[],
): readonly ArchiveProgressSample[] => {
  if (histories.length === 0 || histories.some((history) => history.basis === null)) return []
  const times = new Map<number, number>()
  const byHistory = histories.map(
    (history) =>
      new Map(
        history.samples.map((sample) => {
          times.set(sample.at, sample.snapshotId)
          return [sample.at, sample] as const
        }),
      ),
  )
  return [...times]
    .sort(([a], [b]) => a - b)
    .map(([at, snapshotId]) => {
      const samples = byHistory.map((history) => history.get(at))
      const complete = samples.every(
        (sample) => sample?.correct != null && sample.mismatched !== null,
      )
      return {
        at,
        snapshotId,
        total: histories.reduce((sum, history) => sum + (history.basis?.total ?? 0), 0),
        revision: JSON.stringify(histories.map((history) => history.basis?.versionId)),
        correct: complete ? samples.reduce((sum, sample) => sum + (sample?.correct ?? 0), 0) : null,
        mismatched: complete
          ? samples.reduce((sum, sample) => sum + (sample?.mismatched ?? 0), 0)
          : null,
      }
    })
}

/** Credit daily gains to the newer capture's UTC date; omit missed capture dates and live days. */
export const archiveContributionDays = (
  samples: readonly ArchiveProgressSample[],
  liveFrom: number,
): ReadonlyMap<number, number> => {
  const liveDay = Math.floor(liveFrom / DAY_SECONDS) * DAY_SECONDS
  const days = new Map<number, number>()
  const observed = samples.map((sample) => ({ ...sample, archive: true }))
  for (const interval of observedProgressIntervals(observed)) {
    const day = Math.floor(interval.to / DAY_SECONDS) * DAY_SECONDS
    if (!interval.dailyObservation || day >= liveDay) continue
    days.set(day, (days.get(day) ?? 0) + Math.max(0, interval.pixels))
  }
  return days
}
