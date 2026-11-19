/** A non-null, non-array object: the shape of a decoded JSON object before its fields are checked. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
