/** A non-null, non-array object: the shape of a decoded JSON object before its fields are checked. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `Number.isSafeInteger` as a type guard. */
export const isSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)
