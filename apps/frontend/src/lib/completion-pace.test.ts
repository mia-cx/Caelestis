import { expect, it } from 'vitest'
import { completionPace } from './completion-pace'
import { mergeObservedProgress, type ObservedProgressSample } from './progress-history'

const DAY = 86_400
const sample = (day: number, correct: number | null, archive = false): ObservedProgressSample => ({
  at: day * DAY,
  correct,
  mismatched: correct === null ? null : 0,
  total: 1000,
  archive,
})

it('includes gains by painters without reports and averages inactive time', () => {
  expect(
    completionPace([sample(1, 100), sample(2, 148), sample(3, 148)], 3 * DAY, 7 * DAY),
  ).toEqual({ correct: 1, hours: 48 })
})

it.each([100, 52])(
  'uses signed net progress even when painters report more activity (%s)',
  (correct) => {
    expect(completionPace([sample(1, 100), sample(2, correct)], 2 * DAY, DAY)).toEqual({
      correct: (correct - 100) / 24,
      hours: 24,
    })
  },
)

it('keeps regressions signed and excludes explicit gaps from coverage', () => {
  expect(
    completionPace(
      [sample(0, 0), sample(1, 96), sample(2, null), sample(3, 100), sample(4, 52)],
      4 * DAY,
      7 * DAY,
    ),
  ).toEqual({ correct: 1, hours: 48 })
})

it('clips observations to the selected window without using future measurements', () => {
  const samples = [sample(0, 0), sample(1, 24), sample(2, 72), sample(3, 1000)]
  expect(completionPace(samples, 2.5 * DAY, DAY)).toEqual({ correct: 2, hours: 12 })
  expect(completionPace(samples, 5 * DAY, DAY)).toBeNull()
})

it('does not infer daily pace from measurements several days apart', () => {
  expect(completionPace([sample(0, 0), sample(3, 72)], 3 * DAY, DAY)).toBeNull()
})

it('preserves drifting daily archive intervals', () => {
  const pace = completionPace([sample(0, 0, true), sample(1.1, 26.4, true)], 1.1 * DAY, DAY)
  expect(pace?.correct).toBeCloseTo(1)
  expect(pace?.hours).toBe(24)
})

it('joins archive and native observations with native precedence and includes current progress', () => {
  const observations = mergeObservedProgress(
    [sample(1, 0), sample(2, 48), sample(3, 900)].map((s) => ({ ...s, snapshotId: s.at })),
    [sample(3, 72)],
    { at: 4 * DAY, correct: 144, mismatched: 0 },
  )
  expect(completionPace(observations, 4 * DAY, 7 * DAY)).toEqual({ correct: 2, hours: 72 })
})

it('cannot estimate a rate from a single observation', () => {
  expect(completionPace([sample(1, 100)], 2 * DAY, DAY)).toBeNull()
})
