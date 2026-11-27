import { expect, it } from 'vitest'
import { type CaptureRun, capturePaintersDrafted, decodeCaptureRun } from './capture-run.js'

const member = (id: number, drafted: number) => ({
  sessionId: `s${id}`,
  painter: { wplaceUserId: id, displayName: `Painter ${id}` },
  drafted,
})

/** Two painters and a guard, each with a two-pixel line. */
const run = (drafted: readonly number[]): CaptureRun => ({
  id: 'run',
  team: 2,
  coordinator: 1,
  painters: 2,
  guards: 1,
  members: drafted.map((count, index) => member(index + 1, count)),
  lines: [
    [0, 0, 1, 0],
    [0, 1, 1, 1],
    [0, 2, 1, 2],
  ],
  startsAt: null,
  staggerMs: 500,
})

it('holds Go until every painter has drafted their line, whatever the guards have', () => {
  expect(capturePaintersDrafted(run([2, 1, 2]))).toBe(false)
  expect(capturePaintersDrafted(run([2, 2, 0]))).toBe(true)
})

it('reads a run from a server that records no coordinator', () => {
  const { coordinator: _, ...older } = run([0, 0, 0])
  expect(decodeCaptureRun(older)).toEqual({ ...older, coordinator: null })
})
