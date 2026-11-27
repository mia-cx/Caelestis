import {
  CAPTURE_LEAD_MS,
  CAPTURE_STAGGER_MS,
  type CaptureClientEvent,
  type CaptureRun,
  type PainterIdentity,
} from '@caelestis/shared'

/** Who sent a capture event, as the room knows the socket. */
export interface CaptureActor {
  readonly sessionId: string
  readonly painter: PainterIdentity
  readonly admin: boolean
}

type RunEvent = Exclude<CaptureClientEvent, { readonly type: 'clock' }>

/**
 * The run after one event, or the same object when the event changes nothing or is not allowed.
 * Administrators open, order, plan, start and close; any painter who can write joins and leaves;
 * members report how much of their line they have drafted. Nobody joins a run that has started.
 */
export const applyCaptureEvent = (
  run: CaptureRun | null,
  event: RunEvent,
  actor: CaptureActor,
  now: number,
  newId: () => string,
): CaptureRun | null => {
  if (event.type === 'capture-open')
    return actor.admin
      ? {
          id: newId(),
          painters: event.painters,
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
      if (member >= 0 || run.startsAt !== null || run.members.length >= run.painters) return run
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
      if (!actor.admin) return run
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
      if (!actor.admin || run.startsAt !== null) return run
      return {
        ...run,
        lines: event.lines.slice(0, run.painters),
        members: run.members.map((entry) => ({ ...entry, drafted: 0 })),
      }
    case 'capture-go':
      return actor.admin && run.lines.length > 0 && run.startsAt === null
        ? { ...run, startsAt: now + CAPTURE_LEAD_MS }
        : run
    case 'capture-close':
      return actor.admin ? null : run
  }
}

/** The run without a session, as when its socket closes. */
export const leaveCapture = (run: CaptureRun, sessionId: string): CaptureRun => {
  const members = run.members.filter((entry) => entry.sessionId !== sessionId)
  return members.length === run.members.length ? run : { ...run, members }
}
