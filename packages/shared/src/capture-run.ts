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
 * Lobbies live in a presence room, any number per event team. Any painter who can write opens one
 * and joins it as its host; painters join from the team's lobby list. The host, or an administrator
 * in the lobby, locks in a wall, and the wall is cut into one leg per painting member, so every member, server and client, derives the same legs
 * from the lobby with `captureLines`. Painters go in pairs from the wall's two anchors: painter `i`
 * (from 0) paints leg `i` at `startsAt + floor(i / 2) * staggerMs`, on the server's clock, which
 * each client estimates with `clock` round trips. The lobby's coordinator always paints in the last
 * step while a member, so the closing leg, and the captured area, is theirs: the painter who opened
 * it, until whoever runs the lobby hands the closing leg to another member. The host and the closer
 * start as the same painter but are separate roles: handing over one leaves the other.
 *
 * The `distribution` decides how many legs the wall is cut into: one per painting member, or the
 * fewest that fit, with the painting members past them standing by as reserves.
 *
 * The last `guards` members, at most half the lobby, are anchor guards, outside the stagger: each
 * paints a zone that thickens the wall where one end meets the team's territory, at `startsAt`
 * with the first painter, then watches that anchor and repaints it if an enemy cuts it. Guards
 * alternate between anchors A and B, each with their own zone; a lone guard holds both.
 */

/** The most painters a lobby plans its wall for, and the most anchor guards it sets. */
export const MAX_CAPTURE_PAINTERS = 16
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
/** Default time from the start of the countdown to the first painter's slot. */
export const CAPTURE_LEAD_MS = 10_000
/** The shortest and longest lead a host can set; a lead is a whole number of seconds. */
export const MIN_CAPTURE_LEAD_MS = 3_000
export const MAX_CAPTURE_LEAD_MS = 30_000
export const CAPTURE_LEAD_STEP_MS = 1_000

/**
 * How a locked wall is shared: `even` cuts one leg per painting member; `reserve` cuts the fewest
 * legs that fit a painter's charges, for the first painting members, and the rest stand by.
 */
export type CaptureDistribution = 'even' | 'reserve'

export interface CaptureMember {
  readonly sessionId: string
  readonly painter: PainterIdentity
  /** How many of their leg's pixels they have drafted. */
  readonly drafted: number
  /**
   * Their place in the order members joined, from 0 for the opener; the longest-standing member
   * takes over as host. Missing on a member stored by backend 1.6.0, who counts as 0.
   */
  readonly joined?: number
  /**
   * Set when they left after the closing leg was painted. They keep their place, so everyone
   * else keeps the leg, slot and guard role the countdown started with.
   */
  readonly left?: true
  /**
   * The browser the place belongs to, as the server hashes its client id: only a session from
   * that browser takes the place over. The server keeps it and strips it before sending lobbies.
   */
  readonly client?: string
}

export interface CaptureRun {
  readonly id: string
  /** The event team the lobby is for: its opener's. Only that team's sessions hear of it. */
  readonly team: TerritoryTeam
  /**
   * The Wplace user who opened the lobby; the lobby list names it after them. Missing on a lobby
   * opened before the server recorded it, which the list names after its closer instead.
   */
  readonly opener?: number
  /**
   * The Wplace user who closes the wall: while they are a member they paint the closing leg, so the
   * captured area is attributed to them. The opener, until the host gives the leg to someone else.
   */
  readonly coordinator: number | null
  /**
   * The session of the member who runs the lobby: its opener, then whoever has been in it longest
   * once they leave. Missing on a lobby stored by backend 1.6.0; `captureHostIndex` reads that one
   * as hosted by its opener, then its first member.
   */
  readonly host?: string
  /** The painters live planning sizes walls for, at `MAX_CAPTURE_LINE_PIXELS` each. */
  readonly painters: number
  /** Anchor guards live planning gives zones to, and the most members who guard. */
  readonly guards: number
  readonly distribution: CaptureDistribution
  /** In paint order, guards last. */
  readonly members: readonly CaptureMember[]
  /**
   * The locked-in wall: its pixels to paint from anchor A to anchor B, as flat world coordinates
   * `[x0, y0, x1, y1, …]`. Null while the host is still choosing.
   */
  readonly wall: readonly number[] | null
  /** The locked-in wall's guard zones, one per `guards`, flat like `wall`. */
  readonly guardZones: readonly (readonly number[])[]
  readonly startsAt: number | null
  readonly staggerMs: number
  /**
   * Time from the start of the countdown to the first painter's slot. Missing on a lobby stored
   * before hosts could set it; `captureLead` reads it with the default.
   */
  readonly leadMs?: number
  /**
   * Counts every re-cut of the members' legs. A draft report names the lobby and cut it measured,
   * so one sent before a re-cut, or from a lobby the painter has since left, never counts.
   */
  readonly cut: number
}

