import { isRecord, isSafeInteger } from './guards.js'
import type { PainterIdentity } from './telemetry.js'
import type { TerritoryTeam } from './territory.js'
import { isWorkIdentity } from './work.js'

/**
 * A capture run: a group of painters who place one planned wall in turn, a few hundred
 * milliseconds apart, so each line lands next to the one before and the last closes the loop.
 *
 * It lives in a presence room. An administrator opens it with a group size, painters join, the
 * administrator publishes the plan and starts it; the server stamps the start time. Painters go in
 * pairs from the wall's two anchors: painter `i` (from 0) paints line `i` at
 * `startsAt + floor(i / 2) * staggerMs`, on the server's clock, which each client estimates with
 * `clock` round trips. An administrator who joins their own run always paints in the last step,
 * so the closing line, and the captured area, is theirs.
 *
 * The last `guards` members are anchor guards, outside the stagger: each paints a strip that
 * thickens the wall where one end meets the team's territory, at `startsAt` with the first painter,
 * then watches that anchor and repaints it if an enemy cuts it.
 */

export const MAX_CAPTURE_PAINTERS = 16
/** One guard for each end of the wall. */
export const MAX_CAPTURE_GUARDS = 2
/** The widest and tallest box a line's pixels may span, and its largest area, in pixels. */
export const MAX_CAPTURE_LINE_SPAN = 1_024
export const MAX_CAPTURE_LINE_AREA = 1 << 18
/** Pixels in one line: a painter's full charges in the territory event. */
export const MAX_CAPTURE_LINE_PIXELS = 60
/** Default time between consecutive steps, long enough for the previous paint to land. */
export const CAPTURE_STAGGER_MS = 500
/** The shortest stagger: Wplace's event canvas pushes updates every 200 ms, so no step lands sooner. */
export const MIN_CAPTURE_STAGGER_MS = 200
export const MAX_CAPTURE_STAGGER_MS = 2_000
/** A run's stagger is a whole number of these. */
export const CAPTURE_STAGGER_STEP_MS = 50
/** Time from Go to the first painter's slot: the first painter's ten-second countdown. */
export const CAPTURE_LEAD_MS = 10_000

export interface CaptureMember {
  readonly sessionId: string
  readonly painter: PainterIdentity
  /** How many of their line's pixels they have drafted. */
  readonly drafted: number
}

export interface CaptureRun {
  readonly id: string
  /**
   * The event team the run is for: the opening administrator's. A room keeps one run per team and
   * shares it with that team's sessions only, so every member draws and paints in its colours.
   */
  readonly team: TerritoryTeam
  /**
   * The Wplace user who opened the run. While they are a member they paint the last painter's
   * line, so the captured area is attributed to them. Null on a run opened before it was recorded.
   */
  readonly coordinator: number | null
  /** Painters who build the wall, in turn. */
  readonly painters: number
  /** Anchor guards, after the painters in `members` and `lines`. */
  readonly guards: number
  /** In paint order, guards last; member `i` paints `lines[i]`. */
  readonly members: readonly CaptureMember[]
  /** Each line's world pixels as a flat `[x0, y0, x1, y1, …]` list, in placement order. */
  readonly lines: readonly (readonly number[])[]
  readonly startsAt: number | null
  readonly staggerMs: number
}

export type CaptureClientEvent =
  /** Capture events act on the run of the team the session last reported in `presence-update`. */
  | {
      readonly type: 'capture-open'
      readonly painters: number
      readonly guards: number
      /** Time between steps; `CAPTURE_STAGGER_MS` when omitted. */
      readonly staggerMs?: number
    }
  /** Joining names the run the painter chose, so a join that arrives after it was replaced joins nothing. */
  | { readonly type: 'capture-join'; readonly run: string }
  | { readonly type: 'capture-leave' }
  | { readonly type: 'capture-order'; readonly order: readonly string[] }
  /** The wall's lines in paint order, then one anchor strip per guard. */
  | { readonly type: 'capture-plan'; readonly lines: readonly (readonly number[])[] }
  | { readonly type: 'capture-drafted'; readonly drafted: number }
  | { readonly type: 'capture-go' }
  | { readonly type: 'capture-close' }
  | { readonly type: 'clock'; readonly sent: number }

