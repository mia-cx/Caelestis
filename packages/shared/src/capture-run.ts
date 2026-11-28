import { isPackedBits, unpackBits } from './bitmask.js'
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
 * in the lobby, locks in a wall, and the wall is cut into one leg per painting member, so every
 * member, server and client, derives the same legs from the lobby with `captureLines`. Only Lock in
 * hands out legs: a painter who joins afterwards waits in `waiting`, without one, until the next
 * lock-in, and one who leaves before the countdown leaves their place empty. `members` holds exactly
 * the places the lock-in gave out, so a client that predates `waiting` derives the same legs.
 * Painters go in pairs from the wall's two anchors: painter `i` (from 0) paints leg `i` at `startsAt + floor(i / 2) * staggerMs`, on the server's clock, which
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
/** The longest `covered` a member reports: a bit for each pixel of the largest wall, in base64. */
export const MAX_CAPTURE_COVERAGE_LENGTH = Math.ceil(Math.ceil(MAX_CAPTURE_WALL_PIXELS / 8) / 3) * 4
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
  /** How many of their own leg's pixels they have drafted, or the team already holds. */
  readonly drafted: number
  /**
   * The wall's pixels their tab has drafted or the team already holds, as `packBits` over the
   * wall's pixels in order, so a pixel anyone drafts counts once. Missing from a tab that predates
   * it, and until they report on the current cut.
   */
  readonly covered?: string
  /**
   * Whether they pressed Ready since the last re-cut. Missing from a tab with no Ready button,
   * which Wait for Ready never waits for.
   */
  readonly ready?: boolean
  /**
   * Their place in the order members joined, from 0 for the opener; the longest-standing member
   * takes over as host. Missing on a member stored by backend 1.6.0, who counts as 0.
   */
  readonly joined?: number
  /**
   * Set when they left a place they hold: after the closing leg was painted, or after the lock-in
   * gave them a part. They keep the place, so everyone else keeps the leg, slot and guard role it
   * gave them. Before the countdown, they take it back by joining again from the same browser.
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
  /**
   * Set when Start countdown also waits for everyone who paints at a slot to press Ready; missing
   * when it doesn't.
   */
  readonly waitForReady?: true
  /**
   * In paint order, guards last: everyone while the host is still choosing, and once a wall is
   * locked in, the places the lock-in gave out, including any left empty since.
   */
  readonly members: readonly CaptureMember[]
  /**
   * Who joined after the lock-in, in the order they joined: they have no leg, role or slot until
   * the next lock-in seats them. Missing while nobody waits.
   */
  readonly waiting?: readonly CaptureMember[]
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
  /** Start countdown also waits for everyone who paints at a slot to press Ready. */
  readonly waitForReady: boolean
}

