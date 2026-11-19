/** Small async primitives shared by server reads, chunk assembly, caches and admin batches. */

interface Waiter {
  readonly grant: () => void
  readonly cancel: () => void
}

/** A counting semaphore whose waiters leave the queue when their signal aborts. */
export class Semaphore {
  readonly #limit: number
  readonly #waiters: Waiter[] = []
  #active = 0

  constructor(limit: number) {
    this.#limit = limit
  }

  /** Synchronously true when a slot is free; otherwise resolves false if `signal` aborts first. */
  #acquire(signal: AbortSignal | undefined): true | Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false)
    if (this.#active < this.#limit) {
      this.#active++
      return true
    }
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', waiter.cancel)
          resolve(true)
        },
        cancel: () => {
          const index = this.#waiters.indexOf(waiter)
          if (index !== -1) this.#waiters.splice(index, 1)
          resolve(false)
        },
      }
      signal?.addEventListener('abort', waiter.cancel, { once: true })
      this.#waiters.push(waiter)
    })
  }

  #release(): void {
    const next = this.#waiters.shift()
    if (next === undefined) this.#active--
    else next.grant()
  }

  /** Run `work` holding one slot; undefined when `signal` aborted before a slot was granted. */
  async run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T | undefined> {
    const admission = this.#acquire(signal)
    if (admission !== true && !(await admission)) return undefined
    try {
      return await work()
    } finally {
      this.#release()
    }
  }
}

/**
 * Run `work` over `items` with at most `limit` in flight, results in input order. A worker that
 * returns `stop` keeps every other worker from starting another item.
 */
export const mapLimit = async <Item, Result>(
  items: readonly Item[],
  limit: number,
  work: (item: Item) => Promise<Result>,
  stop: (result: Result) => boolean = () => false,
): Promise<(Result | undefined)[]> => {
  const results = new Array<Result | undefined>(items.length)
  let cursor = 0
  let stopped = false
  const worker = async (): Promise<void> => {
    while (cursor < items.length && !stopped) {
      const index = cursor++
      const result = await work(items[index] as Item)
      results[index] = result
      if (stop(result)) stopped = true
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Run operations one after another per key. A failed operation reaches its caller and never blocks
 * the next one; an idle key holds no memory.
 */
export class SerialQueue<Key> {
  readonly #tails = new Map<Key, Promise<void>>()

  run<Result>(key: Key, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#tails.get(key)
    const result = previous === undefined ? operation() : previous.then(operation, operation)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    this.#tails.set(key, settled)
    void settled.then(() => {
      if (this.#tails.get(key) === settled) this.#tails.delete(key)
    })
    return result
  }

  /** Settles once the work queued for `key` so far has, without queueing anything. */
  idle(key: Key): Promise<void> {
    return this.#tails.get(key) ?? Promise.resolve()
  }

  /** Settles once the work queued so far, for every key, has. */
  async idleAll(): Promise<void> {
    await Promise.all(this.#tails.values())
  }
}

const busyKeys = new Set<string>()

/** Claim `key` until the returned release runs; null while someone else holds it. */
export const claimBusy = (key: string): (() => void) | null => {
  if (busyKeys.has(key)) return null
  busyKeys.add(key)
  let released = false
  return () => {
    if (released) return
    released = true
    busyKeys.delete(key)
  }
}

/** Run `work` unless an operation with the same key is already running; null when it was. */
export const runWhileBusy = async <T>(key: string, work: () => Promise<T>): Promise<T | null> => {
  const release = claimBusy(key)
  if (release === null) return null
  try {
    return await work()
  } finally {
    release()
  }
}

/** Let the browser render and handle input between chunks of long work. */
export const yieldToBrowser = async (): Promise<void> => {
  const browserScheduler = (
    globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }
  ).scheduler
  if (browserScheduler?.yield !== undefined) {
    await browserScheduler.yield()
    return
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
