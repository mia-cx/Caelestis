/** One palette colour's progress, as the status tables store it in a JSON array column. */
export interface ColourStatus {
  readonly index: number
  readonly correct: number
  readonly wrong: number
  readonly blank: number
  readonly total: number
}

/** A version's stored colour histogram; absent on versions stored before it was. */
export const parseColourTotals = (
  value: string | null,
): readonly { readonly index: number; readonly total: number }[] | undefined => {
  if (value === null) return undefined
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed)
    ? (parsed as readonly { readonly index: number; readonly total: number }[])
    : undefined
}

export const parseColourStatuses = (value: string): readonly ColourStatus[] => {
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed) ? (parsed as readonly ColourStatus[]) : []
}
