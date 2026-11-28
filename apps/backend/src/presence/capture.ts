import {
  CAPTURE_LEAD_MS,
  type CaptureClientEvent,
  type CaptureMember,
  type CaptureRun,
  captureCoordinatorIndex,
  captureEndsAt,
  capturePainterCount,
  captureReady,
  captureShortfall,
  moveCaptureMember,
  type PainterIdentity,
  type Scope,
  satisfiesScope,
  type TerritoryTeam,
} from '@caelestis/shared'

/** Who sent a capture event, as the room knows the socket. */
export interface CaptureActor {
  readonly sessionId: string
  readonly painter: PainterIdentity
  /** The scope of the credential the socket connected with. */
  readonly scope: Scope
  /** The event team the session reported; it acts on that team's lobbies. */
  readonly team: TerritoryTeam
}

type RunEvent = Exclude<CaptureClientEvent, { readonly type: 'clock' }>
type OwnEvent = Exclude<RunEvent, { readonly type: 'capture-new' | 'capture-join' }>

/**
 * A team's lobbies after one event, or the same array when the event changes nothing or is not
 * allowed. A session is a member of one lobby at most. Event runners and administrators open
 * lobbies, and in their own lobby edit the settings, order members, lock in a wall, start and
 * close; any painter who can write joins and leaves; members report how much of their leg they
 * have drafted. Nobody joins a lobby whose countdown has started, and nobody leaves one before
 * its closing leg is painted.
 */
export const applyCaptureEvent = (
  runs: readonly CaptureRun[],
  event: RunEvent,
  actor: CaptureActor,
  now: number,
  newId: () => string,
): readonly CaptureRun[] => {
  const runner = satisfiesScope(actor.scope, 'event_runner')
  const me: CaptureMember = { sessionId: actor.sessionId, painter: actor.painter, drafted: 0 }
  if (event.type === 'capture-new') {
    const left = runner ? leaveCaptures(runs, actor.sessionId, now) : null
    if (left === null) return runs
    const { painters, guards, staggerMs } = event
    const opened: CaptureRun = {
      id: newId(),
      team: actor.team,
      coordinator: actor.painter.wplaceUserId,
      painters,
      guards,
      members: [me],
      wall: null,
      guardZones: [],
      startsAt: null,
      staggerMs,
      cut: 0,
    }
    return [...left, opened]
  }
  if (event.type === 'capture-join') {
    const target = runs.find(({ id }) => id === event.run)
    if (target === undefined || target.startsAt !== null || memberOf(target, actor.sessionId))
      return runs
    const left = leaveCaptures(runs, actor.sessionId, now)
    if (left === null) return runs
    return left.map((run) => (run === target ? withMembers(run, [...run.members, me]) : run))
  }
  const own = runs.find((run) => memberOf(run, actor.sessionId))
  if (own === undefined) return runs
  const next = applyOwnEvent(own, event, actor.sessionId, runner, now)
  if (next === own) return runs
  return next === null
    ? runs.filter((run) => run !== own)
    : runs.map((run) => (run === own ? next : run))
}

/** The member's own lobby after an event, the same object when nothing changes, or null closed. */
const applyOwnEvent = (
  run: CaptureRun,
  event: OwnEvent,
  sessionId: string,
  runner: boolean,
  now: number,
): CaptureRun | null => {
  switch (event.type) {
    case 'capture-leave':
      return leaveCapture(run, sessionId, now)
    case 'capture-drafted': {
      const member = run.members.findIndex((entry) => entry.sessionId === sessionId)
      const current = run.members[member]
      // A report measured in another lobby, or before the last re-cut, is about a leg this member
      // no longer has.
      if (
        current === undefined ||
        event.run !== run.id ||
        event.cut !== run.cut ||
        current.drafted === event.drafted
      )
        return run
      const members = run.members.slice()
      members[member] = { ...current, drafted: event.drafted }
      return { ...run, members }
    }
    case 'capture-close':
      return runner ? null : run
  }
  // Everything else is a runner's, and only until the countdown starts.
  if (!runner || run.startsAt !== null) return run
  switch (event.type) {
    case 'capture-settings': {
      const { painters = run.painters, guards = run.guards, staggerMs = run.staggerMs } = event
      if (painters === run.painters && guards === run.guards)
        return staggerMs === run.staggerMs ? run : { ...run, staggerMs }
      // The locked wall was planned for the old settings: back to choosing. A new guard count
      // moves the last painter's place, so the coordinator is pinned to it again.
      const resized = unlocked({ ...run, painters, guards, staggerMs })
      return withMembers(resized, resized.members)
    }
    case 'capture-move': {
      const order = moveCaptureMember(run, event.member, event.by)
      if (order === null) return run
      const rank = new Map(order.map((id, index) => [id, index]))
      // The coordinator is not in the order; withMembers pins them again.
      const members = run.members.toSorted(
        (a, b) => (rank.get(a.sessionId) ?? order.length) - (rank.get(b.sessionId) ?? order.length),
      )
      return withMembers(run, members)
    }
    case 'capture-lock':
      // Every leg must fit a painter's charges, and every guard setting needs its zone.
      if (
        event.guardZones.length !== run.guards ||
        captureShortfall(event.wall.length / 2, capturePainterCount(run)) > 0
      )
        return run
      return recut({ ...run, wall: event.wall, guardZones: event.guardZones })
    case 'capture-unlock':
      return run.wall === null ? run : unlocked(run)
    case 'capture-go':
      // Members report their own drafted counts, so this holds honest clients to their legs; a
      // client that lies about its draft can still start short.
      return captureReady(run) ? { ...run, startsAt: now + CAPTURE_LEAD_MS } : run
  }
}

