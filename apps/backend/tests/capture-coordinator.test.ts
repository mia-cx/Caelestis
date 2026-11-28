import {
  CAPTURE_LEAD_MS,
  type CaptureClientEvent,
  type CaptureRun,
  type CaptureSettings,
  captureEveryone,
  captureGuardCount,
  captureHostIndex,
  captureLines,
  captureSlot,
  captureVacant,
  isCaptureGuard,
  isCaptureReserve,
  MAX_CAPTURE_MEMBERS,
  packBits,
  type Scope,
} from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import {
  applyCaptureEvent,
  captureAssignments,
  connectedCaptures,
  handedPlaces,
  leaveCaptures,
  reseatCaptures,
  sentCaptures,
} from '../src/presence/capture.js'
import * as released from './support/released-capture-run.js'

type Event = Exclude<
  CaptureClientEvent,
  {
    readonly type: 'clock' | 'capture-timing' | 'latency-report'
  }
>

const COORDINATOR = 1
const SETTINGS = { painters: 3, staggerMs: 500 }

const actor = (id: number, scope: Scope = 'report') => ({
  sessionId: `s${id}`,
  painter: { wplaceUserId: id, displayName: `Painter ${id}` },
  scope,
  team: 2 as const,
  client: `browser${id}`,
})

/** The same painter as `actor(id)` on another socket of the same browser: a tab, or a reconnect. */
const again = (id: number) => ({ ...actor(id), sessionId: `s${id}b` })

/** Someone claiming `actor(id)`'s painter id from another browser. */
const impostor = (id: number) => ({ ...again(id), client: 'elsewhere' })

const owner = (id: number, client = `browser${id}`) => ({ painter: id, client })

/** The sessions the room has open, `actor(id)`'s for each id, and `extra` ones. */
const online = (
  ids: readonly number[],
  ...extra: (readonly [string, ReturnType<typeof owner>])[]
) => new Map([...ids.map((id) => [`s${id}`, owner(id)] as const), ...extra])

let ids = 0
const apply = (runs: readonly CaptureRun[], event: Event, by = actor(COORDINATOR), now = 0) =>
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
const waiting = (runs: readonly CaptureRun[]) =>
  (only(runs).waiting ?? []).map(({ painter }) => painter.wplaceUserId)
const host = (runs: readonly CaptureRun[]) =>
  captureEveryone(only(runs))[captureHostIndex(only(runs))]?.painter.wplaceUserId
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
    runs = apply(runs, { type: 'capture-new', ...SETTINGS }, actor(3))
    expect(runs.map((run) => run.members.map(({ sessionId }) => sessionId))).toEqual([
      ['s2', 's1'],
      ['s3'],
    ])
    // Joining the second lobby leaves the first.
    runs = apply(runs, { type: 'capture-join', run: runs[1]?.id ?? '' }, actor(2))
    expect(runs.map((run) => run.members.length)).toEqual([1, 2])
  })

  it('takes any number of members, whatever the Painters setting', () => {
    const joiners = Array.from({ length: 40 }, (_, index) => index + 2)
    const runs = opened(joiners, { painters: 1 })
    expect(only(runs).members).toHaveLength(41)
  })

  it('keeps its connected members, and closes once none is connected', () => {
    const runs = opened([2])
    expect(connectedCaptures(runs, online([1, 2]))).toBe(runs)
    expect(order(connectedCaptures(runs, online([2])))).toEqual([2])
    expect(connectedCaptures(runs, online([9]))).toEqual([])
  })
})