/** A lobby's settings, as its host edits them until the countdown starts. */
export interface CaptureSettings {
  readonly painters: number
  /** The guards chosen; a lobby only uses as many as half its members. */
  readonly guards: number
  readonly staggerMs: number
  readonly leadMs: number
  readonly distribution: CaptureDistribution
}

/** The settings a painter's first lobby opens with. */
export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  painters: 3,
  guards: 0,
  staggerMs: CAPTURE_STAGGER_MS,
  leadMs: CAPTURE_LEAD_MS,
  distribution: 'even',
}

/** A whole number of `step`s from `min` to `max`, or `fallback` when `value` is not a number. */
const stepped = (value: unknown, min: number, max: number, step: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value / step) * step))
    : fallback

/** Lobby settings read back from storage, each within its bounds; the default fills the rest. */
export const normaliseCaptureSettings = (stored: unknown): CaptureSettings => {
  const value = isRecord(stored) ? stored : {}
  const fallback = DEFAULT_CAPTURE_SETTINGS
  return {
    painters: stepped(value.painters, 1, MAX_CAPTURE_PAINTERS, 1, fallback.painters),
    guards: stepped(value.guards, 0, MAX_CAPTURE_PAINTERS, 1, fallback.guards),
    staggerMs: stepped(
      value.staggerMs,
      MIN_CAPTURE_STAGGER_MS,
      MAX_CAPTURE_STAGGER_MS,
      CAPTURE_STAGGER_STEP_MS,
      fallback.staggerMs,
    ),
    leadMs: stepped(
      value.leadMs,
      MIN_CAPTURE_LEAD_MS,
      MAX_CAPTURE_LEAD_MS,
      CAPTURE_LEAD_STEP_MS,
      fallback.leadMs,
    ),
    distribution: value.distribution === 'reserve' ? 'reserve' : 'even',
  }
}

/** A lobby's time from the start of the countdown to the first painter's slot. */
export const captureLead = (run: CaptureRun): number => run.leadMs ?? CAPTURE_LEAD_MS

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
      readonly staggerMs: number
      readonly guards?: number
      readonly leadMs?: number
      readonly distribution?: CaptureDistribution
    }
  | { readonly type: 'capture-join'; readonly run: string }
  | { readonly type: 'capture-leave' }
  /** Only the settings the host changed, so edits to different settings never undo each other. */
  | {
      readonly type: 'capture-settings'
      readonly painters?: number
      readonly guards?: number
      readonly staggerMs?: number
      readonly leadMs?: number
      readonly distribution?: CaptureDistribution
    }
  /** Move a member one place earlier (-1) or later (1); see `moveCaptureMember`. */
  | { readonly type: 'capture-move'; readonly member: string; readonly by: -1 | 1 }
  /** Give a member the closing leg: they become the coordinator. */
  | { readonly type: 'capture-closer'; readonly member: string }
  /** Lock in a planned wall, from anchor A to anchor B, and its guard zones. */
  | {
      readonly type: 'capture-lock'
      readonly wall: readonly number[]
      readonly guardZones: readonly (readonly number[])[]
    }
  | { readonly type: 'capture-unlock' }
  | {
      readonly type: 'capture-drafted'
      readonly run: string
      readonly drafted: number
      readonly cut: number
    }
  | { readonly type: 'capture-go' }
  | { readonly type: 'capture-close' }
  | { readonly type: 'clock'; readonly sent: number }
  | CaptureTimingReport

/** How a member's slot went in lobby `run`, sent once for the server's log. */
export interface CaptureTimingReport extends CaptureSlotTiming {
  readonly type: 'capture-timing'
  readonly run: string
}

/**
 * What became of the paint request at a slot: Wplace's HTTP status, or `missed` (the tab woke too
 * late to click), `nothing-drafted` (the leg had nothing open to submit, so Paint was not pressed),
 * `unsubmitted` (Paint was not ready), `no-request` (Wplace sent none in time),
 * `no-response` (it never answered in time) or `failed` (the request errored).
 */
export type CapturePaintStatus =
  | number
  | 'missed'
  | 'nothing-drafted'
  | 'unsubmitted'
  | 'no-request'
  | 'no-response'
  | 'failed'

