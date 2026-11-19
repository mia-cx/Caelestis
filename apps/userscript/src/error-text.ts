/** The message of a thrown `Error`, or anything else thrown as a string. */
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * A failed server request, worded for the painter: offline and unreachable get a plain next step
 * (`retry`, such as "try again"), anything else keeps the server's own message.
 */
export const networkFailureText = (error: unknown, retry: string): string => {
  if (navigator.onLine === false) return `You are offline. Reconnect and ${retry}.`
  const message = errorText(error)
  return /failed to fetch|network|timed out/i.test(message)
    ? `Could not reach the server. Check your connection and ${retry}.`
    : message
}
