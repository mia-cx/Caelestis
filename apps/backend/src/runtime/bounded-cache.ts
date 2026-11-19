export interface CacheBounds {
  readonly maxEntries?: number
  /** Total of the byte sizes given to `set`. A value larger than this alone is not kept. */
  readonly maxBytes?: number
  /** Entries expire this long after they were set. */
  readonly ttlMs?: number
}

interface Entry<Value> {
  readonly value: Value
  readonly bytes: number
  readonly expiresAt: number
}

/**
 * A least-recently-used map bounded by entries, bytes, and age. It holds no canonical state:
 * every caller can rebuild what it evicts.
 */
export class BoundedCache<Value> {
  private readonly entries = new Map<string, Entry<Value>>()
  private bytes = 0

  constructor(private readonly bounds: CacheBounds) {}

  get(key: string): Value | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.delete(key)
      return undefined
    }
    // Map order is recency order: re-inserting marks the entry most recently used.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: Value, bytes = 0): void {
    this.delete(key)
    const maxBytes = this.bounds.maxBytes ?? Infinity
    if (bytes > maxBytes) return
    this.entries.set(key, {
      value,
      bytes,
      expiresAt: Date.now() + (this.bounds.ttlMs ?? Infinity),
    })
    this.bytes += bytes
    const maxEntries = this.bounds.maxEntries ?? Infinity
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= maxEntries && this.bytes <= maxBytes) break
      this.delete(oldest)
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    this.bytes -= entry.bytes
  }
}

/**
 * Share one load per key: concurrent callers join the pending promise, and later callers reuse
 * the result while the cache keeps it. A rejected load, or a result `sizeOf` calls empty (0
 * bytes), is dropped so the next caller loads again.
 */
export const memoize = async <Value>(
  cache: BoundedCache<Promise<Value>>,
  key: string,
  load: () => Promise<Value>,
  sizeOf: (value: Value) => number,
): Promise<Value> => {
  const held = cache.get(key)
  if (held !== undefined) return held
  const pending = load()
  cache.set(key, pending)
  try {
    const value = await pending
    const bytes = sizeOf(value)
    if (cache.get(key) === pending) {
      if (bytes === 0) cache.delete(key)
      else cache.set(key, pending, bytes)
    }
    return value
  } catch (error) {
    if (cache.get(key) === pending) cache.delete(key)
    throw error
  }
}
