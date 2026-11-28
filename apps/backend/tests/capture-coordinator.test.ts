import {
  CAPTURE_LEAD_MS,
  type CaptureClientEvent,
  type CaptureRun,
  type CaptureSettings,
  captureLines,
  isCaptureGuard,
  isCaptureReserve,
} from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { applyCaptureEvent, connectedCaptures, leaveCaptures } from '../src/presence/capture.js'

type Event = Exclude<CaptureClientEvent, { readonly type: 'clock' }>

const COORDINATOR = 1
const SETTINGS = { painters: 3, staggerMs: 500 }

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

/** One lobby the coordinator opened, joined by `joiners` in that order, then given its guards. */
const opened = (
  joiners: readonly number[],
  { guards = 0, ...settings }: Partial<CaptureSettings> = {},
): readonly CaptureRun[] => {
  let runs = apply([], { type: 'capture-new', ...SETTINGS, ...settings })
  const id = runs[0]?.id ?? ''
  for (const joiner of joiners) runs = apply(runs, { type: 'capture-join', run: id }, actor(joiner))
  return guards === 0 ? runs : apply(runs, { type: 'capture-settings', guards })
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
        {
          type: 'capture-drafted',
          run: run.id,
          drafted: (lines[index]?.length ?? 0) / 2,
          cut: run.cut,
        },
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
    const runs = opened(joiners, { painters: 1 })
    expect(only(runs).members).toHaveLength(41)
  })

  it('keeps its connected members, and closes once none is connected', () => {
    const runs = opened([2])
    expect(connectedCaptures(runs, new Set(['s1', 's2']))).toBe(runs)
    expect(order(connectedCaptures(runs, new Set(['s2'])))).toEqual([2])
    expect(connectedCaptures(runs, new Set(['s9']))).toEqual([])
  })
})

