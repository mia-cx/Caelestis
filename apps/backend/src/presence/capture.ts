import {
  CAPTURE_LEAD_MS,
  CAPTURE_STAGGER_MS,
  type CaptureClientEvent,
  type CaptureMember,
  type CaptureRun,
  captureCoordinatorIndex,
  capturePaintersDrafted,
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
  /** The event team the session reported; it acts on that team's run. */
  readonly team: TerritoryTeam
}

type RunEvent = Exclude<CaptureClientEvent, { readonly type: 'clock' }>

/**
 * The run after one event, or the same object when the event changes nothing or is not allowed.
 * Event runners and administrators open, order, plan, start and close; any painter who can write
 * joins and leaves; members report how much of their line they have drafted. Nobody joins a run
 * that has started, and Go waits until every painter has drafted their line. Whatever the order,
 * the run's coordinator paints the last painter's line.
 */
export const applyCaptureEvent = (
  run: CaptureRun | null,
  event: RunEvent,
  actor: CaptureActor,
  now: number,
  newId: () => string,
): CaptureRun | null => {
  const runner = satisfiesScope(actor.scope, 'event_runner')
  // Opening needs an empty room: a run in progress is closed first, never replaced.
  if (event.type === 'capture-open')
    return runner && run === null
      ? {
          id: newId(),
          team: actor.team,
          coordinator: actor.painter.wplaceUserId,
          painters: event.painters,
          guards: event.guards,
          members: [],
          lines: [],
          startsAt: null,
          staggerMs: event.staggerMs ?? CAPTURE_STAGGER_MS,
        }
      : run
  if (run === null) return run
  const member = run.members.findIndex(({ sessionId }) => sessionId === actor.sessionId)
  switch (event.type) {
    case 'capture-join':
      if (
        member >= 0 ||
        event.run !== run.id ||
        run.startsAt !== null ||
        run.members.length >= run.painters + run.guards
      )
        return run
      return withMembers(run, [
        ...run.members,
        { sessionId: actor.sessionId, painter: actor.painter, drafted: 0 },
      ])
    case 'capture-leave':
      return member < 0 ? run : leaveCapture(run, actor.sessionId)
    case 'capture-drafted': {
      const current = run.members[member]
      if (current === undefined || current.drafted === event.drafted) return run
      const members = run.members.slice()
      members[member] = { ...current, drafted: event.drafted }
      return { ...run, members }
    }
    case 'capture-order': {
      if (!runner || run.startsAt !== null) return run
      const rank = new Map(event.order.map((id, index) => [id, index]))
      const members = run.members
        .map((entry, index) => ({
          entry,
          rank: rank.get(entry.sessionId) ?? event.order.length + index,
        }))
        .sort((a, b) => a.rank - b.rank)
        .map(({ entry }) => entry)
      return withMembers(run, members)
    }
    case 'capture-plan':
      if (!runner || run.startsAt !== null) return run
      return {
        ...run,
        lines: event.lines.slice(0, run.painters + run.guards),
        members: run.members.map((entry) => ({ ...entry, drafted: 0 })),
      }
    case 'capture-go':
      // Every published line needs its painter, or the wall would start with a gap nobody fills,
      // and every painter their line drafted. Members report their own drafted counts, so this
      // holds honest clients to it; a client that lies about its draft can still start short.
      return runner &&
        run.lines.length > 0 &&
        run.members.length >= run.lines.length &&
        capturePaintersDrafted(run) &&
        run.startsAt === null
        ? { ...run, startsAt: now + CAPTURE_LEAD_MS }
        : run
    case 'capture-close':
      return runner ? null : run
  }
}

/**
 * The run without a session, as when it leaves or its socket closes. Once started, every member
 * keeps their place: their slot and line were fixed at Go, and shifting the others would hand
 * them lines they have not drafted.
 */
export const leaveCapture = (run: CaptureRun, sessionId: string): CaptureRun => {
  if (run.startsAt !== null) return run
  const members = run.members.filter((entry) => entry.sessionId !== sessionId)
  return members.length === run.members.length ? run : withMembers(run, members)
}

/**
 * The run with its members in a new order, the coordinator pinned. A member's place is their
 * line, so anyone whose place changed has drafted nothing of their new line until they report it.
 */
const withMembers = (run: CaptureRun, members: readonly CaptureMember[]): CaptureRun => {
  const was = new Map(run.members.map(({ sessionId }, index) => [sessionId, index]))
  return {
    ...run,
    members: pinCoordinator({ ...run, members }).members.map((member, index) =>
      was.get(member.sessionId) === index || member.drafted === 0
        ? member
        : { ...member, drafted: 0 },
    ),
  }
}

/**
 * The run with its coordinator, if they are a member, moved to the last painter's place, so they
 * always paint in the final step and close the wall. Everyone else keeps their order; a coordinator
 * who would be a guard paints instead, and the painter they displace guards.
 */
const pinCoordinator = (run: CaptureRun): CaptureRun => {
  const at = captureCoordinatorIndex(run)
  const last = Math.min(run.painters, run.members.length) - 1
  const coordinator = run.members[at]
  if (coordinator === undefined || at === last) return run
  const others = run.members.filter((_, index) => index !== at)
  return { ...run, members: [...others.slice(0, last), coordinator, ...others.slice(last)] }
}
