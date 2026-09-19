import { type ObservedProgressSample, observedProgressIntervals } from './progress-history'

/** Average signed matching-pixel changes over observed time within the selected window. */
export const completionPace = (
  samples: readonly ObservedProgressSample[],
  to: number,
  windowSeconds: number,
): { correct: number; hours: number } | null => {
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