/** Whether a session is in a lobby, rather than having left it once it finished. */
const memberOf = (run: CaptureRun, sessionId: string): boolean =>
  run.members.some((entry) => entry.sessionId === sessionId && entry.left !== true)

const undrafted = (member: CaptureMember): CaptureMember =>
  member.drafted === 0 ? member : { ...member, drafted: 0 }

/** The lobby with its legs re-cut: nobody has drafted their new leg, and older reports are stale. */
const recut = (run: CaptureRun, members = run.members): CaptureRun => ({
  ...run,
  members: members.map(undrafted),
  cut: run.cut + 1,
})

const unlocked = (run: CaptureRun): CaptureRun => recut({ ...run, wall: null, guardZones: [] })

/**
 * The lobby without a session, as when it leaves or its socket closes. Once the countdown starts,
 * every member keeps their place, so everyone keeps the leg, slot and guard role it started with:
 * nobody leaves until the closing leg is painted, and then a member who leaves is only marked.
 */
export const leaveCapture = (run: CaptureRun, sessionId: string, now: number): CaptureRun => {
  if (!memberOf(run, sessionId)) return run
  if (run.startsAt !== null) {
    if (now <= (captureEndsAt(run) ?? 0)) return run
    const members = run.members.map((entry) =>
      entry.sessionId === sessionId ? { ...entry, left: true as const } : entry,
    )
    return { ...run, members }
  }
  return withMembers(
    run,
    run.members.filter((entry) => entry.sessionId !== sessionId),
  )
}

/**
 * The lobbies with a session gone from whichever it was in, or null when it may not leave: its
 * countdown is running. Opening and joining start here, so a session is in one lobby at most.
 */
export const leaveCaptures = (
  runs: readonly CaptureRun[],
  sessionId: string,
  now: number,
): readonly CaptureRun[] | null => {
  const own = runs.find((run) => memberOf(run, sessionId))
  if (own === undefined) return runs
  const left = leaveCapture(own, sessionId, now)
  return left === own ? null : runs.map((run) => (run === own ? left : run))
}

/** The lobbies that still have a connected member; a lobby nobody is in closes. */
export const connectedCaptures = (
  runs: readonly CaptureRun[],
  connected: ReadonlySet<string>,
): readonly CaptureRun[] => {
  const kept = runs.filter((run) =>
    run.members.some(({ sessionId, left }) => left !== true && connected.has(sessionId)),
  )
  return kept.length === runs.length ? runs : kept
}

/**
 * The lobby with its members in a new order, the coordinator pinned. Members' legs come from their
 * places and the lobby's size, so any change to either re-cuts the wall and nobody has drafted
 * their new leg until they report it.
 */
const withMembers = (run: CaptureRun, members: readonly CaptureMember[]): CaptureRun => {
  const pinned = pinCoordinator({ ...run, members }).members
  const same =
    pinned.length === run.members.length &&
    pinned.every((member, index) => member.sessionId === run.members[index]?.sessionId)
  return same ? { ...run, members: pinned } : recut(run, pinned)
}

/**
 * The lobby with its coordinator, if they are a member, moved to the last painter's place, so
 * they always paint in the final step and close the wall. Everyone else keeps their order; a
 * coordinator who would be a guard paints instead, and the painter they displace guards.
 */
const pinCoordinator = (run: CaptureRun): CaptureRun => {
  const at = captureCoordinatorIndex(run)
  const last = capturePainterCount(run) - 1
  const coordinator = run.members[at]
  if (coordinator === undefined || at === last) return run
  const others = run.members.filter((_, index) => index !== at)
  return { ...run, members: [...others.slice(0, last), coordinator, ...others.slice(last)] }
}
