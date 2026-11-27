import { isRecord, isSafeInteger } from './guards.js'
import type { PainterIdentity } from './telemetry.js'
import { isWorkIdentity } from './work.js'

/**
 * A capture run: a group of painters who place one planned wall in turn, a few hundred
 * milliseconds apart, so each line lands next to the one before and the last closes the loop.
 *
 * It lives in a presence room. An administrator opens it with a group size, painters join, the
 * administrator publishes the plan and starts it; the server stamps the start time. Painter `i`
 * (from 0) paints line `i` at `startsAt + i * staggerMs`, on the server's clock, which each client
 * estimates with `clock` round trips.
 */

export const MAX_CAPTURE_PAINTERS = 16
/** Pixels in one line: a painter's full charges in the territory event. */
export const MAX_CAPTURE_LINE_PIXELS = 60
/** Time between consecutive painters, long enough for the previous paint to land. */
export const CAPTURE_STAGGER_MS = 500
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
  readonly painters: number
  /** In paint order; member `i` paints `lines[i]`. */
  readonly members: readonly CaptureMember[]
  /** Each line's world pixels as a flat `[x0, y0, x1, y1, …]` list, in placement order. */
  readonly lines: readonly (readonly number[])[]
  readonly startsAt: number | null
  readonly staggerMs: number
}

export type CaptureClientEvent =
  | { readonly type: 'capture-open'; readonly painters: number }
  | { readonly type: 'capture-join' }
  | { readonly type: 'capture-leave' }
  | { readonly type: 'capture-order'; readonly order: readonly string[] }
  | { readonly type: 'capture-plan'; readonly lines: readonly (readonly number[])[] }
  | { readonly type: 'capture-drafted'; readonly drafted: number }
  | { readonly type: 'capture-go' }
  | { readonly type: 'capture-close' }
  | { readonly type: 'clock'; readonly sent: number }

export type CaptureServerEvent =
  | { readonly type: 'capture'; readonly run: CaptureRun | null }
  /** Answers a client's `clock`: `at` is the server's time when it answered. */
  | { readonly type: 'clock'; readonly sent: number; readonly at: number }

/** When member `index` paints, on the server's clock; null until the run starts. */
export const captureSlot = (run: CaptureRun, index: number): number | null =>
  run.startsAt === null ? null : run.startsAt + index * run.staggerMs

const isLine = (value: unknown): value is readonly number[] =>
  Array.isArray(value) &&
  value.length % 2 === 0 &&
  value.length <= MAX_CAPTURE_LINE_PIXELS * 2 &&
  value.every((n) => isSafeInteger(n) && n >= 0)

const isMember = (value: unknown): value is CaptureMember =>
  isRecord(value) &&
  typeof value.sessionId === 'string' &&
  value.sessionId.length <= 64 &&
  isWorkIdentity(value.painter) &&
  isSafeInteger(value.drafted)

/** A run from a server, which is untrusted input. Null when malformed. */
export const decodeCaptureRun = (value: unknown): CaptureRun | null => {
  if (!isRecord(value)) return null
  const { id, painters, members, lines, startsAt, staggerMs } = value
  if (
    typeof id !== 'string' ||
    !isSafeInteger(painters) ||
    !Array.isArray(members) ||
    !members.every(isMember) ||
    !Array.isArray(lines) ||
    lines.length > MAX_CAPTURE_PAINTERS ||
    !lines.every(isLine) ||
    !(startsAt === null || isSafeInteger(startsAt)) ||
    !isSafeInteger(staggerMs)
  )
    return null
  return { id, painters, members, lines, startsAt, staggerMs }
}
