/**
 * Reads a render keeps in flight. Enough to hide storage and network latency; few enough that a
 * Worker holds only a handful of compressed tiles and stays within its connection limit.
 */
const READ_AHEAD = 6

/**
 * Start `read` for each item in order, with at most `limit` results unclaimed. Each call of the
 * returned function resolves the next item's result and starts one more read, so callers decode in
 * their original order while later reads overlap that work. Call it once per item.
 */
export const readAhead = <T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
  limit = READ_AHEAD,
): (() => Promise<R>) => {
  const started: Promise<R>[] = []
  const start = () => {
    if (started.length === items.length) return
    const result = read(items[started.length])
    // Claimed and awaited in order; this only stops an early failure being reported as unhandled.
    result.catch(() => {})
    started.push(result)
  }
  for (let index = 0; index < limit; index++) start()
  let taken = 0
  return () => {
    const result = started[taken++]
    start()
    return result
  }
}