/** The longest duration a slot report carries; clients clamp longer ones to it. */
export const MAX_CAPTURE_TIMING_MS = 60_000

/**
 * One member's slot, timed by their client in whole milliseconds. The click lands `firedLateMs`
 * after `slotAt`; Wplace sends its paint request `clickToSendMs` after the click and answers it
 * `sendToResponseMs` later, both null when that never happened. The clock fields are the sync the
 * slot was scheduled with, and `wplaceRttMs` the tab's recent round trip to Wplace.
 */
export interface CaptureSlotTiming {
  /** The slot, on the server's clock. */
  readonly slotAt: number
  readonly firedLateMs: number
  readonly clickToSendMs: number | null
  readonly sendToResponseMs: number | null
  readonly status: CapturePaintStatus
  readonly wplaceRttMs: number | null
  /** Server time minus the tab's clock. */
  readonly clockOffsetMs: number
  readonly clockRttMs: number
}

export type CaptureServerEvent =
  /** Every lobby of the session's team, whenever one of them changes. */
  | { readonly type: 'capture-runs'; readonly runs: readonly CaptureRun[] }
  /** Answers a client's `clock`: `at` is the server's time when it answered. */
  | { readonly type: 'clock'; readonly sent: number; readonly at: number }

/** The most anchor guards a lobby of this size sets: half of it, rounded down. */
export const maxCaptureGuards = (run: CaptureRun): number =>
  Math.min(MAX_CAPTURE_PAINTERS, Math.floor(run.members.length / 2))

/** Members who guard: up to `guards`, and never more than half the lobby. */
export const captureGuardCount = (run: CaptureRun): number =>
  Math.min(run.guards, maxCaptureGuards(run))

/** Members who paint the wall or stand by as reserves: everyone but the guards. */
export const capturePainterCount = (run: CaptureRun): number =>
  run.members.length - captureGuardCount(run)

/**
 * Legs the wall is cut into, one for each of the first painting members: all of them, or with
 * `reserve` and a wall locked in, the fewest that fit a painter's charges.
 */
export const captureLegCount = (run: CaptureRun): number => {
  const painting = capturePainterCount(run)
  if (run.distribution === 'even' || run.wall === null) return painting
  const fewest = Math.ceil(run.wall.length / 2 / MAX_CAPTURE_LINE_PIXELS)
  return Math.min(painting, Math.max(1, fewest))
}

/** Whether member `index` is an anchor guard rather than a wall painter. */
export const isCaptureGuard = (run: CaptureRun, index: number): boolean =>
  index >= capturePainterCount(run)

/** Whether member `index` is a reserve: a painting member past the legs, with nothing to paint. */
export const isCaptureReserve = (run: CaptureRun, index: number): boolean =>
  index >= captureLegCount(run) && !isCaptureGuard(run, index)

/** The countdown step member `index` paints at: pairs share one, guards paint with the first. */
export const captureStep = (run: CaptureRun, index: number): number =>
  isCaptureGuard(run, index) ? 0 : Math.floor(index / 2)

/** Countdown steps the wall's legs take, the first pair's included. */
export const captureSteps = (run: CaptureRun): number => Math.ceil(captureLegCount(run) / 2)

/**
 * When member `index` paints, on the server's clock; null until the countdown starts, and for a
 * reserve.
 */
export const captureSlot = (run: CaptureRun, index: number): number | null =>
  run.startsAt === null || isCaptureReserve(run, index)
    ? null
    : run.startsAt + captureStep(run, index) * run.staggerMs

/** When the closing leg is painted, on the server's clock; null until the countdown starts. */
export const captureEndsAt = (run: CaptureRun): number | null =>
  captureSlot(run, Math.max(0, captureLegCount(run) - 1))

/** How many more painters a wall of `pixels` needs so no leg exceeds a painter's charges. */
export const captureShortfall = (pixels: number, painters: number): number =>
  Math.max(0, Math.ceil(pixels / MAX_CAPTURE_LINE_PIXELS) - painters)

const derivedLines = new WeakMap<CaptureRun, readonly (readonly number[])[]>()

/**
 * Each member's line, in member order: the locked wall cut into `captureLegCount` legs with
 * `pairLines`, an empty line for each reserve, then each guard's zone. Empty until a wall is
 * locked in. A wall too long for the painters leaves its middle uncut; `captureShortfall` says how
 * many more it needs.
 */
