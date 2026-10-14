import { type ObservedProgressSample, observedProgressIntervals } from './progress-history'

/** Average signed progress within each artwork revision; null uses the full elapsed lifetime. */
export const completionPace = (
  samples: readonly ObservedProgressSample[],
  to: number,
  windowSeconds: number | null,
): { correct: number; hours: number } | null => {
  if (windowSeconds === null) {
    const known = samples.filter(
      (sample): sample is ObservedProgressSample & { correct: number } =>
        sample.correct !== null && sample.at <= to,
    )
    const first = known[0]
    if (first === undefined || first.at >= to) return null
    const pixels = known.reduce((total, sample, index) => {
      const before = known[index - 1]
      return before === undefined || before.revision !== sample.revision
        ? total
        : total + sample.correct - before.correct
    }, 0)
    const hours = (to - first.at) / 3_600
    return { correct: pixels / hours, hours }
  }
  const from = to - windowSeconds
  let hours = 0
  let correct = 0
  for (const interval of observedProgressIntervals(samples)) {
    const duration = interval.to - interval.from
    if (interval.to > to) continue
    if (duration > windowSeconds && !(interval.dailyObservation && windowSeconds >= 86_400))
      continue
    const covered = interval.to - Math.max(interval.from, from)
    if (covered <= 0) continue
    hours += covered / 3_600
    correct += (interval.pixels * covered) / duration
  }
  return hours > 0 ? { correct: correct / hours, hours } : null
}