describe('a painter on a new socket', () => {
  const sessions = (runs: readonly CaptureRun[]) =>
    only(runs).members.map(({ sessionId }) => sessionId)

  it('takes back their place on joining again, so they are never in a lobby twice', () => {
    let runs = apply(opened([2, 3]), lock(60))
    runs = apply(runs, { type: 'capture-join', run: only(runs).id }, again(2))
    expect(order(runs)).toEqual([2, 3, 1])
    expect(sessions(runs)).toEqual(['s2b', 's3', 's1'])
    // The same leg: nothing re-cut.
    expect(only(runs).wall).not.toBeNull()
  })

  it('keeps their leg and slot through a reconnect during the countdown, into the next round', () => {
    const started = apply(draftAll(apply(opened([2, 3]), lock(60))), { type: 'capture-go' })
    // Painter 2's socket dropped and came back; the old one is gone.
    const room = online([1, 3], ['s2b', owner(2)])
    const back = connectedCaptures(started, room)
    expect(sessions(back)).toEqual(['s2b', 's3', 's1'])
    expect(captureLines(only(back))).toEqual(captureLines(only(started)))
    const end = (only(back).startsAt ?? 0) + 60_000
    const next = connectedCaptures(
      apply(back, { type: 'capture-unlock' }, actor(COORDINATOR), end),
      room,
    )
    expect(order(next)).toEqual([2, 3, 1])
  })

  it('keeps their place when the old socket only closes after the countdown, once back', () => {
    const started = apply(draftAll(apply(opened([2, 3]), lock(60))), { type: 'capture-go' })
    const end = (only(started).startsAt ?? 0) + 60_000
    // The new socket is up while the old one still counts as open, so nothing moves yet.
    expect(connectedCaptures(started, online([1, 2, 3], ['s2b', owner(2)]))).toBe(started)
    // Then the old one closes: the coordinator hands its place over before it leaves.
    const room = online([1, 3], ['s2b', owner(2)])
    const closed = leaveCaptures(reseatCaptures(started, room), 's2', end) ?? []
    const next = connectedCaptures(
      apply(closed, { type: 'capture-unlock' }, actor(COORDINATOR), end),
      room,
    )
    expect(order(next)).toEqual([2, 3, 1])
    expect(sessions(next)).toEqual(['s2b', 's3', 's1'])
  })

  it('takes over the host’s place along with hosting', () => {
    const runs = connectedCaptures(opened([2]), online([2], ['s1b', owner(1)]))
    expect(only(runs).host).toBe('s1b')
  })

  it('leaves a place alone while its own session is still connected, until they join', () => {
    const runs = opened([2])
    expect(connectedCaptures(runs, online([1, 2], ['s2b', owner(2)]))).toBe(runs)
  })

  it('never hands a place to another browser claiming the same painter', () => {
    const runs = apply(opened([2, 3]), lock(60))
    // Joining: neither the place nor a second one.
    expect(apply(runs, { type: 'capture-join', run: only(runs).id }, impostor(1))).toBe(runs)
    // Reconnecting: the host's place stays theirs, and passes on as usual once they are gone.
    const away = connectedCaptures(runs, online([2, 3], ['s1b', owner(1, 'elsewhere')]))
    expect(sessions(away)).not.toContain('s1b')
  })

  it('names each place handed over, so its slot follows it', () => {
    const started = apply(draftAll(apply(opened([2, 3]), lock(60))), { type: 'capture-go' })
    const back = connectedCaptures(started, online([1, 3], ['s2b', owner(2)]))
    expect(handedPlaces(started, back)).toEqual([[only(started).id, 's2', 's2b']])
    expect(handedPlaces(back, back)).toEqual([])
  })

  it('never sends the browser a place belongs to', () => {
    const runs = apply(opened([2]), lock(60))
    const waited = apply(runs, { type: 'capture-join', run: only(runs).id }, actor(3))
    expect(waiting(waited)).toEqual([3])
    expect(JSON.stringify(sentCaptures(waited))).not.toContain('browser')
  })
})

