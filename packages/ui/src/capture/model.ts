/**
 * The capture run card: a group of painters in a Wplace territory event placing one planned wall in
 * turn, each a few hundred milliseconds after the one before, so the last painter closes the loop.
 *
 * The userscript owns the run and builds this model; the card renders it and emits intents. One
 * card serves both roles: an administrator also opens, orders, plans, starts and closes the run.
 */

export interface CaptureRunMember {
  /** Stable key for the row: the member's session. */
  readonly id: string
  readonly name: string
  /** The painter's presence colour as CSS, the same colour their line is drawn in on the map. */
  readonly colour: string
  /** Pixels of their line they have drafted, and the line's length; length 0 before a plan. */
  readonly drafted: number
  readonly length: number
  /** This tab's painter. */
  readonly me: boolean
}

export interface CaptureProposal {
  readonly id: string
  /** Where the wall goes, e.g. "Along the bottom edge". */
  readonly label: string
  /** Territory the plan would gain, and the pixels it paints. */
  readonly gained: number
  readonly pixels: number
  /** The plan currently published to the group. */
  readonly published: boolean
}

export type CapturePhase =
  /** No run on any connected server; only an administrator sees the card, to open one. */
  | 'none'
  /** Open: painters join, the administrator orders them and publishes a plan. */
  | 'gathering'
  /** Started: every client counts down to its slot. */
  | 'countdown'
  /** Every slot has passed. */
  | 'done'

export interface CaptureRunModel {
  readonly phase: CapturePhase
  readonly admin: boolean
  /** The group size the run was opened with, or the size an administrator is about to open. */
  readonly painters: number
  readonly maxPainters: number
  /** In paint order. */
  readonly members: readonly CaptureRunMember[]
  readonly joined: boolean
  /** False once the run is full or started. */
  readonly canJoin: boolean
  /** Administrator only: plans to choose from, best first; empty until proposed. */
  readonly proposals: readonly CaptureProposal[]
  /** Administrator only: proposals are being computed from the live map. */
  readonly proposing: boolean
  /** Administrator only: Go is allowed (a plan is published and every line has a painter). */
  readonly canStart: boolean
  /** Milliseconds until this tab's painter paints, while counting down and they are a member. */
  readonly mySlotInMs: number | null
  /** This painter's place in the order, from 1, while they are a member. */
  readonly myTurn: number | null
  /** Milliseconds until the first painter paints, while counting down. */
  readonly startsInMs: number | null
  /** Whether Caelestis presses Paint at this painter's slot (Dangerous settings switch). */
  readonly autoPaint: boolean
  /** A short status or error, e.g. "Your team holds no arena edge to build from." */
  readonly message?: string
}

export type CaptureRunIntent =
  | { readonly type: 'set-painters'; readonly painters: number }
  | { readonly type: 'open' }
  | { readonly type: 'join' }
  | { readonly type: 'leave' }
  /** Move a member one place earlier (-1) or later (1) in the order. */
  | { readonly type: 'move'; readonly id: string; readonly by: -1 | 1 }
  | { readonly type: 'propose' }
  | { readonly type: 'publish'; readonly id: string }
  /** Fly the map to this painter's line. */
  | { readonly type: 'show-line' }
  | { readonly type: 'go' }
  | { readonly type: 'close' }
  /** Open Dangerous settings at the auto-paint switch. */
  | { readonly type: 'auto-paint-settings' }
