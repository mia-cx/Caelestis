/** A moment in Unix seconds as the reader's local date and time, to the minute. */
export const formatTime = (t: number): string =>
  new Date(t * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