describe('the host', () => {
  const painters = (by: ReturnType<typeof actor>, runs: readonly CaptureRun[]) =>
    only(apply(runs, { type: 'capture-settings', painters: 7 }, by)).painters

  it('is the painter who opened the lobby, and only they run it', () => {
    // Painter 1 holds a report token, like everyone else.
    const runs = opened([2])
    expect(only(runs)).toMatchObject({ host: 's1', opener: 1, coordinator: 1 })
    expect(painters(actor(1), runs)).toBe(7)
    expect(painters(actor(2), runs)).toBe(3)
    expect(apply(runs, { type: 'capture-close' }, actor(2))).toBe(runs)
    expect(apply(runs, { type: 'capture-close' }, actor(1))).toEqual([])
  })

  it('passes to the longest-standing member when the host leaves', () => {
    // Painter 3 joins after 2, but is moved ahead of them in the paint order.
    let runs = apply(opened([2, 3]), { type: 'capture-move', member: 's3', by: -1 })
    expect(order(runs)).toEqual([3, 2, 1])
    runs = leaveCaptures(runs, 's1', 0) ?? []
    expect(only(runs).host).toBe('s2')
    expect(painters(actor(2), runs)).toBe(7)
    expect(painters(actor(3), runs)).toBe(3)
    // The closing leg stays a separate role: painter 1 had it, and nobody was given it.
    expect(only(runs).coordinator).toBe(1)
  })

  it('stays separate from the closing leg', () => {
    const runs = apply(opened([2]), { type: 'capture-closer', member: 's2' })
    expect(only(runs)).toMatchObject({ host: 's1', coordinator: 2 })
    expect(painters(actor(2), runs)).toBe(3)
  })

  it('passes on when the host disconnects, gathering or started', () => {
    const gathering = connectedCaptures(opened([2, 3]), online([2, 3]))
    expect(only(gathering).host).toBe('s2')
    // A started lobby keeps a disconnected member's place, but not as host.
    const started = apply(draftAll(apply(opened([2, 3]), lock(60))), { type: 'capture-go' })
    const kept = connectedCaptures(started, online([2, 3]))
    expect(order(kept)).toEqual(order(started))
    expect(only(kept).host).toBe('s2')
    const after = (only(kept).startsAt ?? 0) + 60_000
    expect(only(apply(kept, { type: 'capture-unlock' }, actor(2), after)).startsAt).toBeNull()
  })

  it('passes on when the host leaves a finished lobby', () => {
    const started = apply(draftAll(apply(opened([2, 3]), lock(60))), { type: 'capture-go' })
    const after = (only(started).startsAt ?? 0) + 60_000
    const runs = leaveCaptures(started, 's1', after) ?? []
    expect(only(runs).members.find(({ sessionId }) => sessionId === 's1')?.left).toBe(true)
    expect(only(runs).host).toBe('s2')
    expect(only(apply(runs, { type: 'capture-unlock' }, actor(2), after)).startsAt).toBeNull()
  })

  it('shares the running with an administrator in the lobby', () => {
    let runs = opened([2])
    runs = apply(runs, { type: 'capture-join', run: only(runs).id }, actor(9, 'admin'))
    expect(painters(actor(9, 'admin'), runs)).toBe(7)
    expect(only(runs).host).toBe('s1')
  })

  it('treats an event-runner token like any other painter', () => {
    const runner = actor(5, 'event_runner')
    let runs = opened([2])
    runs = apply(runs, { type: 'capture-join', run: only(runs).id }, runner)
    expect(painters(runner, runs)).toBe(3)
    runs = apply(runs, { type: 'capture-new', ...SETTINGS }, runner)
    expect(runs.map((run) => run.host)).toEqual(['s1', 's5'])
  })

  it('falls back to the opener, then the first member, on a lobby stored by backend 1.6.0', () => {
    const strip = ({ host: _, ...run }: CaptureRun): CaptureRun => ({
      ...run,
      members: run.members.map(({ joined: _, ...member }) => member),
    })
    // Painter 1 opened it and sits last, on the closing leg.
    const stored = [strip(only(opened([2, 3])))]
    expect(order(stored)).toEqual([2, 3, 1])
    expect(host(stored)).toBe(1)
    expect(painters(actor(1), stored)).toBe(7)
    expect(painters(actor(2), stored)).toBe(3)
    // Once the opener leaves, the first member hosts; the room records it.
    const left = leaveCaptures(stored, 's1', 0) ?? []
    expect(host(left)).toBe(2)
    expect(only(connectedCaptures(left, online([2, 3]))).host).toBe('s2')
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

  it('change only the one the host sent, so edits made before an update arrives both hold', () => {
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
    // A lobby opens with the guards its opener last chose, and guards once enough painters join.
    let chosen = apply([], { type: 'capture-new', ...SETTINGS, guards: 2 })
    expect(captureGuardCount(only(chosen))).toBe(0)
    const id = only(chosen).id
    for (const joiner of [2, 3, 4, 5])
      chosen = apply(chosen, { type: 'capture-join', run: id }, actor(joiner))
    expect(captureGuardCount(only(chosen))).toBe(2)
    // Five members: two may guard.
    const runs = apply(opened([2, 3, 4, 5]), { type: 'capture-settings', guards: 9 })
    expect(only(runs).guards).toBe(2)
    expect(order(runs)).toEqual([2, 3, 1, 4, 5])
  })

  it('are the host’s to change', () => {
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

  it('keeps every leg, role and draft when a painter joins after the lock-in', () => {
    // Two painters and the coordinator share 120 pixels; painter 4 guards.
    let runs = draftAll(apply(opened([2, 3, 4], { guards: 1 }), lock(120, [[0, 1]])))
    const before = only(runs)
    runs = apply(runs, { type: 'capture-join', run: before.id }, actor(5))
    // Painter 5 waits, with no place, leg or slot, until the next lock-in.
    expect(order(runs)).toEqual([2, 3, 1, 4])
    expect(waiting(runs)).toEqual([5])
    expect(legs(runs)).toEqual([40, 40, 40, 1])
    expect(drafted(runs)).toEqual([40, 40, 40, 1])
    expect(only(runs).cut).toBe(before.cut)
    expect(isCaptureGuard(only(runs), 3)).toBe(true)
    const started = only(apply(runs, { type: 'capture-go' }))
    expect([...captureAssignments(started).keys()]).toEqual(['s2', 's3', 's1', 's4'])
    // Locking in again cuts the wall for all five.
    runs = apply(apply(runs, { type: 'capture-unlock' }), lock(120, [[0, 1]]))
    expect(waiting(runs)).toEqual([])
    expect(legs(runs)).toEqual([30, 30, 30, 30, 1])
  })

  it('lets a waiting painter leave at any time, and host once nobody placed is left', () => {
    let runs = apply(opened([2]), lock(120))
    runs = apply(runs, { type: 'capture-join', run: only(runs).id }, actor(3))
    runs = apply(runs, { type: 'capture-join', run: only(runs).id }, actor(4))
    runs = leaveCaptures(runs, 's1', 0) ?? []
    runs = leaveCaptures(runs, 's2', 0) ?? []
    // Both places are empty: the longest-waiting painter hosts, so someone can lock in again.
    expect(host(runs)).toBe(3)
    runs = apply(runs, { type: 'capture-unlock' }, actor(3))
    expect(order(runs)).toEqual([3, 4])
    // Waiting has no slot to keep, so they leave a lobby mid-countdown.
    runs = draftAll(apply(runs, lock(60), actor(3)))
    runs = apply(runs, { type: 'capture-join', run: only(runs).id }, actor(5))
    runs = apply(runs, { type: 'capture-go' }, actor(3))
    expect(leaveCaptures(runs, 's3', 0)).toBeNull()
    expect(waiting(leaveCaptures(runs, 's5', 0) ?? [])).toEqual([])
  })

  it('refuses a join past the most members a lobby sends, but not a painter taking their place back', () => {
    // Locked for painters 1 and 2, and joined since by everyone else up to the most members.
    const locked = only(apply(opened([2]), lock(60)))
    const rest = Array.from({ length: MAX_CAPTURE_MEMBERS - 2 }, (_, index) => {
      const { sessionId, painter, client } = actor(index + 3)
      return { sessionId, painter, client, drafted: 0, joined: index + 2 }
    })
    let runs: readonly CaptureRun[] = [{ ...locked, waiting: rest }]
    expect(only(runs).members.length + waiting(runs).length).toBe(MAX_CAPTURE_MEMBERS)
    const past = actor(MAX_CAPTURE_MEMBERS + 1)
    expect(apply(runs, { type: 'capture-join', run: only(runs).id }, past)).toBe(runs)
    // An empty place still counts, and its painter takes it back from the same browser.
    runs = leaveCaptures(runs, 's2', 0) ?? []
    expect(apply(runs, { type: 'capture-join', run: only(runs).id }, past)).toBe(runs)
    runs = apply(runs, { type: 'capture-join', run: only(runs).id }, again(2))
    expect(captureVacant(only(runs))).toBe(false)
  })

  it('leaves a departed painter’s leg empty until the host locks in again', () => {
    let runs = draftAll(apply(opened([2, 3]), lock(120)))
    const before = only(runs)
    runs = leaveCaptures(runs, 's2', 0) ?? []
    // Nobody else's leg or draft changes, and the countdown waits.
    expect(order(runs)).toEqual([2, 3, 1])
    expect(legs(runs)).toEqual([40, 40, 40])
    expect(drafted(runs)).toEqual([0, 40, 40])
    expect(only(runs).cut).toBe(before.cut)
    expect(captureVacant(only(runs))).toBe(true)
    expect(apply(runs, { type: 'capture-go' })).toBe(runs)
    // Cancel proposed shape, then Lock in: the two left share the wall.
    runs = apply(apply(runs, { type: 'capture-unlock' }), lock(120))
    expect(order(runs)).toEqual([3, 1])
    expect(legs(runs)).toEqual([60, 60])
  })

  it('gives a disconnected painter their empty place back when they join again', () => {
    let runs = draftAll(apply(opened([2, 3]), lock(120)))
    runs = connectedCaptures(runs, online([1, 3]))
    expect(captureVacant(only(runs))).toBe(true)
    // From another browser, the place is not theirs.
    expect(apply(runs, { type: 'capture-join', run: only(runs).id }, impostor(2))).toBe(runs)
    runs = apply(runs, { type: 'capture-join', run: only(runs).id }, again(2))
    expect(only(runs).members.map(({ sessionId }) => sessionId)).toEqual(['s2b', 's3', 's1'])
    expect(captureVacant(only(runs))).toBe(false)
    expect(legs(runs)).toEqual([40, 40, 40])
  })

  it('holds a departed guard’s zone empty, and plans for the guards left after', () => {
    // Four members and two guards; one leaves, so half the lobby is one guard.
    let runs = apply(
      opened([2, 3, 4], { guards: 2 }),
      lock(40, [
        [0, 1],
        [1, 1],
      ]),
    )
    runs = leaveCaptures(runs, 's4', 0) ?? []
    expect(captureVacant(only(runs))).toBe(true)
    runs = apply(runs, { type: 'capture-unlock' })
    expect(only(runs)).toMatchObject({ wall: null, guardZones: [], guards: 2 })
    // A wall planned for the one guard the lobby has now locks in.
    expect(only(apply(runs, lock(40, [[0, 1]]))).wall).toEqual(wall(40))
  })

  it('is the host’s to do', () => {
    const runs = opened([2])
    expect(apply(runs, lock(20), actor(2))).toBe(runs)
  })

  it('re-cuts the same wall for everyone in the lobby when the host reorders it', () => {
    // Painter 4 joins after the lock-in and waits; painter 3 leaves their leg empty.
    let runs = draftAll(apply(opened([2, 3, 5]), lock(120)))
    runs = apply(runs, { type: 'capture-join', run: only(runs).id }, actor(4))
    runs = leaveCaptures(runs, 's3', 0) ?? []
    // Painter 2 trades places with painter 5, past the empty place, and the wall is cut again.
    runs = apply(runs, { type: 'capture-move', member: 's2', by: 1 })
    expect(order(runs)).toEqual([5, 2, 4, 1])
    expect(waiting(runs)).toEqual([])
    expect(legs(runs)).toEqual([30, 30, 30, 30])
    expect(drafted(runs)).toEqual([0, 0, 0, 0])
    expect(captureVacant(only(runs))).toBe(false)
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
    runs = apply(runs, { type: 'capture-new', ...SETTINGS }, actor(3))
    runs = apply(runs, lock(40), actor(3))
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

  it('goes to the member the host gives it, re-cutting the same wall', () => {
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
    // The opener, closing, leaves; then two legs, a reserve and a guard lock in.
    let runs = leaveCaptures(opened([2, 3, 4, 5], { distribution: 'reserve', guards: 1 }), 's1', 0)
    runs = apply(runs ?? [], lock(120, [[0, 1]]), actor(2))
    expect(order(runs)).toEqual([2, 3, 4, 5])
    expect(roles(runs)).toEqual(['leg', 'leg', 'reserve', 'guard'])
    // The guard takes the closing leg from painter 3, who guards; reserve 4 stays in reserve.
    // Painter 2, the host since painter 1 left, hands it to the guard.
    runs = apply(runs, closer(5), actor(2))
    expect(order(runs)).toEqual([2, 5, 4, 3])
    expect(roles(runs)).toEqual(['leg', 'leg', 'reserve', 'guard'])
  })

  it('is the host’s to give, to a member, before the countdown', () => {
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

  it('re-cuts the same wall when the host switches to or from it', () => {
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
    expect(only(apply(runs, { type: 'capture-go' }, actor(COORDINATOR), 1_000)).startsAt).toBe(
      1_000 + CAPTURE_LEAD_MS,
    )
  })

  it('starts the lobby’s own lead before the first slot', () => {
    const ready = draftAll(apply(opened([2], { leadMs: 3_000 }), lock(40)))
    expect(only(apply(ready, { type: 'capture-go' }, actor(COORDINATOR), 1_000)).startsAt).toBe(
      4_000,
    )
    // The host can change it until the countdown; it keeps the locked wall.
    const longer = apply(ready, { type: 'capture-settings', leadMs: 20_000 })
    expect(only(longer)).toMatchObject({ leadMs: 20_000, wall: wall(40), cut: only(ready).cut })
    expect(only(apply(longer, { type: 'capture-go' }, actor(COORDINATOR), 1_000)).startsAt).toBe(
      21_000,
    )
    // Backend 1.5.0 stored lobbies without a lead; one still open after an upgrade starts with the
    // default.
    const { leadMs: _, ...stored } = only(ready)
    expect(only(apply([stored], { type: 'capture-go' }, actor(COORDINATOR), 1_000)).startsAt).toBe(
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
    expect(apply(runs, { type: 'capture-unlock' }, actor(COORDINATOR), during)).toBe(runs)
    const after = during + 60_000
    runs = leaveCaptures(runs, 's2', after) ?? []
    runs = apply(runs, { type: 'capture-unlock' }, actor(COORDINATOR), after)
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
      apply(ghost, { type: 'capture-unlock' }, actor(COORDINATOR), end),
      online([1, 3]),
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
    runs = apply(runs, { type: 'capture-new', ...SETTINGS }, actor(3))
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
    expect(connectedCaptures(runs, online([1, 2, 3]))).toEqual([])
  })
})

/** `covered` for a wall of `pixels`, with the wall pixels from `from` up to `to` drafted. */
const covering = (pixels: number, from: number, to: number) =>
  packBits(Uint8Array.from({ length: pixels }, (_, at) => (at >= from && at < to ? 1 : 0)))

/** Painter `id` reports `drafted` of their own leg and, from a tab that has it, `covered`. */
const report = (runs: readonly CaptureRun[], id: number, drafted: number, covered?: string) => {
  const { id: run, cut } = only(runs)
  const event: Event = {
    type: 'capture-drafted',
    run,
    drafted,
    cut,
    ...(covered ? { covered } : {}),
  }
  return apply(runs, event, actor(id))
}

/** Painter `id` presses Ready, or releases it, on the lobby's current cut. */
const press = (runs: readonly CaptureRun[], id: number, ready = true) =>
  apply(runs, { type: 'capture-ready', run: only(runs).id, cut: only(runs).cut, ready }, actor(id))

const go = (runs: readonly CaptureRun[]) => only(apply(runs, { type: 'capture-go' })).startsAt

describe('the wall drafted by anyone', () => {
  // Opened by 1 and joined by 2, a 40-pixel wall: painter 2 has pixels 0..19, the closer 20..39.

  it('starts the countdown once someone has drafted every leg, whoever it belongs to', () => {
    let runs = apply(opened([2]), lock(40))
    runs = report(runs, 1, 20, covering(40, 0, 40))
    expect(only(runs).members.map(({ drafted }) => drafted)).toEqual([0, 20])
    expect(go(runs)).not.toBeNull()
  })

  it('counts an overlap once, and none of an old tab’s leg it hasn’t finished', () => {
    // The closer drafts their leg and 10 pixels of painter 2's; painter 2's old tab has 19 of 20.
    let runs = report(apply(opened([2]), lock(40)), 1, 20, covering(40, 10, 40))
    runs = report(runs, 2, 19)
    expect(go(runs)).toBeNull()
    // Painter 2 updates and drafts 0..15, over the closer's 10..15: the wall is whole.
    runs = report(runs, 2, 15, covering(40, 0, 15))
    expect(go(runs)).not.toBeNull()
  })

  it('keeps no coverage that doesn’t fit the wall, nor any past a re-cut', () => {
    let runs = apply(opened([2]), lock(40))
    runs = report(runs, 1, 20, covering(48, 0, 48))
    expect(only(runs).members.map(({ covered }) => covered)).toEqual([undefined, undefined])
    runs = report(runs, 1, 20, covering(40, 0, 40))
    expect(only(apply(runs, lock(40))).members.map(({ covered }) => covered)).toEqual([
      undefined,
      undefined,
    ])
  })
})

describe('Ready', () => {
  /** Painters 1 to 3, the last a guard, Wait for Ready on, every tab with Ready, all drafted. */
  const waiting = () => {
    let runs = opened([2, 3], { guards: 1 })
    runs = apply(runs, { type: 'capture-settings', waitForReady: true })
    runs = draftAll(apply(runs, lock(40, [[0, 1]])))
    return [1, 2, 3].reduce((held, id) => press(held, id, false), runs)
  }

  it('is saved with the lobby, and off unless the host turns it on', () => {
    expect(only(opened([])).waitForReady).toBeUndefined()
    const runs = apply([], { type: 'capture-new', ...SETTINGS, waitForReady: true })
    expect(only(runs).waitForReady).toBe(true)
    expect(only(apply(runs, { type: 'capture-settings', waitForReady: false })).waitForReady).toBe(
      undefined,
    )
  })

  it('holds the start until everyone who paints at a slot is Ready, the guard too', () => {
    let runs = press(press(waiting(), 1), 2)
    expect(go(runs)).toBeNull()
    runs = press(runs, 3)
    expect(go(runs)).not.toBeNull()
    // With Wait for Ready off, nobody's Ready holds it.
    expect(go(apply(waiting(), { type: 'capture-settings', waitForReady: false }))).not.toBeNull()
  })

  it('never waits for a tab with no Ready button', () => {
    let runs = opened([2])
    runs = apply(runs, { type: 'capture-settings', waitForReady: true })
    // Painter 2's tab predates Ready and never says it has one.
    runs = press(draftAll(apply(runs, lock(40))), 1)
    expect(go(runs)).not.toBeNull()
  })

  it('resets when the legs are re-cut, and ignores a press from before', () => {
    const ready = [1, 2, 3].reduce((held, id) => press(held, id), waiting())
    const readiness = (runs: readonly CaptureRun[]) => only(runs).members.map((m) => m.ready)
    expect(readiness(ready)).toEqual([true, true, true])
    const moved = apply(ready, { type: 'capture-move', member: 's2', by: 1 })
    expect(readiness(moved)).toEqual([false, false, false])
    const relocked = apply(apply(ready, { type: 'capture-unlock' }), lock(40, [[0, 1]]))
    expect(readiness(relocked)).toEqual([false, false, false])
    // A press sent on the cut before the re-cut is about a leg nobody has any more.
    const { id: run, cut } = only(ready)
    const stale = { type: 'capture-ready', run, cut, ready: true } as const
    expect(apply(relocked, stale, actor(2))).toBe(relocked)
  })
})

describe('a tab on userscript 1.8.2', () => {
  /** A start time, so slots can be compared before the countdown would start. */
  const STARTS_AT = 1_000_000

  /**
   * The places an old tab sees in what the server sends, each with the line and slot its code
   * derives, after checking they are the server's own: both lobbies started at `STARTS_AT`.
   */
  const agreed = (runs: readonly CaptureRun[]) => {
    const server = { ...only(runs), startsAt: STARTS_AT }
    const [sent] = JSON.parse(JSON.stringify(sentCaptures([server])))
    const old = released.decodeCaptureRun(sent)
    if (old === null) throw new Error('The old tab refused the lobby')
    const places = old.members.map(({ sessionId }, index) => ({
      sessionId,
      line: released.captureLines(old)[index],
      slot: released.captureSlot(old, index),
    }))
    expect(places).toEqual(
      server.members.map(({ sessionId }, index) => ({
        sessionId,
        line: captureLines(server)[index],
        slot: captureSlot(server, index),
      })),
    )
    return places.map(({ sessionId }) => sessionId)
  }

  it.each([
    ['a leg each', {}],
    ['legs and reserves', { distribution: 'reserve' as const }],
  ])('derives the server’s legs and slots after a late join and a departure: %s', (_, settings) => {
    let runs = draftAll(apply(opened([2, 3, 4], { guards: 1, ...settings }), lock(90, [[0, 1]])))
    runs = apply(runs, { type: 'capture-join', run: only(runs).id }, actor(5))
    // The old tab doesn't see painter 5, who has no place to paint from yet.
    expect(waiting(runs)).toEqual([5])
    expect(agreed(runs)).not.toContain('s5')
    runs = leaveCaptures(runs, 's2', 0) ?? []
    agreed(runs)
    // The next lock-in gives painter 5 a place, which the old tab then sees too.
    runs = apply(apply(runs, { type: 'capture-unlock' }), lock(90, [[0, 1]]))
    expect(agreed(runs)).toContain('s5')
  })

  it('derives the server’s legs and slots from a lobby with coverage and Ready', () => {
    let runs = opened([2, 3], { guards: 1 })
    runs = apply(runs, { type: 'capture-settings', waitForReady: true })
    runs = report(apply(runs, lock(40, [[0, 1]])), 1, 20, covering(40, 0, 40))
    runs = press(press(runs, 1), 2, false)
    expect(only(runs).members.some(({ covered }) => covered !== undefined)).toBe(true)
    expect(agreed(runs)).toHaveLength(3)
  })
})

describe('after a lock-in, with places left empty', () => {
  it('goes back to choosing when every place empties before the countdown, seating those waiting', () => {
    let runs = apply(opened([2]), lock(60))
    runs = apply(runs, { type: 'capture-join', run: only(runs).id }, actor(3))
    expect(waiting(runs)).toEqual([3])
    runs = leaveCaptures(runs, 's2', 0) ?? []
    runs = leaveCaptures(runs, 's1', 0) ?? []
    // The waiting painter is now a member every client version sees, and hosts.
    expect(only(runs)).toMatchObject({ wall: null, host: 's3' })
    expect(order(runs)).toEqual([3])
    expect(waiting(runs)).toEqual([])
  })

  it('moves a painter past an empty place to the next painter, and nowhere past the last', () => {
    let runs = apply(draftAll(apply(opened([2, 3, 4]), lock(120))), { type: 'capture-settings' })
    runs = leaveCaptures(runs, `s${order(runs)[1]}`, 0) ?? []
    const [first, empty, third] = only(runs).members
    expect(empty?.left).toBe(true)
    // Moving the first painter down trades places with the third, past the empty place.
    const moved = apply(runs, { type: 'capture-move', member: first?.sessionId ?? '', by: 1 })
    expect(order(moved).indexOf(first?.painter.wplaceUserId ?? 0)).toBeGreaterThan(
      order(moved).indexOf(third?.painter.wplaceUserId ?? 0),
    )
    // With no painter below the third but the pinned closer, its move changes nothing at all.
    expect(apply(runs, { type: 'capture-move', member: third?.sessionId ?? '', by: 1 })).toBe(runs)
  })
})
