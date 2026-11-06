/**
 * Reads a render keeps in flight: enough to hide storage and network latency, few enough that a
 * Worker holds only a handful of compressed tiles.
 */
const READ_AHEAD = 6

/**
 * Start `read` for each item in order, with at most `limit` reads in flight. Each call of the
 * returned function claims the next item's result; once that read settles, one more starts. Callers
 * decode in their original order while later reads overlap that work. Call it once per item.
 */
export const readAhead = <T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
  limit = READ_AHEAD,
): (() => Promise<R>) => {
  // Only unclaimed reads stay referenced, so a claimed result is free once its caller drops it.
  const pending: Promise<R>[] = []
  let next = 0
  const start = () => {
    if (next === items.length) return
    const result = read(items[next++])
    // Claimed and awaited in order; this only stops an early failure being reported as unhandled.
    result.catch(() => {})
    pending.push(result)
  }
  for (let index = 0; index < limit; index++) start()
  return () => {
    const result = pending.shift()
    if (result === undefined)
      throw new RangeError('readAhead was called more times than it has items')
    // The claimed read may still be in flight; its replacement waits for it, so at most `limit` run.
    result.then(start, start)
    return result
  }
}
