import { afterEach, expect, it, vi } from 'vitest'
import { frameAt, TimelapseClock } from './timelapse.js'

afterEach(() => vi.useRealTimers())

it('selects the latest snapshot without reading a future frame', () => {
  expect(frameAt([], 0)).toBe(-1)
  expect(frameAt([100, 160, 280], 99)).toBe(-1)
  expect(frameAt([100, 160, 280], 160)).toBe(1)
  expect(frameAt([100, 160, 280], 279)).toBe(1)
  expect(frameAt([100, 160, 280], 999)).toBe(2)
})

it.each([0.05, 0.25, 1, 4])('keeps irregular gaps proportional at %s×', (speed) => {
  vi.useFakeTimers()
  const clock = new TimelapseClock([0, 60, 180, 3_600], 7_200)
  const shown: { index: number; at: number }[] = []
  clock.play(speed, (index) => shown.push({ index, at: performance.now() }))
  vi.advanceTimersByTime(700 / speed + 5)
  for (const [index, seconds] of [0, 60, 180, 3_600, 7_200].entries()) {
    const frame = shown.find((frame) => frame.index === index)
    expect(frame?.at).toBeCloseTo(((seconds / 3_600) * 350) / speed, -1)
  }
  expect(shown.at(-1)?.index).toBe(4)
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves partial frame time across pause and speed changes', () => {
  vi.useFakeTimers()
  const clock = new TimelapseClock([0, 3_600], 7_200)
  const shown = vi.fn()
  clock.play(1, shown)
  vi.advanceTimersByTime(175)
  clock.pause()
  vi.advanceTimersByTime(10_000)
  expect(shown).toHaveBeenLastCalledWith(0)
  clock.play(2, shown)
  vi.advanceTimersByTime(88)
  expect(shown).toHaveBeenLastCalledWith(1)
  clock.pause()
  expect(vi.getTimerCount()).toBe(0)
})

it('seeks, stops at live, and replays from the start', () => {
  vi.useFakeTimers()
  const clock = new TimelapseClock([0, 3_600, 7_200], 10_800)
  const shown = vi.fn()
  clock.play(1, shown)
  clock.seek(2)
  expect(vi.getTimerCount()).toBe(0)
  clock.play(1, shown)
  expect(shown).toHaveBeenLastCalledWith(2)
  vi.advanceTimersByTime(350)
  expect(shown).toHaveBeenLastCalledWith(3)
  clock.seek(0)
  clock.play(1, shown)
  expect(shown).toHaveBeenLastCalledWith(0)
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
  expect(shown).toHaveBeenLastCalledWith(4)
  now.mockReturnValue(700)
  vi.advanceTimersToNextTimer()
  expect(shown).toHaveBeenLastCalledWith(5)
  expect(vi.getTimerCount()).toBe(0)
  now.mockRestore()
})

it.each([{ timeline: [] }, { timeline: [100] }])(
  'finishes empty or zero-duration history without scheduling',
  ({ timeline }) => {
    vi.useFakeTimers()
    const shown = vi.fn()
    new TimelapseClock(timeline, 100).play(1, shown)
    expect(shown).toHaveBeenLastCalledWith(timeline.length)
    expect(vi.getTimerCount()).toBe(0)
  },
)
