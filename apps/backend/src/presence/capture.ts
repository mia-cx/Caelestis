import {
  CAPTURE_LEAD_MS,
  type CaptureClientEvent,
  type CaptureMember,
  type CaptureRun,
  type CaptureTimingReport,
  captureCoordinatorIndex,
  captureEndsAt,
  captureEveryone,
  captureGuardCount,
  captureHostIndex,
  captureLead,
  captureLegCount,
  capturePainterCount,
  captureReady,
  captureShortfall,
  captureSlot,
  captureStep,
  isCaptureCoverage,
  isCaptureGuard,
  isCaptureReserve,
  MAX_CAPTURE_MEMBERS,
  maxCaptureGuards,
  moveCaptureMember,
  type PainterIdentity,
  type Scope,
  satisfiesScope,
  type TerritoryTeam,
  type WplaceUserId,
} from '@caelestis/shared'

/** Who sent a capture event, as the room knows the socket. */
export interface CaptureActor {
  readonly sessionId: string
  readonly painter: PainterIdentity
  /** The scope of the credential the socket connected with. */
  readonly scope: Scope
  /** The event team the session reported; it acts on that team's lobbies. */
  readonly team: TerritoryTeam
  /** The hash of the session's browser client id: which places it may take over. */
  readonly client: string
}

/** A connected session as reconnection sees it: whose it is, and from which browser. */
export interface CaptureSeatOwner {
  readonly painter: WplaceUserId
  readonly client: string
}

type RunEvent = Exclude<
  CaptureClientEvent,
  {
    readonly type: 'clock' | 'capture-timing' | 'latency-report'
  }
>
type OwnEvent = Exclude<RunEvent, { readonly type: 'capture-new' | 'capture-join' }>

/**
 * A team's lobbies after one event, or the same array when the event changes nothing or is not
 * allowed. A session is a member of one lobby at most. Any painter who can write opens, joins and
 * leaves lobbies; members report what they have drafted and press Ready. The lobby's host, and an
 * administrator in it, run it: edit the settings, order members, give the closing leg, lock in a
 * wall, start and close. Nobody joins a lobby whose countdown has started, and nobody leaves one
 * before its closing leg is painted.
 */
