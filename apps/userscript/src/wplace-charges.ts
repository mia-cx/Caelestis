/**
 * The signed-in painter's pixel charges, and when they will be full.
 *
 * Wplace reports `charges: { count, max, cooldownMs }` on `/me`. `count` is fractional and grows by
 * one charge every `cooldownMs`, so one reading is enough to project the count forward until the
 * next reading replaces it. Accepted paints spend charges at once, so the forecast does not lag
 * behind the painter until Wplace re-reads the account.
 */

export interface ChargeSnapshot {
  readonly count: number
  readonly max: number
  readonly cooldownMs: number
  /** When `count` was true, in `Date.now()` milliseconds. */
  readonly at: number
}

export interface ChargeForecast {
  readonly count: number
  readonly max: number
  readonly full: boolean
  /** Zero once full. */
  readonly fullInMs: number
}

type ChargeListener = () => void

let snapshot: ChargeSnapshot | null = null
const listeners = new Set<ChargeListener>()

const notify = (): void => {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // One listener's failure is not another's problem.
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const projectedCount = (state: ChargeSnapshot, now: number): number =>
  Math.min(state.max, state.count + Math.max(0, now - state.at) / state.cooldownMs)

/** Record the `charges` object from a `/me` body. Returns whether it was usable. */
export const observeCharges = (value: unknown, at = Date.now()): boolean => {
  if (!isRecord(value)) return false
  const { count, max, cooldownMs } = value
  if (
    typeof count !== 'number' ||
    typeof max !== 'number' ||
    typeof cooldownMs !== 'number' ||
    !Number.isFinite(count) ||
    !Number.isFinite(max) ||
    !Number.isFinite(cooldownMs) ||
    count < 0 ||
    max <= 0 ||
    cooldownMs <= 0
  )
    return false
  snapshot = { count: Math.min(count, max), max, cooldownMs, at }
  notify()
  return true
}

/** Spend charges on an accepted paint, projecting first so regeneration since the reading counts. */
export const spendCharges = (painted: number, at = Date.now()): void => {
  if (snapshot === null || !(painted > 0)) return
  snapshot = { ...snapshot, count: Math.max(0, projectedCount(snapshot, at) - painted), at }
  notify()
}

/** The charges right now, or null until Wplace has reported them. */
export const chargeForecast = (now = Date.now()): ChargeForecast | null => {
  if (snapshot === null) return null
  const count = projectedCount(snapshot, now)
  const fullInMs = Math.max(0, (snapshot.max - count) * snapshot.cooldownMs)
  return { count, max: snapshot.max, full: fullInMs === 0, fullInMs }
}

export const onChargesChange = (listener: ChargeListener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** `m:ss` under an hour, `h:mm:ss` above it, rounded up to the second so it never reads 0:00 early. */
export const formatCountdown = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/** Test seam: forget the reading and every listener. */
export const resetCharges = (): void => {
  snapshot = null
  listeners.clear()
}
