import type {
  ContributionDay,
  PainterIdentity,
  PainterTotal,
  WplaceUserId,
} from '@caelestis/shared'

/** How many leading painters a fresh chart draws before anyone touches the picker. */
export const DEFAULT_VISIBLE_PAINTERS = 5

/** How many painters the panel asks the server to list; the route clamps to the same. */
export const MAX_PAINTER_OPTIONS = 500

/** How many painters may be drawn at once: the history route's `painters=` bound. */
export const MAX_SELECTED_PAINTERS = 50

/**
 * The next override map after toggling one painter, refusing to grow the selection past `max`
 * because `/painter-history` would refuse the request and every line would vanish with it.
 */
export const togglePainterSelection = (
  overrides: Readonly<Record<number, boolean>>,
  selected: ReadonlySet<number>,
  wplaceUserId: number,
  max = MAX_SELECTED_PAINTERS,
): Record<number, boolean> => {
  const shown = selected.has(wplaceUserId)
  if (!shown && selected.size >= max) return overrides
  return { ...overrides, [wplaceUserId]: !shown }
}

/** A painter the picker can offer: `GET /telemetry/painters` already sums and orders them. */
export type PainterOption = PainterTotal

/** Set the entire picker selection in one update, within the history request limit. */
export const selectAllPainters = (
  options: readonly PainterOption[],
  shown: boolean,
  max = MAX_SELECTED_PAINTERS,
): Record<number, boolean> =>
  Object.fromEntries(options.map((painter, index) => [painter.wplaceUserId, shown && index < max]))

/** The leading painters that a chart shows until the picker says otherwise. */
export const defaultVisiblePainters = (
  options: readonly PainterOption[],
  limit = DEFAULT_VISIBLE_PAINTERS,
): Set<WplaceUserId> => new Set(options.slice(0, limit).map((painter) => painter.wplaceUserId))

/** The label the chart, picker, and tooltip all use for a painter. */
export const painterLabel = (painter: PainterIdentity): string =>
  painter.displayName || `user ${painter.wplaceUserId}`

/** A painter in a contribution history, with everything they placed in it. */
export interface ContributionPainter extends PainterIdentity {
  readonly placed: number
}

/**
 * Everyone in a contribution history, most pixels placed first, each under the latest name they
 * reported. Keyed by Wplace id, so a rename or a namesake never merges or splits a painter.
 */
export const contributionPainters = (days: readonly ContributionDay[]): ContributionPainter[] => {
  const painters = new Map<WplaceUserId, ContributionPainter & { named: number }>()
  for (const day of days) {
    const known = painters.get(day.wplaceUserId)
    const rename = day.displayName !== '' && (known === undefined || day.day >= known.named)
    painters.set(day.wplaceUserId, {
      wplaceUserId: day.wplaceUserId,
      displayName: rename ? day.displayName : (known?.displayName ?? ''),
      named: rename ? day.day : (known?.named ?? Number.NEGATIVE_INFINITY),
      placed: (known?.placed ?? 0) + day.placed,
    })
  }
  return [...painters.values()]
    .sort((a, b) => b.placed - a.placed || a.wplaceUserId - b.wplaceUserId)
    .map(({ wplaceUserId, displayName, placed }) => ({ wplaceUserId, displayName, placed }))
}

/**
 * The Tailwind v4 `500` shades Wplace colours a `#ID` with, in Wplace's order: red, orange, yellow,
 * lime, emerald, teal, cyan, sky, indigo, violet, purple, fuchsia, pink, rose.
 */
const WPLACE_ID_COLOURS = [
  'oklch(63.7% 0.237 25.331)',
  'oklch(70.5% 0.213 47.604)',
  'oklch(79.5% 0.184 86.047)',
  'oklch(76.8% 0.233 130.85)',
  'oklch(69.6% 0.17 162.48)',
  'oklch(70.4% 0.14 182.503)',
  'oklch(71.5% 0.143 215.221)',
  'oklch(68.5% 0.169 237.323)',
  'oklch(58.5% 0.233 277.117)',
  'oklch(60.6% 0.25 292.717)',
  'oklch(62.7% 0.265 303.9)',
  'oklch(66.7% 0.295 322.15)',
  'oklch(65.6% 0.241 354.308)',
  'oklch(64.5% 0.246 16.439)',
] as const

/**
 * The colour Wplace shows beside a painter's `#ID`, used for their line, picker swatch, and tooltip
 * dot. It depends on nothing but the id, so it survives ranges, scopes, reloads, and renames.
 */
export const painterColour = (wplaceUserId: WplaceUserId): string =>
  WPLACE_ID_COLOURS[wplaceUserId % WPLACE_ID_COLOURS.length]

/**
 * A subsequence match score, or null when `query` is not a subsequence of `text`. Higher is
 * better: starts of words and runs of consecutive characters score most, gaps cost a little, and
 * an exact prefix wins outright. Case-insensitive, no dependency, good enough for a name list.
 */
export const fuzzyScore = (query: string, text: string): number | null => {
  const needle = query.trim().toLowerCase()
  if (needle === '') return 0
  const haystack = text.toLowerCase()
  if (haystack.startsWith(needle)) return 1_000 + needle.length * 10 - haystack.length
  let score = 0
  let position = 0
  let previous = -2
  for (const character of needle) {
    const index = haystack.indexOf(character, position)
    if (index < 0) return null
    const wordStart = index === 0 || /[\s_\-./]/.test(haystack[index - 1] ?? '')
    score += wordStart ? 10 : 1
    if (index === previous + 1) score += 5
    score -= Math.min(5, index - position)
    previous = index
    position = index + 1
  }
  return score - haystack.length / 100
}

/** The painters matching `query`, best match first; an empty query keeps leaderboard order. */
export const rankPainters = <Painter extends PainterIdentity>(
  options: readonly Painter[],
  query: string,
): Painter[] => {
  if (query.trim() === '') return [...options]
  return options
    .flatMap((painter) => {
      const score = Math.max(
        fuzzyScore(query, painterLabel(painter)) ?? Number.NEGATIVE_INFINITY,
        fuzzyScore(query, String(painter.wplaceUserId)) ?? Number.NEGATIVE_INFINITY,
      )
      return score === Number.NEGATIVE_INFINITY ? [] : [{ painter, score }]
    })
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.painter)
}
