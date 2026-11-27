import {
  CAPTURE_LEAD_MS,
  CAPTURE_STAGGER_MS,
  type CaptureClientEvent,
  type CaptureRun,
  type PainterIdentity,
  type Scope,
  satisfiesScope,
} from '@caelestis/shared'

/** Who sent a capture event, as the room knows the socket. */
export interface CaptureActor {
  readonly sessionId: string
  readonly painter: PainterIdentity
  /** The scope of the credential the socket connected with. */
  readonly scope: Scope
}

type RunEvent = Exclude<CaptureClientEvent, { readonly type: 'clock' }>

/**
 * The run after one event, or the same object when the event changes nothing or is not allowed.
 * Event runners and administrators open, order, plan, start and close; any painter who can write
 * joins and leaves; members report how much of their line they have drafted. Nobody joins a run
 * that has started.
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
          team: event.team,
          painters: event.painters,
          guards: event.guards,
          members: [],
          lines: [],
          startsAt: null,
          staggerMs: CAPTURE_STAGGER_MS,
        }
      : run
  if (run === null) return run
  const member = run.members.findIndex(({ sessionId }) => sessionId === actor.sessionId)
  switch (event.type) {
    case 'capture-join':
      if (
        member >= 0 ||
        event.run !== run.id ||
        event.team !== run.team ||
        run.startsAt !== null ||
        run.members.length >= run.painters + run.guards
      )
        return run
      return {
        ...run,
        members: [
          ...run.members,
          { sessionId: actor.sessionId, painter: actor.painter, drafted: 0 },
        ],
      }
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
      return { ...run, members }
    }
    case 'capture-plan':
      if (!runner || run.startsAt !== null) return run
      return {
        ...run,
        lines: event.lines.slice(0, run.painters + run.guards),
        members: run.members.map((entry) => ({ ...entry, drafted: 0 })),
      }
    case 'capture-go':
      // Every published line needs its painter, or the wall would start with a gap nobody fills.
      return runner &&
        run.lines.length > 0 &&
        run.members.length >= run.lines.length &&
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
  return members.length === run.members.length ? run : { ...run, members }
}
