import { isRecord, isSafeInteger } from './guards.js'
import { MAX_PRESENCE_SUBSCRIBERS } from './presence.js'
import type { PainterIdentity } from './telemetry.js'
import { pairLines, type TerritoryTeam } from './territory.js'
import { isWorkIdentity } from './work.js'

/**
 * A capture run, which painters see as a lobby: a group of painters who place one planned wall in
 * turn, a few hundred milliseconds apart, so each leg lands next to the one before and the last
 * closes the loop.
 *
 * Lobbies live in a presence room, any number per event team. An event runner opens one and joins
 * it; painters join from the team's lobby list. Runners in the lobby lock in a wall, and the wall is
 * cut into one leg per painting member, so every member, server and client, derives the same legs
 * from the lobby with `captureLines`. Painters go in pairs from the wall's two anchors: painter `i`
 * (from 0) paints leg `i` at `startsAt + floor(i / 2) * staggerMs`, on the server's clock, which
 * each client estimates with `clock` round trips. The runner who opened the lobby always paints in
 * the last step while a member, so the closing leg, and the captured area, is theirs.
 *
 * The last `guards` members are anchor guards, outside the stagger: each paints a strip that
 * thickens the wall where one end meets the team's territory, at `startsAt` with the first painter,
 * then watches that anchor and repaints it if an enemy cuts it. A lobby always keeps one painter.
 */

/** The most painters a lobby plans its wall for: `painters` is at most this. */
export const MAX_CAPTURE_PAINTERS = 16
/** One guard for each end of the wall. */
export const MAX_CAPTURE_GUARDS = 2
/** The widest and tallest box a line's pixels may span, and its largest area, in pixels. */
export const MAX_CAPTURE_LINE_SPAN = 1_024
export const MAX_CAPTURE_LINE_AREA = 1 << 18
/** Pixels in one leg: a painter's full charges in the territory event. */
export const MAX_CAPTURE_LINE_PIXELS = 60
/** Pixels in a locked wall: the most a full plan paints. */
export const MAX_CAPTURE_WALL_PIXELS = MAX_CAPTURE_PAINTERS * MAX_CAPTURE_LINE_PIXELS
/** Members in one lobby: everyone a room can hold. */
export const MAX_CAPTURE_MEMBERS = MAX_PRESENCE_SUBSCRIBERS
/** Default time between consecutive steps, long enough for the previous paint to land. */
export const CAPTURE_STAGGER_MS = 500
/**
 * The shortest stagger. It covers network jitter between painters, because Wplace's server validates
 * each paint itself; 100 ms is the floor because painters clicking by hand can't time it tighter.
 */
export const MIN_CAPTURE_STAGGER_MS = 100
export const MAX_CAPTURE_STAGGER_MS = 2_000
/** A run's stagger is a whole number of these. */
export const CAPTURE_STAGGER_STEP_MS = 50
/** Time from the start of the countdown to the first painter's slot: their ten-second countdown. */
export const CAPTURE_LEAD_MS = 10_000

export interface CaptureMember {
  readonly sessionId: string
  readonly painter: PainterIdentity
  /** How many of their leg's pixels they have drafted. */
  readonly drafted: number
}

export interface CaptureRun {
  readonly id: string
  /** The event team the lobby is for: its opener's. Only that team's sessions hear of it. */
  readonly team: TerritoryTeam
  /**
   * The Wplace user who opened the lobby. While they are a member they paint the closing leg, so
   * the captured area is attributed to them.
   */
  readonly coordinator: number | null
  /** The painters live planning sizes walls for, at `MAX_CAPTURE_LINE_PIXELS` each. */
  readonly painters: number
  /** Anchor guards live planning gives zones to, and the most members who guard. */
  readonly guards: number
  /** In paint order, guards last. */
  readonly members: readonly CaptureMember[]
  /**
   * The locked-in wall: its pixels to paint from anchor A to anchor B, as flat world coordinates
   * `[x0, y0, x1, y1, …]`. Null while runners are still choosing.
   */
  readonly wall: readonly number[] | null
  /** The locked-in wall's guard zones, one per `guards`, flat like `wall`. */
  readonly guardZones: readonly (readonly number[])[]
  readonly startsAt: number | null
  readonly staggerMs: number
}

