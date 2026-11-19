/**
 * Canonical decimal text only. `Number('')` is 0 and `Number(' 1')` and `Number('1e3')` parse
 * cleanly, so request text is matched before it is converted.
 */
const WHOLE_NUMBER = /^(?:0|[1-9]\d*)$/
const INTEGER = /^(?:0|-?[1-9]\d*)$/

const safe = (text: string): number | null => {
  const parsed = Number(text)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/** Parse canonical non-negative integer text, such as a season or a query limit. */
export const parseWholeNumber = (value: unknown): number | null =>
  typeof value === 'string' && WHOLE_NUMBER.test(value) ? safe(value) : null

/** Parse canonical signed integer text, such as an alliance-canvas origin. */
export const parseInteger = (value: unknown): number | null =>
  typeof value === 'string' && INTEGER.test(value) ? safe(value) : null