export const applyCaptureEvent = (
  runs: readonly CaptureRun[],
  event: RunEvent,
  actor: CaptureActor,
  now: number,
  newId: () => string,
): readonly CaptureRun[] => {
  // A tab with a Ready button says so as it joins, so Wait for Ready waits for it from the start.
  const readies =
    (event.type === 'capture-new' || event.type === 'capture-join') && event.ready === false
  const me = (joined: number): CaptureMember => ({
    sessionId: actor.sessionId,
    painter: actor.painter,
    drafted: 0,
    joined,
    client: actor.client,
    ...(readies ? { ready: false } : {}),
  })
  if (event.type === 'capture-new') {
    const left = leaveCaptures(runs, actor.sessionId, now)
    if (left === null) return runs
    const { painters, staggerMs, guards = 0, leadMs = CAPTURE_LEAD_MS } = event
    const { distribution = 'even', waitForReady = false } = event
    const opened: CaptureRun = {
      id: newId(),
      team: actor.team,
      opener: actor.painter.wplaceUserId,
      coordinator: actor.painter.wplaceUserId,
      host: actor.sessionId,
      painters,
      // The guards chosen: as painters join, up to half the lobby guard.
      guards,
      distribution,
      ...(waitForReady ? { waitForReady } : {}),
      members: [me(0)],
      wall: null,
      guardZones: [],
      startsAt: null,
      staggerMs,
      leadMs,
      cut: 0,
    }
    return [...left, opened]
  }
  if (event.type === 'capture-join') {
    const target = runs.find(({ id }) => id === event.run)
    if (target === undefined || memberOf(target, actor.sessionId)) return runs
    // A painter is one member: joining again from a new tab or socket in the same browser takes
    // back their place, leg and slot, also once the countdown has started. The painter id is the
    // client's word, so a place held from another browser is not theirs to take, nor to double.
    const everyone = captureEveryone(target)
    const place = placeOf(target, actor.painter.wplaceUserId)
    if (place !== -1 && everyone[place]?.client !== actor.client) return runs
    // Nobody new joins once the countdown starts, nor a lobby as full as the wire allows: clients
    // refuse a lobby with more members than that.
    if (place === -1 && (target.startsAt !== null || everyone.length >= MAX_CAPTURE_MEMBERS))
      return runs
    const left = leaveCaptures(runs, actor.sessionId, now)
    if (left === null) return runs
    if (place !== -1)
      return left.map((run) =>
        run.id === target.id ? reseated(run, place, actor.sessionId, readies) : run,
      )
    const joined = Math.max(0, ...everyone.map((member) => (member.joined ?? 0) + 1))
    return left.map((run) => (run === target ? joinedBy(run, me(joined)) : run))
  }
  const own = runs.find((run) => memberOf(run, actor.sessionId))
  if (own === undefined) return runs
  const hosting =
    satisfiesScope(actor.scope, 'admin') ||
    captureEveryone(own)[captureHostIndex(own)]?.sessionId === actor.sessionId
  const next = applyOwnEvent(own, event, actor.sessionId, hosting, now)
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
  hosting: boolean,
  now: number,
): CaptureRun | null => {
  switch (event.type) {
    case 'capture-leave':
      return leaveCapture(run, sessionId, now)
    case 'capture-drafted': {
      const member = run.members.findIndex((entry) => entry.sessionId === sessionId)
      const current = run.members[member]
      // A report measured in another lobby, or before the last re-cut, is about a leg this member
      // no longer has; a coverage that doesn't fit the wall says nothing about it.
      if (current === undefined || event.run !== run.id || event.cut !== run.cut) return run
      const { drafted } = event
      const covered = isCaptureCoverage(run, event.covered) ? event.covered : current.covered
      if (current.drafted === drafted && current.covered === covered) return run
      const members = run.members.slice()
      members[member] = { ...current, drafted, ...(covered === undefined ? {} : { covered }) }
      return { ...run, members }
    }
    case 'capture-ready': {
      // Anyone in the lobby, so a painter waiting for a lock-in can say their tab has the button.
      const everyone = captureEveryone(run)
      const place = everyone.findIndex((entry) => entry.sessionId === sessionId)
      const current = everyone[place]
      if (
        current === undefined ||
        event.run !== run.id ||
        event.cut !== run.cut ||
        run.startsAt !== null ||
        current.ready === event.ready
      )
        return run
      const seat = { ...current, ready: event.ready }
      const spot = place - run.members.length
      return spot < 0
        ? { ...run, members: run.members.with(place, seat) }
        : { ...run, waiting: (run.waiting ?? []).with(spot, seat) }
    }
    case 'capture-close':
      return hosting ? null : run
  }
  // Once the closing leg is painted, the host's unlock starts the lobby's next round.
  if (event.type === 'capture-unlock' && hosting && run.startsAt !== null)
    return now > (captureEndsAt(run) ?? 0) ? nextRound(run) : run
  // Everything else is the host's, and only until the countdown starts.
  if (!hosting || run.startsAt !== null) return run
  switch (event.type) {
    case 'capture-settings': {
      const { painters = run.painters, staggerMs = run.staggerMs } = event
      const { distribution = run.distribution, leadMs = captureLead(run) } = event
      const { waitForReady: _, ...rest } = run
      const waitForReady = event.waitForReady ?? run.waitForReady === true
      // At most half the lobby guards.
      const guards =
        event.guards === undefined ? run.guards : Math.min(event.guards, maxCaptureGuards(run))
      const next: CaptureRun = {
        ...rest,
        painters,
        guards,
        staggerMs,
        leadMs,
        distribution,
        ...(waitForReady ? { waitForReady } : {}),
      }
      // The locked wall was planned for the old size: back to choosing.
      if (painters !== run.painters || guards !== run.guards) return unlocked(next)
      // The same wall, cut into a different number of legs.
      if (distribution !== run.distribution) return recut(next)
      const same =
        staggerMs === run.staggerMs &&
        leadMs === captureLead(run) &&
        waitForReady === (run.waitForReady === true)
      return same ? run : next
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
    case 'capture-closer': {
      // Any member with a place, guards and reserves too. They swap places with whoever holds the
      // closing leg, the closer or, once the closer has left, the member pinned there since; that
      // member takes their old role, guard zone or reserve place, and nobody else moves.
      const to = run.members.findIndex(({ sessionId }) => sessionId === event.member)
      const incoming = run.members[to]
      if (
        incoming === undefined ||
        incoming.left === true ||
        incoming.painter.wplaceUserId === run.coordinator
      )
        return run
      const from = captureLegCount(run) - 1
      const outgoing = run.members[from]
      const members = run.members.slice()
      if (outgoing !== undefined) {
        members[from] = incoming
        members[to] = outgoing
      }
      return withMembers({ ...run, coordinator: incoming.painter.wplaceUserId }, members)
    }
    case 'capture-lock': {
      const { wall, guardZones } = event
      const next = { ...seatedAll(run), wall, guardZones }
      // Every leg must fit a painter's charges, and every guard the lobby has needs its zone.
      if (
        guardZones.length !== captureGuardCount(next) ||
        captureShortfall(wall.length / 2, capturePainterCount(next)) > 0
      )
        return run
      return recut(next)
    }
    case 'capture-unlock':
      return run.wall === null ? run : unlocked(run)
    case 'capture-go':
      // Members report what they drafted, so this holds honest clients to the wall; a client that
      // lies about its draft can still start short.
      return captureReady(run) ? { ...run, startsAt: now + captureLead(run) } : run
  }
}

/** Whether a session is in a lobby, rather than having left it once it finished. */
const memberOf = (run: CaptureRun, sessionId: string): boolean =>
  captureEveryone(run).some((entry) => entry.sessionId === sessionId && entry.left !== true)

/**
 * Where a painter is in a lobby, as an index in `captureEveryone`, or -1: a place they have not
 * left, a spot among those waiting, or before the countdown a place they left empty after the
 * lock-in, which is still theirs to take back.
 */
const placeOf = (run: CaptureRun, painter: WplaceUserId): number =>
  captureEveryone(run).findIndex(
    (entry) =>
      entry.painter.wplaceUserId === painter && (entry.left !== true || run.startsAt === null),
  )

/**
 * The lobby with the member at `place` in `captureEveryone` on a new session of theirs, in it
 * again if they had left the place, and hosting if the old session did.
 *
 * Before the countdown, what the old session drafted and its Ready were that tab's, so the new one
 * starts with nothing drafted and Ready released, and reports its own. Whether it has a Ready
 * button is `readies` when it joined to say so; a reconnect sends nothing, so it keeps that of the
 * browser the place belongs to. Once the countdown starts, the place keeps everything.
 */
const reseated = (
  run: CaptureRun,
  place: number,
  sessionId: string,
  readies?: boolean,
): CaptureRun => {
  const member = captureEveryone(run)[place]
  if (member === undefined) return run
  const { left: _, ...back } = member
  const seat = run.startsAt !== null ? { ...back, sessionId } : freshSeat(back, sessionId, readies)
  const host = run.host === member.sessionId ? { host: sessionId } : {}
  const spot = place - run.members.length
  return spot < 0
    ? { ...run, members: run.members.with(place, seat), ...host }
    : { ...run, waiting: (run.waiting ?? []).with(spot, seat), ...host }
}

/** A place on a new session, before the countdown; see `reseated`. */
const freshSeat = (
  member: CaptureMember,
  sessionId: string,
  readies: boolean | undefined,
): CaptureMember => {
  const { ready: _, ...seat } = { ...undrafted(member), sessionId }
  const ready = readies ?? member.ready !== undefined
  return ready ? { ...seat, ready: false } : seat
}

/** The lobby with `waiting` as those waiting for the next lock-in, the key dropped when none. */
const withWaiting = (
  { waiting: _, ...run }: CaptureRun,
  waiting: readonly CaptureMember[],
): CaptureRun => (waiting.length === 0 ? run : { ...run, waiting })

/**
 * The lobby with everyone in it given a place, as Lock in gives them out: places left empty go,
 * and those waiting take places after `members`, the lobby's own by default.
 */
const seatedAll = (
  { waiting = [], ...run }: CaptureRun,
  members: readonly CaptureMember[] = run.members,
): CaptureRun => ({ ...run, members: [...members.filter(({ left }) => left !== true), ...waiting] })

/**
 * The lobby with a new member. Before a lock-in they take their part when it is cut; after one,
 * they wait without a leg until the next, and nobody else's leg, role or draft changes.
 */
const joinedBy = (run: CaptureRun, member: CaptureMember): CaptureRun =>
  run.wall === null
    ? withMembers(run, [...run.members, member])
    : withWaiting(run, [...(run.waiting ?? []), member])

/**
 * The lobby without the members `gone` picks, before its countdown. Before a lock-in they leave
 * the order. After one, nobody else's leg, role or order changes: a member waiting for the next
 * lock-in goes, and one the lock-in gave a place leaves it empty, which holds the countdown until
 * the host locks in again.
 */
const withoutMembers = (run: CaptureRun, gone: (member: CaptureMember) => boolean): CaptureRun => {
  if (run.wall === null)
    return withMembers(
      run,
      run.members.filter((member) => !gone(member)),
    )
  const members = run.members.map((member) =>
    gone(member) ? { ...undrafted(member), left: true as const } : member,
  )
  const waiting = (run.waiting ?? []).filter((member) => !gone(member))
  // With every place empty the lock-in holds nobody: back to choosing, with those waiting seated,
  // so a host is someone every client version sees in the lobby.
  if (members.every(({ left }) => left === true))
    return unlocked(withWaiting({ ...run, members }, waiting))
  return hosted(withWaiting({ ...run, members }, waiting))
}

/**
 * A member with nothing drafted and not Ready, as on a new leg. A tab with a Ready button stays
 * one: `ready` goes back to false rather than away.
 */
const undrafted = ({ covered: _, ...member }: CaptureMember): CaptureMember => ({
  ...member,
  drafted: 0,
  ...(member.ready === undefined ? {} : { ready: false }),
})

/**
 * The lobby with its legs re-cut: the coordinator pinned to the closing leg again, nobody has
 * drafted their new leg or is Ready for it, and older reports are stale.
 */
const recut = (run: CaptureRun): CaptureRun => {
  const pinned = pinCoordinator(run)
  return { ...pinned, members: pinned.members.map(undrafted), cut: run.cut + 1 }
}

/**
 * A finished lobby back to choosing its next wall: the same settings and members, without those
 * who left after the last one, nothing drafted and no countdown.
 */
const nextRound = (run: CaptureRun): CaptureRun => unlocked({ ...run, startsAt: null })

/** The lobby back to choosing: no wall, places left empty gone, and nobody waiting. */
const unlocked = (run: CaptureRun): CaptureRun =>
  recut(hosted({ ...seatedAll(run), wall: null, guardZones: [] }))

/**
 * The lobby without a session, as when it leaves or its socket closes; see `withoutMembers`. Once
 * the countdown starts, every member with a place keeps it, so everyone keeps the leg, slot and
 * guard role it started with: nobody leaves until the closing leg is painted, and then a member
 * who leaves is only marked. A member waiting for a lock-in has no slot and leaves at any time.
 */
export const leaveCapture = (run: CaptureRun, sessionId: string, now: number): CaptureRun => {
  if (!memberOf(run, sessionId)) return run
  const leaving = (entry: CaptureMember) => entry.sessionId === sessionId && entry.left !== true
  if (run.startsAt === null) return withoutMembers(run, leaving)
  if (!run.members.some(leaving))
    return hosted(
      withWaiting(
        run,
        (run.waiting ?? []).filter((entry) => !leaving(entry)),
      ),
    )
  if (now <= (captureEndsAt(run) ?? 0)) return run
  const members = run.members.map((entry) =>
    leaving(entry) ? { ...entry, left: true as const } : entry,
  )
  return hosted({ ...run, members })
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

/**
 * The lobbies with each place whose session is gone handed to a connected session of the same
 * painter, from the same browser, that is in no lobby: a painter whose socket reconnected, or whose
 * old socket only closed after they did, keeps their leg and slot. The same array when nobody
 * comes back. `connected` holds each connected session's owner.
 */
export const reseatCaptures = (
  runs: readonly CaptureRun[],
  connected: ReadonlyMap<string, CaptureSeatOwner>,
): readonly CaptureRun[] => {
  const seated = new Set(
    runs.flatMap((run) =>
      captureEveryone(run)
        .filter(({ left }) => left !== true)
        .map(({ sessionId }) => sessionId),
    ),
  )
  const owner = (painter: WplaceUserId, client: string | undefined) => `${painter}:${client}`
  // Per painter and browser, a connected session in no lobby yet: the latest, if several.
  const spare = new Map<string, string>()
  for (const [sessionId, { painter, client }] of connected)
    if (!seated.has(sessionId)) spare.set(owner(painter, client), sessionId)
  if (spare.size === 0) return runs
  let changed = false
  const back = runs.map((before) =>
    captureEveryone(before).reduce((run, { sessionId, painter, left, client }, place) => {
      const key = owner(painter.wplaceUserId, client)
      const session = spare.get(key)
      if (left === true || client === undefined || connected.has(sessionId) || !session) return run
      spare.delete(key)
      changed = true
      return reseated(run, place, session)
    }, before),
  )
  return changed ? back : runs
}

/**
 * The lobbies that still have a connected member, a lobby nobody is in closing, each hosted by a
 * connected member, after `reseatCaptures` gives returning painters their places back. A gathering
 * lobby also lets members whose sessions are gone go, as `withoutMembers` does: one who
 * disconnected during a countdown kept their place until it ended, and must not carry into the next
 * round. A started lobby keeps them, so its host passes to the longest-standing connected member.
 */
export const connectedCaptures = (
  runs: readonly CaptureRun[],
  connected: ReadonlyMap<string, CaptureSeatOwner>,
): readonly CaptureRun[] => {
  const back = reseatCaptures(runs, connected)
  let changed = back !== runs
  const gone = ({ sessionId, left }: CaptureMember) => left !== true && !connected.has(sessionId)
  const kept = back.flatMap((run) => {
    const everyone = captureEveryone(run)
    if (!everyone.some(({ sessionId, left }) => left !== true && connected.has(sessionId))) {
      changed = true
      return []
    }
    const trimmed = run.startsAt !== null || !everyone.some(gone) ? run : withoutMembers(run, gone)
    const next = hosted(trimmed, ({ sessionId }) => connected.has(sessionId))
    if (next !== run) changed = true
    return [next]
  })
  return changed ? kept : runs
}

/**
 * The lobby with its members in a new order, the coordinator pinned, as a lobby still choosing or
 * the host sets it. Members' legs come from their places and the lobby's size, so any change to
 * either re-cuts the wall and nobody has drafted their new leg until they report it. A locked wall
 * is cut again for everyone in the lobby, as Lock in cuts it: empty places go, and members waiting
 * for a lock-in take a part.
 */
const withMembers = (run: CaptureRun, members: readonly CaptureMember[]): CaptureRun => {
  const next = hosted(pinCoordinator(seatedAll(run, members)))
  const same =
    run.waiting === undefined &&
    next.members.length === run.members.length &&
    next.members.every((member, index) => member.sessionId === run.members[index]?.sessionId)
  if (same) return next
  // The locked guard zones were planned for as many guards as the lobby had: back to choosing.
  if (run.wall !== null && captureGuardCount(next) !== captureGuardCount(run)) return unlocked(next)
  return recut(next)
}

/**
 * The lobby with its host recorded: the one `captureHostIndex` finds among `eligible` members, so
 * a departed host's place passes on, and a lobby stored by backend 1.6.0 records its opener. The
 * same object when nothing changes, or when nobody eligible is left to host.
 */
const hosted = (run: CaptureRun, eligible?: (member: CaptureMember) => boolean): CaptureRun => {
  const host = captureEveryone(run)[captureHostIndex(run, eligible)]?.sessionId
  return host === undefined || host === run.host ? run : { ...run, host }
}

/**
 * The lobby with its coordinator, if they are a member, moved to the last leg's place, so they
 * always paint in the final step and close the wall. Everyone else keeps their order; a
 * coordinator who would be a guard or a reserve paints instead, and the member they displace
 * takes their role. One waiting for a lock-in has no place to move until it seats them.
 */
const pinCoordinator = (run: CaptureRun): CaptureRun => {
  const at = captureCoordinatorIndex(run)
  const last = captureLegCount(run) - 1
  const coordinator = run.members[at]
  if (coordinator === undefined || at === last) return run
  const others = run.members.filter((_, index) => index !== at)
  return { ...run, members: [...others.slice(0, last), coordinator, ...others.slice(last)] }
}

/** The lobbies as sessions receive them: without the browser each place belongs to. */
export const sentCaptures = (runs: readonly CaptureRun[]): readonly CaptureRun[] => {
  const sent = (members: readonly CaptureMember[]) =>
    members.map(({ client: _, ...member }) => member)
  return runs.map((run) =>
    run.waiting === undefined
      ? { ...run, members: sent(run.members) }
      : { ...run, members: sent(run.members), waiting: sent(run.waiting) },
  )
}

/**
 * The places handed to a new session between `before` and `after`, as `[lobby, from, to]`
 * sessions: the same painter in the same place of the same lobby, or the same spot among those
 * waiting, on another session.
 */
export const handedPlaces = (
  before: readonly CaptureRun[],
  after: readonly CaptureRun[],
): (readonly [string, string, string])[] =>
  after.flatMap((run) => {
    const old = before.find(({ id }) => id === run.id)
    if (old === undefined) return []
    const places = captureEveryone(old)
    return captureEveryone(run).flatMap(({ sessionId, painter }, place) => {
      const was = places[place]
      return was !== undefined &&
        was.sessionId !== sessionId &&
        was.painter.wplaceUserId === painter.wplaceUserId
        ? [[run.id, was.sessionId, sessionId] as const]
        : []
    })
  })

/** The lobbies that started their countdown between `before` and `after`. */
export const newlyStarted = (
  before: readonly CaptureRun[],
  after: readonly CaptureRun[],
): readonly CaptureRun[] =>
  after.filter(
    (run) => run.startsAt !== null && before.find(({ id }) => id === run.id)?.startsAt === null,
  )

/**
 * The log line for a lobby starting its countdown: its members in paint order with their step, so
 * slot reports can be read against it. Guards paint at the first step; reserves have none.
 */
export const captureStartLog = (run: CaptureRun): object => ({
  event: 'capture-countdown',
  lobby: run.id,
  team: run.team,
  startsAt: run.startsAt,
  staggerMs: run.staggerMs,
  members: run.members.map(({ painter }, index) => ({
    name: painter.displayName,
    userId: painter.wplaceUserId,
    role: isCaptureGuard(run, index)
      ? 'guard'
      : isCaptureReserve(run, index)
        ? 'reserve'
        : 'painter',
    step: isCaptureReserve(run, index) ? null : captureStep(run, index),
  })),
})

/** A member's slot in a started lobby, fixed when its countdown started. */
export interface CaptureAssignment {
  readonly lobby: string
  readonly team: TerritoryTeam
  readonly slotAt: number
  readonly step: number
}

/** Each member's slot in a started lobby, by session; reserves have none. */
export const captureAssignments = (run: CaptureRun): ReadonlyMap<string, CaptureAssignment> =>
  new Map(
    run.members.flatMap(({ sessionId }, index) => {
      const slotAt = captureSlot(run, index)
      return slotAt === null
        ? []
        : [[sessionId, { lobby: run.id, team: run.team, slotAt, step: captureStep(run, index) }]]
    }),
  )

/**
 * The log line for a member's slot report, or null unless it matches the slot the server assigned
 * that session when the countdown started. A report that lands after its lobby closed, as when a
 * host closes it while a painter still waits on Wplace, is logged with `closed`.
 */
export const captureSlotLog = (
  report: CaptureTimingReport,
  assigned: CaptureAssignment | undefined,
  painter: PainterIdentity,
  closed: boolean,
): object | null => {
  if (assigned === undefined || assigned.lobby !== report.run || assigned.slotAt !== report.slotAt)
    return null
  return {
    event: 'capture-slot',
    lobby: assigned.lobby,
    team: assigned.team,
    name: painter.displayName,
    userId: painter.wplaceUserId,
    step: assigned.step,
    ...(closed ? { closed: true } : {}),
    slotAt: report.slotAt,
    firedLateMs: report.firedLateMs,
    clickToSendMs: report.clickToSendMs,
    sendToResponseMs: report.sendToResponseMs,
    status: report.status,
    wplaceRttMs: report.wplaceRttMs,
    clockOffsetMs: report.clockOffsetMs,
    clockRttMs: report.clockRttMs,
  }
}
