import {
  CAPTURE_LEAD_MS,
  type CaptureClientEvent,
  type CaptureRun,
  captureLines,
  moveCaptureMember,
} from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { applyCaptureEvent, connectedCaptures, leaveCaptures } from '../src/presence/capture.js'

type Event = Exclude<CaptureClientEvent, { readonly type: 'clock' }>

const COORDINATOR = 1
const SETTINGS = { painters: 3, guards: 0, staggerMs: 500 }

const actor = (id: number, scope: 'report' | 'event_runner' = 'report') => ({
  sessionId: `s${id}`,
  painter: { wplaceUserId: id, displayName: `Painter ${id}` },
  scope,
  team: 2 as const,
})
const runner = (id = COORDINATOR) => actor(id, 'event_runner')

let ids = 0
const apply = (runs: readonly CaptureRun[], event: Event, by = runner(), now = 0) =>
  applyCaptureEvent(runs, event, by, now, () => `run${++ids}`)

/** One lobby the coordinator opened, joined by `joiners` in that order. */
const opened = (joiners: readonly number[], settings = SETTINGS): readonly CaptureRun[] => {
  let runs = apply([], { type: 'capture-new', ...settings })
  const id = runs[0]?.id ?? ''
  for (const joiner of joiners) runs = apply(runs, { type: 'capture-join', run: id }, actor(joiner))
  return runs
}

const only = (runs: readonly CaptureRun[]): CaptureRun => {
  const [run] = runs
  if (run === undefined || runs.length !== 1) throw new Error('Expected one lobby')
  return run
}
const order = (runs: readonly CaptureRun[]) =>
  only(runs).members.map(({ painter }) => painter.wplaceUserId)
const drafted = (runs: readonly CaptureRun[]) => only(runs).members.map((member) => member.drafted)
const legs = (runs: readonly CaptureRun[]) =>
  captureLines(only(runs)).map((line) => line.length / 2)

/** A straight wall of `pixels`, from anchor A to anchor B. */
const wall = (pixels: number) => Array.from({ length: pixels }, (_, x) => [x, 0]).flat()
const lock = (pixels: number, guardZones: number[][] = []): Event => ({
  type: 'capture-lock',
  wall: wall(pixels),
  guardZones,
})

/** Every member reports their whole leg drafted. */
const draftAll = (runs: readonly CaptureRun[]) => {
  const run = only(runs)
  const lines = captureLines(run)
  return run.members.reduce(
    (held, { painter }, index) =>
      apply(
        held,
        { type: 'capture-drafted', drafted: (lines[index]?.length ?? 0) / 2 },
        actor(painter.wplaceUserId),
      ),
    runs,
  )
}

describe('lobbies', () => {
  it('keeps several per team, opening one joins its opener, and a session sits in one', () => {
    let runs = opened([2])
    runs = apply(runs, { type: 'capture-new', ...SETTINGS }, runner(3))
    expect(runs.map((run) => run.members.map(({ sessionId }) => sessionId))).toEqual([
      ['s2', 's1'],
      ['s3'],
    ])
    // Joining the second lobby leaves the first.
    runs = apply(runs, { type: 'capture-join', run: runs[1]?.id ?? '' }, actor(2))
    expect(runs.map((run) => run.members.length)).toEqual([1, 2])
  })

  it('lets only runners open one', () => {
    expect(apply([], { type: 'capture-new', ...SETTINGS }, actor(2))).toEqual([])
  })

  it('takes any number of members, whatever the Painters setting', () => {
    const joiners = Array.from({ length: 40 }, (_, index) => index + 2)
    const runs = opened(joiners, { ...SETTINGS, painters: 1 })
    expect(only(runs).members).toHaveLength(41)
  })

  it('closes once no member is connected', () => {
    const runs = opened([2])
    expect(connectedCaptures(runs, new Set(['s2']))).toBe(runs)
    expect(connectedCaptures(runs, new Set(['s9']))).toEqual([])
  })
})

describe('settings', () => {
  it('stay editable until the countdown, and a planning change drops the locked wall', () => {
    let runs = apply(opened([2]), lock(40))
    runs = apply(runs, { type: 'capture-settings', painters: 3, guards: 0, staggerMs: 750 })
    expect(only(runs)).toMatchObject({ staggerMs: 750, wall: wall(40) })
    runs = apply(runs, { type: 'capture-settings', painters: 5, guards: 0, staggerMs: 750 })
    expect(only(runs)).toMatchObject({ painters: 5, wall: null })

    runs = apply(draftAll(apply(runs, lock(40))), { type: 'capture-go' })
    const started = apply(runs, {
      type: 'capture-settings',
      painters: 1,
      guards: 0,
      staggerMs: 100,
    })
    expect(started).toBe(runs)
  })

  it('are a runner’s to change', () => {
    const runs = opened([2])
    const changed = { type: 'capture-settings', painters: 1, guards: 0, staggerMs: 100 } as const
    expect(apply(runs, changed, actor(2))).toBe(runs)
  })
})

