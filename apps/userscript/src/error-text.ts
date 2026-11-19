/** The message of a thrown `Error`, or anything else thrown as a string. */
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