describe('settings', () => {
  it('stay editable until the countdown, and a planning change drops the locked wall', () => {
    let runs = apply(opened([2]), lock(40))
    runs = apply(runs, { type: 'capture-settings', staggerMs: 750 })
    expect(only(runs)).toMatchObject({ staggerMs: 750, wall: wall(40) })
    runs = apply(runs, { type: 'capture-settings', painters: 5 })
    expect(only(runs)).toMatchObject({ painters: 5, guards: 0, staggerMs: 750, wall: null })

    runs = apply(draftAll(apply(runs, lock(40))), { type: 'capture-go' })
    const started = apply(runs, {
      type: 'capture-settings',
      painters: 1,
      guards: 0,
      staggerMs: 100,
    })
    expect(started).toBe(runs)
  })

  it('change only the one a runner sent, so edits made before an update arrives both hold', () => {
    let runs = opened([2])
    runs = apply(runs, { type: 'capture-settings', painters: 6 })
    runs = apply(runs, { type: 'capture-settings', staggerMs: 300 })
    expect(only(runs)).toMatchObject({ painters: 6, guards: 0, staggerMs: 300 })
  })

  it('keep the coordinator on the closing leg when the guard count changes', () => {
    // Three members, no guards: the coordinator paints last, at index 2.
    let runs = opened([2, 3])
    expect(order(runs)).toEqual([2, 3, 1])
    runs = apply(runs, { type: 'capture-settings', guards: 1 })
    // Index 2 now guards, so the coordinator moves to the last painter's place.
    expect(order(runs)).toEqual([2, 1, 3])
  })

  it('let at most half the lobby guard, rounded down', () => {
    // A lobby of one has no guards, whatever its opener last chose.
    expect(only(opened([])).guards).toBe(0)
    // Five members: two may guard.
    const runs = apply(opened([2, 3, 4, 5]), { type: 'capture-settings', guards: 9 })
    expect(only(runs).guards).toBe(2)
    expect(order(runs)).toEqual([2, 3, 1, 4, 5])
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
    const runs = apply(opened([2, 3, 4], { guards: 1 }), lock(150, [[0, 1]]))
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
    const runs = opened([2], { guards: 1 })
    expect(apply(runs, lock(20))).toBe(runs)
  })

  it('goes back to choosing when a departure leaves fewer guards than the wall was planned for', () => {
    // Four members and two guards; one leaves, so half the lobby is one guard.
    let runs = apply(
      opened([2, 3, 4], { guards: 2 }),
      lock(40, [
        [0, 1],
        [1, 1],
      ]),
    )
    expect(only(runs).wall).not.toBeNull()
    runs = leaveCaptures(runs, 's4', 0) ?? []
    expect(only(runs)).toMatchObject({ wall: null, guardZones: [], guards: 2 })
    // A wall planned for the one guard the lobby has now locks in.
    expect(only(apply(runs, lock(40, [[0, 1]]))).wall).toEqual(wall(40))
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
    runs = apply(runs, { type: 'capture-move', member: 's2', by: 1 })
    expect(order(runs)).toEqual([3, 2, 4, 1])
    expect(drafted(runs)).toEqual([0, 0, 0, 0])

    // Painter 4 leaves: three painters share the wall again.
    runs = leaveCaptures(runs, 's4', 0) ?? []
    expect(legs(runs)).toEqual([40, 40, 40])
  })

  it('ignores a draft report measured before the last re-cut', () => {
    let runs = apply(opened([2, 3]), lock(120))
    const { id, cut: before } = only(runs)
    // Painters 2 and 3 swap equal legs; painter 2's report about their old leg arrives after.
    runs = apply(runs, { type: 'capture-move', member: 's2', by: 1 })
    const report = (cut: number) =>
      apply(runs, { type: 'capture-drafted', run: id, drafted: 40, cut }, actor(2))
    expect(report(before)).toBe(runs)
    expect(drafted(report(only(runs).cut))).toEqual([0, 40, 0])
  })

  it('ignores a draft report measured in another lobby with the same cut', () => {
    // Two locked lobbies at the same cut; painter 2 moves from the first to the second.
    let runs = apply(opened([2]), lock(40))
    runs = apply(runs, { type: 'capture-new', ...SETTINGS }, runner(3))
    runs = apply(runs, lock(40), runner(3))
    const [first, second] = runs
    if (first === undefined || second === undefined) throw new Error('Expected two lobbies')
    runs = apply(runs, { type: 'capture-join', run: second.id }, actor(2))
    const joined = runs[1]
    if (joined === undefined) throw new Error('Expected the second lobby')
    const late = { type: 'capture-drafted', run: first.id, drafted: 20, cut: joined.cut } as const
    expect(apply(runs, late, actor(2))).toBe(runs)
  })

  it('cancels back to choosing, with nothing drafted', () => {
    let runs = draftAll(apply(opened([2]), lock(40)))
    runs = apply(runs, { type: 'capture-unlock' })
    expect(only(runs)).toMatchObject({ wall: null, guardZones: [] })
    expect(drafted(runs)).toEqual([0, 0])
    expect(captureLines(only(runs))).toEqual([])
  })
})