/** The settings a painter's first lobby opens with. */
export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  painters: 3,
  guards: 0,
  staggerMs: CAPTURE_STAGGER_MS,
  leadMs: CAPTURE_LEAD_MS,
  distribution: 'even',
  waitForReady: false,
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
    waitForReady: value.waitForReady === true,
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
      readonly waitForReady?: boolean
      /** Sent by a tab with a Ready button, which takes its place with Ready released. */
      readonly ready?: false
    }
  | { readonly type: 'capture-join'; readonly run: string; readonly ready?: false }
  | { readonly type: 'capture-leave' }
  /** Only the settings the host changed, so edits to different settings never undo each other. */
  | {
      readonly type: 'capture-settings'
      readonly painters?: number
      readonly guards?: number
      readonly staggerMs?: number
      readonly leadMs?: number
      readonly distribution?: CaptureDistribution
      readonly waitForReady?: boolean
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
  /** What this member has drafted on cut `cut` of lobby `run`; see `CaptureMember`. */
  | {
      readonly type: 'capture-drafted'
      readonly run: string
      readonly drafted: number
      readonly covered?: string
      readonly cut: number
    }
  /**
   * Press or release Ready on cut `cut` of lobby `run`. A tab with a Ready button sends
   * `ready: false` once for each place it holds, so the lobby knows it can wait for that tab.
   */
  | {
      readonly type: 'capture-ready'
      readonly run: string
      readonly cut: number
      readonly ready: boolean
    }
  | { readonly type: 'capture-go' }
  | { readonly type: 'capture-close' }
  | { readonly type: 'clock'; readonly sent: number }
  | CaptureTimingReport
  | LatencyReport

/** How a member's slot went in lobby `run`, sent once for the server's log. */
export interface CaptureTimingReport extends CaptureSlotTiming {
  readonly type: 'capture-timing'
  readonly run: string
}

/**
 * A tab's latency to Wplace, sent now and then for the server's log: the median of its recent
 * round trips over `rttSamples` of them, and each paint request its Paint clicks sent since the
 * last report.
 */
export interface LatencyReport {
  readonly type: 'latency-report'
  readonly wplaceRttMs: number | null
  readonly rttSamples: number
  readonly paints: readonly PaintLatency[]
}

/** A Paint click's request: sent `clickToSendMs` after the click, answered `sendToResponseMs` later. */
export interface PaintLatency {
  readonly clickToSendMs: number
  readonly sendToResponseMs: number | null
  readonly status: PaintRequestStatus
}

/** The most paints one latency report carries; a tab keeps its newest. */
export const MAX_LATENCY_PAINTS = 20
/** The most round trips a latency report's median may be taken over. */
export const MAX_LATENCY_RTT_SAMPLES = 64
/** The shortest gap between a session's latency reports; the server ignores one sooner. */
export const LATENCY_REPORT_GAP_MS = 60_000

/**
 * What became of a paint request Wplace sent: its HTTP status, or `no-response` (it never
 * answered in time) or `failed` (the request errored).
 */
export type PaintRequestStatus = number | 'no-response' | 'failed'

/**
 * What became of the paint request at a slot: a `PaintRequestStatus`, or `missed` (the tab woke
 * too late to click), `nothing-drafted` (the leg had nothing open to submit, so Paint was not
 * pressed), `unsubmitted` (Paint was not ready) or `no-request` (Wplace sent none in time).
 */
export type CapturePaintStatus =
  | PaintRequestStatus
  | 'missed'
  | 'nothing-drafted'
  | 'unsubmitted'
  | 'no-request'

/** The longest duration a slot or latency report carries; clients clamp longer ones to it. */
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

/** Everyone in the lobby: its places in paint order, then those waiting for the next lock-in. */
export const captureEveryone = (run: CaptureRun): readonly CaptureMember[] =>
  run.waiting === undefined ? run.members : [...run.members, ...run.waiting]

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

const derivedLegs = new WeakMap<CaptureRun, readonly (readonly number[])[]>()

/** Each leg as the indices of its pixels in the wall, cut with `pairLines`; see `captureLines`. */
const captureLegs = (run: CaptureRun): readonly (readonly number[])[] => {
  const known = derivedLegs.get(run)
  if (known !== undefined) return known
  const pixels = Array.from({ length: (run.wall?.length ?? 0) / 2 }, (_, at) => at)
  const legs =
    run.wall === null ? [] : pairLines(pixels, captureLegCount(run), MAX_CAPTURE_LINE_PIXELS)
  derivedLegs.set(run, legs)
  return legs
}

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
    const legs = captureLegs(run).map((leg) =>
      leg.flatMap((at) => [wall[2 * at] as number, wall[2 * at + 1] as number]),
    )
    const reserves = Array.from({ length: capturePainterCount(run) - legs.length }, () => [])
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
 * The member order after member `id` trades places with the next painter earlier (-1) or later (1),
 * as session ids. The coordinator keeps the last painter's place and a place left empty keeps its
 * own, so a move steps over both. Null when the move has nowhere to go, or `id` left their place.
 */
export const moveCaptureMember = (run: CaptureRun, id: string, by: -1 | 1): string[] | null => {
  const pinned = captureCoordinatorIndex(run)
  const rest = run.members.filter((_, index) => index !== pinned)
  const order = rest.map(({ sessionId }) => sessionId)
  const from = order.indexOf(id)
  if (from < 0 || rest[from]?.left === true) return null
  // A place left empty has nobody to trade with: the move passes it, to the next painter still in one.
  let to = from + by
  while (rest[to]?.left === true) to += by
  const neighbour = order[to]
  if (neighbour === undefined) return null
  order[to] = id
  order[from] = neighbour
  return order
}

/**
 * Whether member `index` presses Paint at a slot: they still hold a place whose leg or guard zone
 * has pixels. Only their drafts reach the wall, so only theirs count toward it.
 */
export const capturePaints = (run: CaptureRun, index: number): boolean =>
  run.members[index]?.left !== true && (captureLines(run)[index]?.length ?? 0) > 0

const derivedCoverage = new WeakMap<CaptureRun, Uint8Array>()

/**
 * Which of the wall's pixels someone who paints at a slot has drafted, or the team already holds:
 * one byte per pixel, in wall order. A member's `covered` counts pixel by pixel, so a pixel drafted
 * twice counts once. A tab that predates `covered` only reports a count of its own leg, which can't
 * say which pixels it means, so that leg counts once the count covers all of it.
 */
export const captureCoverage = (run: CaptureRun): Uint8Array => {
  const known = derivedCoverage.get(run)
  if (known !== undefined) return known
  const pixels = (run.wall?.length ?? 0) / 2
  const coverage = new Uint8Array(pixels)
  const legs = captureLegs(run)
  run.members.forEach((member, index) => {
    if (!capturePaints(run, index)) return
    const reported = member.covered === undefined ? null : unpackBits(member.covered, pixels)
    reported?.forEach((bit, at) => {
      if (bit !== 0) coverage[at] = 1
    })
    const leg = legs[index]
    if (leg !== undefined && member.drafted >= leg.length) for (const at of leg) coverage[at] = 1
  })
  derivedCoverage.set(run, coverage)
  return coverage
}

/**
 * How many pixels of each member's line are drafted, in member order: of a leg, by anyone; of a
 * guard zone, which only its guard paints, by its guard as they report it.
 */
export const captureLinesDrafted = (run: CaptureRun): readonly number[] => {
  const coverage = captureCoverage(run)
  const legs = captureLegs(run)
  return run.members.map((member, index) => {
    const leg = legs[index]
    if (leg === undefined) return member.drafted
    return leg.reduce((count, at) => count + (coverage[at] ?? 0), 0)
  })
}

/** Whether every pixel of the locked wall is drafted, by whoever, or already the team's. */
export const captureWallDrafted = (run: CaptureRun): boolean =>
  run.wall !== null && captureCoverage(run).every((bit) => bit !== 0)

/**
 * Whether Start countdown waits for member `index` to press Ready: Wait for Ready is on, they paint
 * at a slot, and their tab has a Ready button.
 */
export const captureAwaitsReady = (run: CaptureRun, index: number): boolean =>
  run.waitForReady === true && capturePaints(run, index) && run.members[index]?.ready !== undefined

/** Whether everyone Start countdown waits for has pressed Ready; true while Wait for Ready is off. */
export const captureMembersReady = (run: CaptureRun): boolean =>
  run.members.every((member, index) => member.ready === true || !captureAwaitsReady(run, index))

/** Whether `covered` is a coverage of the lobby's locked wall: a bit for each of its pixels. */
export const isCaptureCoverage = (run: CaptureRun, covered: unknown): covered is string =>
  run.wall !== null && isPackedBits(covered, run.wall.length / 2)

/**
 * Whether someone left a leg or guard zone the lock-in gave them, before the countdown. Nobody else
 * takes it over: the host locks in again to cut the wall for who is left.
 */
export const captureVacant = (run: CaptureRun): boolean =>
  run.startsAt === null &&
  run.wall !== null &&
  run.members.some((member, index) => member.left === true && !isCaptureReserve(run, index))

/**
 * Whether the countdown may start: a wall is locked in, its legs fit the painting members, nobody
 * has left theirs, someone who paints at a slot has drafted every pixel of it, and with Wait for
 * Ready on, everyone it waits for has pressed Ready.
 */
export const captureReady = (run: CaptureRun): boolean =>
  run.startsAt === null &&
  run.wall !== null &&
  captureShortfall(run.wall.length / 2, capturePainterCount(run)) === 0 &&
  !captureVacant(run) &&
  captureWallDrafted(run) &&
  captureMembersReady(run)

/**
 * The host's index in `captureEveryone`, or -1 when nobody eligible is in the lobby: the recorded
 * host while they are in it, else the member who joined first, ties in member order. A lobby stored
 * by backend 1.6.0 records no host, so its opener hosts while in it. `eligible` narrows who may
 * host, as to the connected sessions.
 */
export const captureHostIndex = (
  run: CaptureRun,
  eligible: (member: CaptureMember) => boolean = () => true,
): number => {
  const members = captureEveryone(run)
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
  (value.left === undefined || value.left === true) &&
  // Only bounded here: `captureCoverage` ignores one that doesn't fit the wall.
  (value.covered === undefined ||
    (typeof value.covered === 'string' && value.covered.length <= MAX_CAPTURE_COVERAGE_LENGTH)) &&
  (value.ready === undefined || typeof value.ready === 'boolean')

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
    waiting,
    waitForReady,
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
    !isSafeInteger(cut) ||
    !(waitForReady === undefined || waitForReady === true) ||
    !(
      waiting === undefined ||
      (Array.isArray(waiting) &&
        members.length + waiting.length <= MAX_CAPTURE_MEMBERS &&
        waiting.every(isMember))
    )
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
    ...(waitForReady === undefined ? {} : { waitForReady }),
    members,
    wall,
    guardZones,
    startsAt,
    staggerMs,
    ...(leadMs === undefined ? {} : { leadMs }),
    cut,
    ...(waiting === undefined ? {} : { waiting }),
  }
}