export type CaptureServerEvent =
  | { readonly type: 'capture'; readonly run: CaptureRun | null }
  /** Answers a client's `clock`: `at` is the server's time when it answered. */
  | { readonly type: 'clock'; readonly sent: number; readonly at: number }

/** Whether member `index` is an anchor guard rather than a wall painter. */
export const isCaptureGuard = (run: CaptureRun, index: number): boolean => index >= run.painters

/** The countdown step member `index` paints at: pairs share one, guards paint with the first. */
export const captureStep = (run: CaptureRun, index: number): number =>
  isCaptureGuard(run, index) ? 0 : Math.floor(index / 2)

/** Countdown steps the wall's painters take, the first pair's included. */
export const captureSteps = (run: CaptureRun): number => Math.ceil(run.painters / 2)

/** When member `index` paints, on the server's clock; null until the run starts. */
export const captureSlot = (run: CaptureRun, index: number): number | null =>
  run.startsAt === null ? null : run.startsAt + captureStep(run, index) * run.staggerMs

/** Whether every wall painter has drafted their whole line; guards don't count. */
export const capturePaintersDrafted = (run: CaptureRun): boolean =>
  run.members
    .slice(0, run.painters)
    .every((member, index) => member.drafted >= (run.lines[index]?.length ?? 0) / 2)

/** The member index of the run's coordinator, or -1 when they have not joined. */
export const captureCoordinatorIndex = (run: CaptureRun): number =>
  run.coordinator === null
    ? -1
    : run.members.findIndex(({ painter }) => painter.wplaceUserId === run.coordinator)

/**
 * Whether a line's pixels fit a box small enough to draw: a wall line is at most one line long, but
 * a lone guard's zone covers both ends of the wall, so the bound is on the box's sides and area
 * rather than the line's length. It caps what a client allocates to draw a line from a server.
 */
export const isCompactCaptureLine = (line: readonly number[]): boolean => {
  if (line.length === 0) return true
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let at = 0; at + 1 < line.length; at += 2) {
    const x = line[at] as number
    const y = line[at + 1] as number
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  const w = maxX - minX + 1
  const h = maxY - minY + 1
  return w <= MAX_CAPTURE_LINE_SPAN && h <= MAX_CAPTURE_LINE_SPAN && w * h <= MAX_CAPTURE_LINE_AREA
}

const isLine = (value: unknown): value is readonly number[] =>
  Array.isArray(value) &&
  value.length % 2 === 0 &&
  value.length <= MAX_CAPTURE_LINE_PIXELS * 2 &&
  value.every((n) => isSafeInteger(n) && n >= 0) &&
  isCompactCaptureLine(value)

const isMember = (value: unknown): value is CaptureMember =>
  isRecord(value) &&
  typeof value.sessionId === 'string' &&
  value.sessionId.length <= 64 &&
  isWorkIdentity(value.painter) &&
  isSafeInteger(value.drafted)

/** A run from a server, which is untrusted input. Null when malformed. */
export const decodeCaptureRun = (value: unknown): CaptureRun | null => {
  if (!isRecord(value)) return null
  const { id, team, painters, guards, members, lines, startsAt, staggerMs } = value
  // An older server sends no coordinator.
  const coordinator = value.coordinator ?? null
  if (
    typeof id !== 'string' ||
    !(team === 0 || team === 1 || team === 2 || team === 3) ||
    !(coordinator === null || isSafeInteger(coordinator)) ||
    !isSafeInteger(painters) ||
    !isSafeInteger(guards) ||
    !Array.isArray(members) ||
    !members.every(isMember) ||
    !Array.isArray(lines) ||
    lines.length > MAX_CAPTURE_PAINTERS + MAX_CAPTURE_GUARDS ||
    !lines.every(isLine) ||
    !(startsAt === null || isSafeInteger(startsAt)) ||
    !isSafeInteger(staggerMs)
  )
    return null
  return { id, team, coordinator, painters, guards, members, lines, startsAt, staggerMs }
}
