import { isRecord } from '@caelestis/shared'
import { warn } from './debug.js'
import { type WplaceLabel, wplaceLabel } from './wplace-messages.js'
import { findWplaceModules } from './wplace-modules.js'

/**
 * A refused territory-event paint keeps its draft, so the painter's next Paint tap submits it again.
 *
 * The event's Paint panel sends its draft over the territory socket, not as a `/paint` request, and
 * the server refuses pixels inside a successful answer: `{ painted, refused, reason }`. Wplace's
 * panel shows the reason and then clears the whole draft. It keeps the draft only when the paint
 * call throws. So when the answer refuses pixels, the store's `paint` rejects with Wplace's own
 * message for the reason, and Wplace's error path shows it and leaves the draft as it is.
 *
 * Caelestis never writes the draft. A draft the painter cancels or changes meanwhile stays as they
 * left it. Pawtect cannot see the wrapper: no event is dispatched and no response is altered.
 * Territory Weekend only; this module goes with the rest of the event support after 30 November 2026.
 */

/** What the territory server answers a paint with, summed over Wplace's batches. */
export interface TerritoryPaintResult {
  readonly painted: number
  readonly refused: number
  readonly reason?: string
}

/** One socket answer from the territory server; a paint's carries that batch's result. */
export interface TerritoryAnswer {
  readonly result?: { readonly reason?: string }
}

/** A socket request Wplace's store sends; a paint batch carries its pixels as `[x, y]` pairs. */
export interface TerritoryRequest {
  readonly t?: unknown
  readonly pixels?: unknown
}

/**
 * Wplace's territory store: the one object the event panel paints through. `paint` sends the draft
 * in batches, each one a `request`, and sums them, keeping only the last batch's reason.
 */
export interface TerritoryStore {
  paint(pixels: unknown): Promise<TerritoryPaintResult>
  request(message: TerritoryRequest): Promise<TerritoryAnswer>
}

/** The reason Wplace leaves unreported: pixels the team already holds cost nothing. */
const OWN = 'own'

/** Wplace's message for each reason a paint can be refused; it falls back to not-adjacent too. */
const REFUSAL_MESSAGES: Readonly<Record<string, WplaceLabel>> = {
  'not-adjacent': 'territory_not_adjacent',
  'enemy-home': 'territory_enemy_home',
  'no-charges': 'no_more_charges',
  outside: 'territory_stay_in_arena',
}

const cell = (x: unknown, y: unknown): string => `${x},${y}`

/** The cell a paint batch starts at: each batch is a slice of exactly one submission's pixels. */
const batchCell = (message: TerritoryRequest): string | null => {
  if (message.t !== 'paint' || !Array.isArray(message.pixels)) return null
  const [first] = message.pixels as unknown[]
  return Array.isArray(first) ? cell(first[0], first[1]) : null
}

/** The cells a submission paints, from the `{ x, y }` pixels Wplace's panel hands `paint`. */
const submittedCells = (pixels: unknown): Set<string> =>
  new Set(
    (Array.isArray(pixels) ? (pixels as { x?: unknown; y?: unknown }[]) : []).map((pixel) =>
      cell(pixel?.x, pixel?.y),
    ),
  )

interface Submission {
  readonly cells: ReadonlySet<string>
  readonly refusals: string[]
}

/**
 * Make `store.paint` reject whenever any of its own batches is refused for a reason other than own,
 * so Wplace's panel keeps the draft. The summed result alone can't tell: a later batch of owned
 * pixels hides an earlier refusal. A painter can cancel a pending paint and submit another, so
 * each batch's answer goes to the submission holding its pixels. Shadows the prototype methods on
 * the instance, which is what Wplace calls.
 */
export const keepRefusedDrafts = (store: TerritoryStore): void => {
  const paint = store.paint.bind(store)
  const request = store.request.bind(store)
  const pending = new Set<Submission>()
  store.request = async (message) => {
    const answer = await request(message)
    const reason = answer.result?.reason
    const at = batchCell(message)
    if (reason && reason !== OWN && at !== null)
      for (const submission of pending)
        if (submission.cells.has(at)) submission.refusals.push(reason)
    return answer
  }
  store.paint = async (pixels) => {
    const submission: Submission = { cells: submittedCells(pixels), refusals: [] }
    pending.add(submission)
    try {
      const result = await paint(pixels)
      const [reason] = submission.refusals
      if (reason === undefined) return result
      throw new Error(wplaceLabel(REFUSAL_MESSAGES[reason] ?? 'territory_not_adjacent'))
    } finally {
      pending.delete(submission)
    }
  }
}

const isTerritoryStore = (value: unknown): value is TerritoryStore =>
  isRecord(value) &&
  ['paint', 'request', 'swap', 'sentByMe'].every((method) => typeof value[method] === 'function')

/** Find Wplace's territory store and keep its refused drafts. */
export const installTerritoryRefusals = async (): Promise<void> => {
  try {
    const found = await findWplaceModules({
      territory: (source) => source.includes('PUBLIC_TERRITORY_URL') && source.includes('sentByMe'),
    })
    const store = Object.values(found.territory?.module ?? {}).find(isTerritoryStore)
    if (store === undefined) throw new Error('territory store not found')
    keepRefusedDrafts(store)
  } catch (error) {
    warn('refused territory drafts will be cleared', String(error))
  }
}
