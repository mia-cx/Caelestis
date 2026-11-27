import { type CaptureRun, moveCaptureMember } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { applyCaptureEvent, leaveCapture } from '../src/presence/capture.js'

const COORDINATOR = 1

const actor = (id: number, scope: 'report' | 'event_runner' = 'report') => ({
  sessionId: `s${id}`,
  painter: { wplaceUserId: id, displayName: `Painter ${id}` },
  scope,
  team: 2 as const,
})

/** A run the coordinator opened, joined by `ids` in that order. */
const joined = (painters: number, guards: number, ids: readonly number[]): CaptureRun => {
  let run = applyCaptureEvent(
    null,
    { type: 'capture-open', painters, guards },
    actor(COORDINATOR, 'event_runner'),
    0,
    () => 'run',
  )
  for (const id of ids)
    run = applyCaptureEvent(run, { type: 'capture-join', run: 'run' }, actor(id), 0, () => '')
  if (run === null) throw new Error('Expected a run')
  return run
}

const order = (run: CaptureRun | null) =>
  run?.members.map(({ painter }) => painter.wplaceUserId) ?? []

describe('the coordinator paints the closing line', () => {
  it.each([
    // An odd group ends on one painter: the coordinator.
    ['first of three painters', 3, 0, [1, 2, 3], [2, 3, 1]],
    // An even group ends on a pair; the coordinator is in it.
    ['first of four painters', 4, 0, [1, 2, 3, 4], [2, 3, 4, 1]],
    // While the run fills up, the last joined painter's place is the last one.
    ['in a group not yet full', 3, 0, [2, 1], [2, 1]],
    // The last painter's place, not the last member's: guards stay after.
    ['who would be a guard', 2, 2, [2, 3, 4, 1], [2, 1, 3, 4]],
  ])('keeps the last painter place for a coordinator %s', (_, painters, guards, ids, expected) => {
    expect(order(joined(painters, guards, ids))).toEqual(expected)
  })

  it('keeps the place through a reorder and a leave', () => {
    const run = joined(3, 1, [1, 2, 3, 4])
    expect(order(run)).toEqual([2, 3, 1, 4])
    // The administrator's order holds for everyone else.
    const reordered = applyCaptureEvent(
      run,
      { type: 'capture-order', order: ['s1', 's4', 's3', 's2'] },
      actor(COORDINATOR, 'event_runner'),
      0,
      () => '',
    )
    expect(order(reordered)).toEqual([4, 3, 1, 2])
    if (reordered === null) throw new Error('Expected a run')
    expect(order(leaveCapture(reordered, 's4'))).toEqual([3, 2, 1])
  })
})

it('swaps the members either side of the coordinator past them', () => {
  const run = joined(2, 1, [2, 1, 3])
  expect(order(run)).toEqual([2, 1, 3])
  const moved = moveCaptureMember(run, 's2', 1)
  expect(moved).not.toBeNull()
  const reordered = applyCaptureEvent(
    run,
    { type: 'capture-order', order: moved ?? [] },
    actor(COORDINATOR, 'event_runner'),
    0,
    () => '',
  )
  expect(order(reordered)).toEqual([3, 1, 2])
  // The coordinator's own place doesn't move.
  expect(moveCaptureMember(run, 's1', -1)).toBeNull()
})

it('holds Go after a leave until the members who moved draft their new lines', () => {
  const runner = actor(COORDINATOR, 'event_runner')
  const apply = (
    run: CaptureRun | null,
    event: Parameters<typeof applyCaptureEvent>[1],
    by = runner,
  ) => applyCaptureEvent(run, event, by, 0, () => '')
  // Three painters and a guard, every line two pixels, all drafted.
  let run = apply(joined(3, 1, [2, 3, 4, 5]), {
    type: 'capture-plan',
    lines: [0, 1, 2, 3].map((y) => [0, y, 1, y]),
  })
  for (const id of [2, 3, 4, 5])
    run = apply(run, { type: 'capture-drafted', drafted: 2 }, actor(id))
  // Painter 3 leaves: painter 4 takes their line and guard 5 is promoted to painter 4's.
  run = run && leaveCapture(run, 's3')
  run = apply(run, { type: 'capture-join', run: 'run' }, actor(6))
  expect(order(run)).toEqual([2, 4, 5, 6])
  expect(apply(run, { type: 'capture-go' })?.startsAt).toBeNull()

  for (const id of [4, 5]) run = apply(run, { type: 'capture-drafted', drafted: 2 }, actor(id))
  expect(apply(run, { type: 'capture-go' })?.startsAt).not.toBeNull()
})
