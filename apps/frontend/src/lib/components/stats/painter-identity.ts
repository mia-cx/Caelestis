import type { PainterIdentity, WplaceUserId } from '@caelestis/shared'

/** The label the chart, picker, and tooltip all use for a painter. */
export const painterLabel = (painter: PainterIdentity): string =>
  painter.displayName || `user ${painter.wplaceUserId}`

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
const fuzzyScore = (query: string, text: string): number | null => {
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
