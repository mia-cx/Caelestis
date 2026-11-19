import { afterEach, expect, it, vi } from 'vitest'
import { frameAt, speedToFit, TimelapseClock, transportScale } from './timelapse.js'

afterEach(() => vi.useRealTimers())

it('steps through every recorded second when the range is short', () => {
  const short = transportScale(100, 160)
  expect(short.steps).toBe(60)
  expect(short.toStep(130)).toBe(30)
  expect(short.toTime(30)).toBe(130)
  const empty = transportScale(100, 100)
  expect(empty.steps).toBe(1)
  expect(empty.toStep(100)).toBe(0)
  expect(empty.toTime(1)).toBe(100)
})

it('selects the latest snapshot without reading a future frame', () => {
  expect(frameAt([], 0)).toBe(-1)
  expect(frameAt([100, 160, 280], 99)).toBe(-1)
  expect(frameAt([100, 160, 280], 160)).toBe(1)
  expect(frameAt([100, 160, 280], 279)).toBe(1)
  expect(frameAt([100, 160, 280], 999)).toBe(2)
})

it('preserves partial frame time across pause and speed changes', () => {
  vi.useFakeTimers()
  const clock = new TimelapseClock([0, 3_600], 7_200)
  const shown = vi.fn()
  clock.play(1, shown)
  vi.advanceTimersByTime(175)
  clock.pause()
  vi.advanceTimersByTime(10_000)
  expect(shown).toHaveBeenLastCalledWith(0, expect.any(Number))
  clock.play(2, shown)
  vi.advanceTimersByTime(88)
  expect(shown).toHaveBeenLastCalledWith(1, expect.any(Number))
  clock.pause()
  expect(vi.getTimerCount()).toBe(0)
})

it('seeks, stops at live, and replays from the start', () => {
  vi.useFakeTimers()
  const clock = new TimelapseClock([0, 3_600, 7_200], 10_800)
  const shown = vi.fn()
  clock.play(1, shown)
  clock.seek(7_200)
  expect(vi.getTimerCount()).toBe(0)
  clock.play(1, shown)
  expect(shown).toHaveBeenLastCalledWith(2, 7_200)
  vi.advanceTimersByTime(350)
  expect(shown).toHaveBeenLastCalledWith(3, 10_800)
  clock.seek(0)
  clock.play(1, shown)
  expect(shown).toHaveBeenLastCalledWith(0, 0)
  clock.pause()
})

it('skips overdue dense frames without accumulating timer delay', () => {
  vi.useFakeTimers()
  const clock = new TimelapseClock([0, 60, 120, 180, 3_600], 7_200)
  const shown = vi.fn()
  const now = vi.spyOn(performance, 'now').mockReturnValue(0)
  clock.play(1, shown)
  now.mockReturnValue(350)
  vi.advanceTimersToNextTimer()
  expect(shown).toHaveBeenLastCalledWith(4, expect.closeTo(3_600))
  now.mockReturnValue(700)
  vi.advanceTimersToNextTimer()
  expect(shown).toHaveBeenLastCalledWith(5, 7_200)
  expect(vi.getTimerCount()).toBe(0)
  now.mockRestore()
})

it.each([{ timeline: [] }, { timeline: [100] }])(
  'finishes empty or zero-duration history without scheduling',
  ({ timeline }) => {
    vi.useFakeTimers()
    const shown = vi.fn()
    new TimelapseClock(timeline, 100).play(1, shown)
    expect(shown).toHaveBeenLastCalledWith(timeline.length, 100)
    expect(vi.getTimerCount()).toBe(0)
  },
)

it.each([
  { span: 604_800, ms: 10_000, speed: 5.9 },
  { span: 604_800, ms: 60_000, speed: 0.98 },
  { span: 86_400, ms: 60_000, speed: 0.14 },
  { span: 7_200, ms: 10_000, speed: 0.07 },
  // Slower than the minimum speed, or nothing to play.
  { span: 7_200, ms: 30_000, speed: null },
  { span: 0, ms: 10_000, speed: null },
])('fits $span recorded seconds into $ms ms at $speed×', ({ span, ms, speed }) => {
  expect(speedToFit(span, ms)).toBe(speed)
})

it('starts from the first frame and reaches live at a speed whose rate overflows', () => {
  vi.useFakeTimers()
  const clock = new TimelapseClock([0, 3_600], 7_200)
  const shown = vi.fn()
  // A browser clock can read the same instant twice, so playback starts with no elapsed time.
  const now = vi.spyOn(performance, 'now').mockReturnValue(0)
  clock.play(Number.MAX_VALUE, shown)
  expect(shown).toHaveBeenLastCalledWith(0, 0)
  now.mockReturnValue(1)
  vi.advanceTimersToNextTimer()
  expect(shown).toHaveBeenLastCalledWith(2, 7_200)
  expect(vi.getTimerCount()).toBe(0)
  now.mockRestore()
})
