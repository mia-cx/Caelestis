/**
 * The capture lobby card: a group of painters in a Wplace territory event placing one planned wall
 * in turn, each a few hundred milliseconds after the one before, so the last painter closes the
 * loop.
 *
 * The userscript owns the lobbies and builds this model; the card renders it and emits intents.
 * One card serves every member: the lobby's host, or an administrator in it, also edits its
 * settings, orders members, gives the closing leg, locks in a wall, starts and closes.
 */

export interface CaptureRunMember {
  /** Stable key for the row: the member's session. */
  readonly id: string
  readonly name: string
  /** The painter's presence colour as CSS, the same colour their leg is drawn in on the map. */
  readonly colour: string
  /** Pixels of their leg they have drafted, and the leg's length; length 0 before a lock-in. */
  readonly drafted: number
  readonly length: number
  /** This tab's painter. */
  readonly me: boolean
  /** An anchor guard: thickens one end of the wall at the start, then holds it. */
  readonly guard: boolean
  /** A reserve: the wall was cut into fewer legs than painters, so they have none. */
  readonly reserve: boolean
  /** The lobby's closer: they keep the last painter's place and close the wall. */
  readonly closes: boolean
  /** The lobby's host, who runs it; at first its opener, who also closes. */
  readonly hosts: boolean
}

/** A lobby in the list, for painters outside every lobby. */
export interface CaptureLobby {
  readonly id: string
  /** Its host's name. */
  readonly name: string
  readonly members: number
  /** False once its countdown has started or this painter cannot write. */
  readonly canJoin: boolean
}

export interface CaptureProposal {
  readonly id: string
  /** Where the wall goes, e.g. "Into purple, on the canvas edge". */
  readonly label: string
  /** Territory the wall would gain, and the pixels it paints. */
  readonly gained: number
  readonly pixels: number
  /** More painters the lobby needs before every leg fits a painter's charges; 0 to lock in. */
  readonly needs: number
}

export type CapturePhase =
  /** In no lobby: the team's lobbies to join, largest first, and New lobby. */
  | 'list'
  /** In a lobby: members gather, the host locks in a wall. */
  | 'gathering'
  /** Started: every client counts down to its slot. */
  | 'countdown'
  /** Every slot has passed. */
  | 'done'

export interface CaptureRunModel {
  readonly phase: CapturePhase
  /**
   * The card shows only its bar: the header with its one-line summary, and the countdown or the
   * anchor watch when one is running. The host keeps it across the element's removal.
   */
  readonly collapsed: boolean
  /** This painter runs the lobby they are in, as its host or an administrator. */
  readonly canRun: boolean
  /** This painter can open a lobby. */
  readonly canOpen: boolean
  /** Outside a lobby: the team's lobbies whose countdown has not started, largest first. */
  readonly lobbies: readonly CaptureLobby[]
  /** The painters the lobby plans for, within 1 to `maxPainters`. */
  readonly painters: number
  readonly maxPainters: number
  /** Anchor guards, from 0 to `maxGuards`: half the lobby, rounded down. */
  readonly guards: number
  readonly maxGuards: number
  /** How the wall is shared: a leg per painter, or the fewest legs with the rest in reserve. */
  readonly distribution: 'even' | 'reserve'
  /** Time between countdown steps, within the shared capture stagger bounds. */
  readonly staggerMs: number
  /** Time from Start countdown to the first painter's slot, within the shared lead bounds. */
  readonly leadMs: number
  /**
   * For a guard once the countdown has started: whether their anchor still belongs to the team.
   * `cut` also plays an alarm; the guard repaints it from their zone.
   */
  readonly anchor: 'intact' | 'cut' | null
  /** In paint order. */
  readonly members: readonly CaptureRunMember[]
  /** This painter's part in the lobby: building the wall in turn, guarding an anchor, or neither. */
  readonly role: 'painter' | 'guard' | 'reserve' | null
  /** For whoever runs the lobby: walls planned live from the map, best first, until one is locked in. */
  readonly proposals: readonly CaptureProposal[]
  /** A wall is locked in and cut into legs. */
  readonly locked: boolean
  /** With a wall locked in, the painters still needed before every leg fits; 0 when none. */
  readonly needs: number
  /** For whoever runs the lobby: the countdown may start: every painter has drafted their leg. */
  readonly canStart: boolean
  /**
   * When this tab's painter paints, as a `performance.now()` time, while counting down and they
   * have a leg. A deadline rather than a remaining time, so the card can count down every frame on
   * its own, shown as `mm:ss.mmm`.
   */
  readonly mySlotAt: number | null
  /** This painter's countdown step, from 1, while they paint the wall; pairs share a step. */
  readonly myTurn: number | null
  /** Countdown steps the wall takes: the painters in pairs. */
  readonly turns: number
  /** When the first painter paints, as a `performance.now()` time, while counting down. */
  readonly startsAt: number | null
  /** A short status or error, e.g. "Join a team in the event first." */
  readonly message?: string
}

export type CaptureRunIntent =
  /** Collapse the card to its bar, or expand it. */
  | { readonly type: 'set-collapsed'; readonly collapsed: boolean }
  | { readonly type: 'set-painters'; readonly painters: number }
  | { readonly type: 'set-guards'; readonly guards: number }
  | { readonly type: 'set-stagger'; readonly staggerMs: number }
  | { readonly type: 'set-lead'; readonly leadMs: number }
  | { readonly type: 'set-distribution'; readonly distribution: 'even' | 'reserve' }
  /** Open a lobby and join it. */
  | { readonly type: 'open' }
  | { readonly type: 'join'; readonly id: string }
  | { readonly type: 'leave' }
  /** Move a member one place earlier (-1) or later (1) in the order. */
  | { readonly type: 'move'; readonly id: string; readonly by: -1 | 1 }
  /** Give a member the closing leg: they become the closer. */
  | { readonly type: 'closer'; readonly id: string }
  /**
   * Lock in a proposal's wall; `unlock` drops it and planning resumes. Once the capture has
   * finished, `unlock` starts the lobby's next round the same way.
   */
  | { readonly type: 'lock'; readonly id: string }
  | { readonly type: 'unlock' }
  /** Fly the map to this painter's leg. */
  | { readonly type: 'show-line' }
  /** Start the countdown. */
  | { readonly type: 'go' }
  | { readonly type: 'close' }