export const captureLines = (run: CaptureRun): readonly (readonly number[])[] => {
  const known = derivedLines.get(run)
  if (known !== undefined) return known
  const { wall } = run
  let lines: (readonly number[])[] = []
  if (wall !== null) {
    const pixels = Array.from({ length: wall.length / 2 }, (_, at) => at)
    const legCount = captureLegCount(run)
    const legs = pairLines(pixels, legCount, MAX_CAPTURE_LINE_PIXELS).map((leg) =>
      leg.flatMap((at) => [wall[2 * at] as number, wall[2 * at + 1] as number]),
    )
    const reserves = Array.from({ length: capturePainterCount(run) - legCount }, () => [])
    const zones = Array.from(
      { length: captureGuardCount(run) },
      (_, guard) => run.guardZones[guard] ?? [],
    )
    lines = [...legs, ...reserves, ...zones]
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

/** Whether every member with a leg has drafted all of it; guards and reserves don't count. */
export const capturePaintersDrafted = (run: CaptureRun): boolean => {
  const lines = captureLines(run)
  return run.members
    .slice(0, captureLegCount(run))
    .every((member, index) => member.drafted >= (lines[index]?.length ?? 0) / 2)
}

/**
 * Whether the countdown may start: a wall is locked in, its legs fit the painting members, and
 * everyone with a leg has drafted it.
 */
export const captureReady = (run: CaptureRun): boolean =>
  run.startsAt === null &&
  run.wall !== null &&
  captureShortfall(run.wall.length / 2, capturePainterCount(run)) === 0 &&
  capturePaintersDrafted(run)

/**
 * The member index of the lobby's host, or -1 when nobody eligible is in it: the recorded host while
 * they are in it, else the member who joined first, ties in member order. A lobby stored by backend 1.6.0 records no host, so its
 * opener hosts while in it. `eligible` narrows who may host, as to the connected sessions.
 */
export const captureHostIndex = (
  run: CaptureRun,
  eligible: (member: CaptureMember) => boolean = () => true,
): number => {
  const { members } = run
  const present = members.flatMap((member, index) =>
    member.left !== true && eligible(member) ? [index] : [],
  )
  const recorded = present.find((index) =>
    run.host === undefined
      ? members[index]?.painter.wplaceUserId === run.opener
      : members[index]?.sessionId === run.host,
  )
  if (recorded !== undefined) return recorded
  const joined = (index: number) => members[index]?.joined ?? 0
  return present.reduce(
    (first, index) => (first < 0 || joined(index) < joined(first) ? index : first),
    -1,
  )
}

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
  isSafeInteger(value.drafted) &&
  (value.joined === undefined || isSafeInteger(value.joined)) &&
  (value.left === undefined || value.left === true)

/** A lobby from a server, which is untrusted input. Null when malformed. */
export const decodeCaptureRun = (value: unknown): CaptureRun | null => {
  if (!isRecord(value)) return null
  const {
    id,
    team,
    opener,
    coordinator,
    host,
    painters,
    guards,
    distribution,
    members,
    wall,
    guardZones,
    startsAt,
    staggerMs,
    leadMs,
    cut,
  } = value
  if (
    typeof id !== 'string' ||
    !(team === 0 || team === 1 || team === 2 || team === 3) ||
    !(opener === undefined || isSafeInteger(opener)) ||
    !(coordinator === null || isSafeInteger(coordinator)) ||
    !(host === undefined || (typeof host === 'string' && host.length <= 64)) ||
    !isSafeInteger(painters) ||
    !isSafeInteger(guards) ||
    !(distribution === 'even' || distribution === 'reserve') ||
    !Array.isArray(members) ||
    members.length > MAX_CAPTURE_MEMBERS ||
    !members.every(isMember) ||
    !(wall === null || isLine(wall, MAX_CAPTURE_WALL_PIXELS)) ||
    !Array.isArray(guardZones) ||
    guardZones.length > MAX_CAPTURE_PAINTERS ||
    !guardZones.every((zone) => isLine(zone, MAX_CAPTURE_LINE_PIXELS)) ||
    !(startsAt === null || isSafeInteger(startsAt)) ||
    !isSafeInteger(staggerMs) ||
    !(leadMs === undefined || isSafeInteger(leadMs)) ||
    !isSafeInteger(cut)
  )
    return null
  return {
    id,
    team,
    ...(opener === undefined ? {} : { opener }),
    coordinator,
    ...(host === undefined ? {} : { host }),
    painters,
    guards,
    distribution,
    members,
    wall,
    guardZones,
    startsAt,
    staggerMs,
    ...(leadMs === undefined ? {} : { leadMs }),
    cut,
  }
}