describe('locking in a wall', () => {
  it('cuts one leg per painting member, the coordinator on the closing leg', () => {
    // Four members, one of them a guard: three legs from a 150-pixel wall, and the guard's zone.
    const runs = apply(opened([2, 3, 4], { ...SETTINGS, guards: 1 }), lock(150, [[0, 1]]))
    expect(order(runs)).toEqual([2, 3, 1, 4])
    expect(legs(runs)).toEqual([50, 50, 50, 1])
    // The coordinator's leg is the middle of the wall, painted last.
    const closing = captureLines(only(runs))[2] ?? []
    expect(closing.slice(0, 2)).toEqual([50, 0])
  })

  it('refuses a wall with a leg past 60 pixels', () => {
    const runs = opened([2])
    expect(apply(runs, lock(121))).toBe(runs)
    expect(only(apply(runs, lock(120))).wall).toEqual(wall(120))
  })

  it('refuses a wall planned for a different number of guards', () => {
    const runs = opened([2], { ...SETTINGS, guards: 1 })
    expect(apply(runs, lock(20))).toBe(runs)
  })

  it('is a runner’s to do', () => {
    const runs = opened([2])
    expect(apply(runs, lock(20), actor(2))).toBe(runs)
  })

  it('re-cuts the same wall and resets drafted when the roster or order changes', () => {
    let runs = draftAll(apply(opened([2, 3]), lock(120)))
    expect(legs(runs)).toEqual([40, 40, 40])
    expect(drafted(runs)).toEqual([40, 40, 40])

    runs = apply(runs, { type: 'capture-join', run: only(runs).id }, actor(4))
    expect(legs(runs)).toEqual([30, 30, 30, 30])
    expect(drafted(runs)).toEqual([0, 0, 0, 0])

    runs = draftAll(runs)
    runs = apply(runs, {
      type: 'capture-order',
      order: moveCaptureMember(only(runs), 's2', 1) ?? [],
    })
    expect(order(runs)).toEqual([3, 2, 4, 1])
    expect(drafted(runs)).toEqual([0, 0, 0, 0])

    // Painter 4 leaves: three painters share the wall again.
    runs = leaveCaptures(runs, 's4', 0) ?? []
    expect(legs(runs)).toEqual([40, 40, 40])
  })

  it('cancels back to choosing, with nothing drafted', () => {
    let runs = draftAll(apply(opened([2]), lock(40)))
    runs = apply(runs, { type: 'capture-unlock' })
    expect(only(runs)).toMatchObject({ wall: null, guardZones: [] })
    expect(drafted(runs)).toEqual([0, 0])
    expect(captureLines(only(runs))).toEqual([])
  })
})

describe('the countdown', () => {
  it('waits for a locked wall and every painter’s leg drafted, guards aside', () => {
    let runs = opened([2, 3], { ...SETTINGS, guards: 1 })
    expect(apply(runs, { type: 'capture-go' })).toBe(runs)
    runs = apply(runs, lock(40, [[0, 1]]))
    // Painter 2 has drafted 19 of 20; the guard has drafted nothing.
    runs = apply(runs, { type: 'capture-drafted', drafted: 19 }, actor(2))
    runs = apply(runs, { type: 'capture-drafted', drafted: 20 }, actor(1))
    expect(apply(runs, { type: 'capture-go' })).toBe(runs)
    runs = apply(runs, { type: 'capture-drafted', drafted: 20 }, actor(2))
    expect(only(apply(runs, { type: 'capture-go' }, runner(), 1_000)).startsAt).toBe(
      1_000 + CAPTURE_LEAD_MS,
    )
  })

  it('waits for enough painters when a member left after the lock', () => {
    let runs = draftAll(apply(opened([2]), lock(120)))
    runs = leaveCaptures(runs, 's2', 0) ?? []
    expect(apply(draftAll(runs), { type: 'capture-go' })).toEqual(draftAll(runs))
  })

  it('refuses joins once started, and holds members in place until the closing leg', () => {
    let runs = apply(draftAll(apply(opened([2]), lock(40))), { type: 'capture-go' })
    const { id, startsAt } = only(runs)
    expect(apply(runs, { type: 'capture-join', run: id }, actor(5))).toBe(runs)
    const during = startsAt ?? 0
    expect(leaveCaptures(runs, 's2', during)).toBeNull()
    // A member of a running countdown can't hop to another lobby either.
    runs = apply(runs, { type: 'capture-new', ...SETTINGS }, runner(3))
    expect(apply(runs, { type: 'capture-join', run: runs[1]?.id ?? '' }, actor(2), during)).toBe(
      runs,
    )
    // Once the closing leg is painted, members may leave.
    expect(order([leaveCaptures(runs, 's2', during + 1)?.[0] as CaptureRun])).toEqual([1])
  })
})