describe('the closing leg', () => {
  const closer = (member: number): Event => ({ type: 'capture-closer', member: `s${member}` })
  const roles = (runs: readonly CaptureRun[]) =>
    only(runs).members.map((_, index) =>
      isCaptureGuard(only(runs), index)
        ? 'guard'
        : isCaptureReserve(only(runs), index)
          ? 'reserve'
          : 'leg',
    )

  it('goes to the member a runner gives it, re-cutting the same wall', () => {
    const before = draftAll(apply(opened([2, 3]), lock(120)))
    expect(order(before)).toEqual([2, 3, 1])
    const runs = apply(before, closer(2))
    expect(only(runs)).toMatchObject({ opener: 1, coordinator: 2, cut: only(before).cut + 1 })
    // The two swap places; nobody else moves.
    expect(order(runs)).toEqual([1, 3, 2])
    expect(drafted(runs)).toEqual([0, 0, 0])
    expect(captureLines(only(runs))[2]).toEqual(captureLines(only(before))[2])
  })

  it('stays with its new closer through reorders and joins', () => {
    let runs = apply(opened([2, 3]), closer(2))
    runs = apply(runs, { type: 'capture-move', member: 's3', by: 1 })
    expect(order(runs)).toEqual([1, 3, 2])
    runs = apply(runs, { type: 'capture-join', run: only(runs).id }, actor(4))
    expect(order(runs)).toEqual([1, 3, 4, 2])
  })

  it('swaps roles with the closer when given to a guard', () => {
    const runs = apply(opened([2, 3, 4], { guards: 1 }), closer(4))
    // The opener takes the guard's place, last.
    expect(order(runs)).toEqual([2, 3, 4, 1])
  })

  it('leaves reserves in reserve when a guard is given it', () => {
    // A 120-pixel wall in reserve: two legs, a reserve, and a guard.
    const before = apply(
      opened([2, 3, 4], { distribution: 'reserve', guards: 1 }),
      lock(120, [[0, 1]]),
    )
    expect(roles(before)).toEqual(['leg', 'leg', 'reserve', 'guard'])
    const [, closing, reserve, guard] = order(before)
    const runs = apply(before, closer(guard as number))
    // Only the closer and the guard trade places; the reserve stays in reserve.
    expect(order(runs)).toEqual([order(before)[0], guard, reserve, closing])
    expect(roles(runs)).toEqual(['leg', 'leg', 'reserve', 'guard'])
  })

  it('swaps with whoever holds the closing leg once the closer has left', () => {
    // Two legs, two reserves and a guard; the opener, closing, leaves.
    let runs = apply(
      opened([2, 3, 4, 5], { distribution: 'reserve', guards: 1 }),
      lock(120, [[0, 1]]),
    )
    runs = leaveCaptures(runs, 's1', 0) ?? []
    expect(order(runs)).toEqual([2, 3, 4, 5])
    expect(roles(runs)).toEqual(['leg', 'leg', 'reserve', 'guard'])
    // The guard takes the closing leg from painter 3, who guards; reserve 4 stays in reserve.
    // Painter 2, also a runner, hands it to the guard.
    runs = apply(runs, closer(5), runner(2))
    expect(order(runs)).toEqual([2, 5, 4, 3])
    expect(roles(runs)).toEqual(['leg', 'leg', 'reserve', 'guard'])
  })

  it('is a runner’s to give, to a member, before the countdown', () => {
    const runs = opened([2, 3])
    expect(apply(runs, closer(3), actor(2))).toBe(runs)
    expect(apply(runs, closer(9))).toBe(runs)
    const started = apply(draftAll(apply(runs, lock(40))), { type: 'capture-go' })
    expect(apply(started, closer(2))).toBe(started)
  })
})

describe('reserve', () => {
  it('cuts the fewest legs that fit for the first painters, the coordinator closing', () => {
    // Five members and a 120-pixel wall: two legs, and three reserves.
    let runs = apply(opened([2, 3, 4, 5], { distribution: 'reserve' }), lock(120))
    expect(order(runs)).toEqual([2, 1, 3, 4, 5])
    expect(legs(runs)).toEqual([60, 60, 0, 0, 0])
    // Only the two legs are drafted, and the countdown starts without the reserves.
    const { id: run, cut } = only(runs)
    for (const painter of [2, 1])
      runs = apply(runs, { type: 'capture-drafted', run, drafted: 60, cut }, actor(painter))
    expect(only(apply(runs, { type: 'capture-go' })).startsAt).not.toBeNull()
  })

  it('re-cuts the same wall when the runner switches to or from it', () => {
    let runs = draftAll(apply(opened([2, 3, 4]), lock(120)))
    expect(order(runs)).toEqual([2, 3, 4, 1])
    const { cut } = only(runs)
    runs = apply(runs, { type: 'capture-settings', distribution: 'reserve' })
    expect(only(runs)).toMatchObject({ distribution: 'reserve', wall: wall(120), cut: cut + 1 })
    expect(order(runs)).toEqual([2, 1, 3, 4])
    expect(drafted(runs)).toEqual([0, 0, 0, 0])
    runs = apply(runs, { type: 'capture-settings', distribution: 'even' })
    expect(order(runs)).toEqual([2, 3, 4, 1])
    expect(legs(runs)).toEqual([30, 30, 30, 30])
  })
})