/** A lobby's settings, as runners edit them until the countdown starts. */
export interface CaptureSettings {
  readonly painters: number
  readonly guards: number
  readonly staggerMs: number
}

/**
 * Capture events act on the lobbies of the team the session last reported in `presence-update`.
 * `capture-new` opens a lobby and joins it, leaving any other; `capture-join` names the lobby the
 * painter chose, so one that has closed or started joins nothing. The rest act on the lobby the
 * session is a member of.
 */
export type CaptureClientEvent =
  | {
      readonly type: 'capture-new'
      readonly painters: number
      readonly guards: number
      readonly staggerMs: number
    }
  | { readonly type: 'capture-join'; readonly run: string }
  | { readonly type: 'capture-leave' }
  | {
      readonly type: 'capture-settings'
      readonly painters: number
      readonly guards: number
      readonly staggerMs: number
    }
  | { readonly type: 'capture-order'; readonly order: readonly string[] }
  /** Lock in a planned wall, from anchor A to anchor B, and its guard zones. */
  | {
      readonly type: 'capture-lock'
      readonly wall: readonly number[]
      readonly guardZones: readonly (readonly number[])[]
    }
  | { readonly type: 'capture-unlock' }
  | { readonly type: 'capture-drafted'; readonly drafted: number }
  | { readonly type: 'capture-go' }
  | { readonly type: 'capture-close' }
  | { readonly type: 'clock'; readonly sent: number }

export type CaptureServerEvent =
  /** Every lobby of the session's team, whenever one of them changes. */
  | { readonly type: 'capture-runs'; readonly runs: readonly CaptureRun[] }
  /** Answers a client's `clock`: `at` is the server's time when it answered. */
  | { readonly type: 'clock'; readonly sent: number; readonly at: number }

/** Members who guard: up to `guards`, but never the last painter. */
export const captureGuardCount = (run: CaptureRun): number =>
  Math.min(run.guards, Math.max(0, run.members.length - 1))

/** Members who build the wall: everyone but the guards. */
export const capturePainterCount = (run: CaptureRun): number =>
  run.members.length - captureGuardCount(run)

/** Whether member `index` is an anchor guard rather than a wall painter. */
export const isCaptureGuard = (run: CaptureRun, index: number): boolean =>
  index >= capturePainterCount(run)

/** The countdown step member `index` paints at: pairs share one, guards paint with the first. */
export const captureStep = (run: CaptureRun, index: number): number =>
  isCaptureGuard(run, index) ? 0 : Math.floor(index / 2)

/** Countdown steps the wall's painters take, the first pair's included. */
export const captureSteps = (run: CaptureRun): number => Math.ceil(capturePainterCount(run) / 2)

/** When member `index` paints, on the server's clock; null until the countdown starts. */
export const captureSlot = (run: CaptureRun, index: number): number | null =>
  run.startsAt === null ? null : run.startsAt + captureStep(run, index) * run.staggerMs

/** When the closing leg is painted, on the server's clock; null until the countdown starts. */
export const captureEndsAt = (run: CaptureRun): number | null =>
  captureSlot(run, Math.max(0, capturePainterCount(run) - 1))

/** How many more painters a wall of `pixels` needs so no leg exceeds a painter's charges. */
export const captureShortfall = (pixels: number, painters: number): number =>
  Math.max(0, Math.ceil(pixels / MAX_CAPTURE_LINE_PIXELS) - painters)

const derivedLines = new WeakMap<CaptureRun, readonly (readonly number[])[]>()

/**
 * Each member's line, in member order: the locked wall cut into one leg per painter with
 * `pairLines`, then each guard's zone. Empty until a wall is locked in. A wall too long for the
 * painters leaves its middle uncut; `captureShortfall` says how many more it needs.
 */