describe('the countdown', () => {
  it('waits for a locked wall and every painter’s leg drafted, guards aside', () => {
    let runs = opened([2, 3], { guards: 1 })
    expect(apply(runs, { type: 'capture-go' })).toBe(runs)
    runs = apply(runs, lock(40, [[0, 1]]))
    // Painter 2 has drafted 19 of 20; the guard has drafted nothing.
    const { id: run, cut } = only(runs)
    runs = apply(runs, { type: 'capture-drafted', run, drafted: 19, cut }, actor(2))
    runs = apply(runs, { type: 'capture-drafted', run, drafted: 20, cut }, actor(1))
    expect(apply(runs, { type: 'capture-go' })).toBe(runs)
    runs = apply(runs, { type: 'capture-drafted', run, drafted: 20, cut }, actor(2))
    expect(only(apply(runs, { type: 'capture-go' }, runner(), 1_000)).startsAt).toBe(
      1_000 + CAPTURE_LEAD_MS,
    )
  })

  it('waits for enough painters when a member left after the lock', () => {
    let runs = draftAll(apply(opened([2]), lock(120)))
    runs = leaveCaptures(runs, 's2', 0) ?? []
    expect(apply(draftAll(runs), { type: 'capture-go' })).toEqual(draftAll(runs))
  })

  it('starts the same lobby over once the closing leg is painted, without those who left', () => {
    let runs = apply(draftAll(apply(opened([2, 3], { staggerMs: 300 }), lock(60))), {
      type: 'capture-go',
    })
    const started = only(runs)
    const during = started.startsAt ?? 0
    // Not while the wall is still being painted.
    expect(apply(runs, { type: 'capture-unlock' }, runner(), during)).toBe(runs)
    const after = during + 60_000
    runs = leaveCaptures(runs, 's2', after) ?? []
    runs = apply(runs, { type: 'capture-unlock' }, runner(), after)
    expect(only(runs)).toMatchObject({
      id: started.id,
      staggerMs: 300,
      startsAt: null,
      wall: null,
      guardZones: [],
    })
    expect(order(runs)).toEqual([3, 1])
    expect(drafted(runs)).toEqual([0, 0])
    // A painter whose tab closed during the countdown kept their place until it ended; the next
    // round drops them once the room sees they are gone.
    const ghost = apply(draftAll(apply(opened([2, 3]), lock(60))), { type: 'capture-go' })
    const end = (only(ghost).startsAt ?? 0) + 60_000
    expect(leaveCaptures(ghost, 's2', (only(ghost).startsAt ?? 0) + 1)).toBeNull()
    const next = connectedCaptures(
      apply(ghost, { type: 'capture-unlock' }, runner(), end),
      new Set(['s1', 's3']),
    )
    expect(order(next)).toEqual([3, 1])
    // Painters can't start the next round.
    const finished = apply(draftAll(apply(runs, lock(60))), { type: 'capture-go' })
    const later = (only(finished).startsAt ?? 0) + 60_000
    expect(apply(finished, { type: 'capture-unlock' }, actor(3), later)).toBe(finished)
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
    // Once the closing leg is painted, members may leave, and may join another lobby.
    const left = leaveCaptures(runs, 's2', during + 1) ?? []
    expect(left[0]?.members.map(({ left }) => left)).toEqual([true, undefined])
    expect(
      apply(runs, { type: 'capture-join', run: runs[1]?.id ?? '' }, actor(2), during + 1)[1]
        ?.members,
    ).toHaveLength(2)
  })

  it('keeps every remaining member’s leg and role when someone leaves a finished lobby', () => {
    // Two painters and a guard; the guard leaves once the wall is closed.
    let runs = apply(opened([2, 3], { guards: 1 }), lock(40, [[0, 1]]))
    runs = apply(draftAll(runs), { type: 'capture-go' })
    const before = captureLines(only(runs))
    const finished = (only(runs).startsAt ?? 0) + 60_000
    runs = leaveCaptures(runs, 's3', finished) ?? []
    expect(captureLines(only(runs))).toEqual(before)
    expect(order(runs)).toEqual([2, 1, 3])
    // A lobby whose remaining members all left closes.
    runs = leaveCaptures(runs, 's2', finished) ?? []
    runs = leaveCaptures(runs, 's1', finished) ?? []
    expect(connectedCaptures(runs, new Set(['s1', 's2', 's3']))).toEqual([])
  })
})