export const captureLines = (run: CaptureRun): readonly (readonly number[])[] => {
  const known = derivedLines.get(run)
  if (known !== undefined) return known
  const { wall } = run
  let lines: (readonly number[])[] = []
  if (wall !== null) {
    const pixels = Array.from({ length: wall.length / 2 }, (_, at) => at)
    const legs = pairLines(pixels, capturePainterCount(run), MAX_CAPTURE_LINE_PIXELS).map((leg) =>
      leg.flatMap((at) => [wall[2 * at] as number, wall[2 * at + 1] as number]),
    )
    const zones = Array.from(
      { length: captureGuardCount(run) },
      (_, guard) => run.guardZones[guard] ?? [],
    )
    lines = [...legs, ...zones]
  }
  derivedLines.set(run, lines)
  return lines
}

/**
 * The member order after moving member `id` one place earlier (-1) or later (1), as session ids.
 * The coordinator keeps the last painter's place, so they don't move and a move steps over them.
 * Null when the move has nowhere to go.
 */
export const moveCaptureMember = (run: CaptureRun, id: string, by: -1 | 1): string[] | null => {
  const pinned = captureCoordinatorIndex(run)
  const order = run.members.filter((_, index) => index !== pinned).map(({ sessionId }) => sessionId)
  const from = order.indexOf(id)
  const to = from + by
  if (from < 0 || to < 0 || to >= order.length) return null
  order.splice(to, 0, ...order.splice(from, 1))
  return order
}

/** Whether every wall painter has drafted their whole leg; guards don't count. */
export const capturePaintersDrafted = (run: CaptureRun): boolean => {
  const lines = captureLines(run)
  return run.members
    .slice(0, capturePainterCount(run))
    .every((member, index) => member.drafted >= (lines[index]?.length ?? 0) / 2)
}

/**
 * Whether the countdown may start: a wall is locked in, its legs fit the painters, and every
 * painter has drafted theirs.
 */
export const captureReady = (run: CaptureRun): boolean =>
  run.startsAt === null &&
  run.wall !== null &&
  captureShortfall(run.wall.length / 2, capturePainterCount(run)) === 0 &&
  capturePaintersDrafted(run)

/** The member index of the lobby's coordinator, or -1 when they are not a member. */
export const captureCoordinatorIndex = (run: CaptureRun): number =>
  run.coordinator === null
    ? -1
    : run.members.findIndex(({ painter }) => painter.wplaceUserId === run.coordinator)

/**
 * Whether a line's pixels fit a box small enough to draw: a leg is at most one painter's charges,
 * but a wall or a lone guard's zone spans both ends, so the bound is on the box's sides and area
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

const isLine = (value: unknown, pixels: number): value is readonly number[] =>
  Array.isArray(value) &&
  value.length % 2 === 0 &&
  value.length <= pixels * 2 &&
  value.every((n) => isSafeInteger(n) && n >= 0) &&
  isCompactCaptureLine(value)

const isMember = (value: unknown): value is CaptureMember =>
  isRecord(value) &&
  typeof value.sessionId === 'string' &&
  value.sessionId.length <= 64 &&
  isWorkIdentity(value.painter) &&
  isSafeInteger(value.drafted)

/** A lobby from a server, which is untrusted input. Null when malformed. */
export const decodeCaptureRun = (value: unknown): CaptureRun | null => {
  if (!isRecord(value)) return null
  const {
    id,
    team,
    coordinator,
    painters,
    guards,
    members,
    wall,
    guardZones,
    startsAt,
    staggerMs,
  } = value
  if (
    typeof id !== 'string' ||
    !(team === 0 || team === 1 || team === 2 || team === 3) ||
    !(coordinator === null || isSafeInteger(coordinator)) ||
    !isSafeInteger(painters) ||
    !isSafeInteger(guards) ||
    !Array.isArray(members) ||
    members.length > MAX_CAPTURE_MEMBERS ||
    !members.every(isMember) ||
    !(wall === null || isLine(wall, MAX_CAPTURE_WALL_PIXELS)) ||
    !Array.isArray(guardZones) ||
    guardZones.length > MAX_CAPTURE_GUARDS ||
    !guardZones.every((zone) => isLine(zone, MAX_CAPTURE_LINE_PIXELS)) ||
    !(startsAt === null || isSafeInteger(startsAt)) ||
    !isSafeInteger(staggerMs)
  )
    return null
  return {
    id,
    team,
    coordinator,
    painters,
    guards,
    members,
    wall,
    guardZones,
    startsAt,
    staggerMs,
  }
}
