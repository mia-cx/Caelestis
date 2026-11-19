import { describe, expect, it, vi } from 'vitest'
import { BoundedCache, memoize } from './bounded-cache.js'

const sizeOf = (value: Uint8Array | null) => value?.byteLength ?? 0

const deferred = <Value>() => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('memoized bounded cache', () => {
  it('shares one in-flight load across concurrent callers and reuses it afterwards', async () => {
    const cache = new BoundedCache<Promise<Uint8Array | null>>({ maxEntries: 8 })
    const pending = deferred<Uint8Array | null>()
    const load = vi.fn(() => pending.promise)

    const first = memoize(cache, 'a', load, sizeOf)
    const second = memoize(cache, 'a', load, sizeOf)
    expect(load).toHaveBeenCalledTimes(1)

    pending.resolve(new Uint8Array(7))
    await expect(first).resolves.toEqual(new Uint8Array(7))
    await expect(second).resolves.toEqual(new Uint8Array(7))
    await memoize(cache, 'a', load, sizeOf)
    expect(load).toHaveBeenCalledTimes(1)

    await memoize(cache, 'b', load, sizeOf)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('never retains an empty result and lets a failed load be retried', async () => {
    const cache = new BoundedCache<Promise<Uint8Array | null>>({ maxEntries: 8 })
    const missing = vi.fn(async () => null)
    expect(await memoize(cache, 'a', missing, sizeOf)).toBeNull()
    expect(await memoize(cache, 'a', missing, sizeOf)).toBeNull()
    expect(missing).toHaveBeenCalledTimes(2)

    const failing = deferred<Uint8Array | null>()
    const load = vi.fn(() => failing.promise)
    const waiting = [memoize(cache, 'a', load, sizeOf), memoize(cache, 'a', load, sizeOf)]
    failing.reject(new Error('chunk store unavailable'))
    await expect(waiting[0]).rejects.toThrow('chunk store unavailable')
    await expect(waiting[1]).rejects.toThrow('chunk store unavailable')

    const recovered = vi.fn(async () => new Uint8Array(3))
    expect(await memoize(cache, 'a', recovered, sizeOf)).toEqual(new Uint8Array(3))
    expect(recovered).toHaveBeenCalledTimes(1)
  })

  it('bounds retained bytes by evicting the least recently used entry', async () => {
    const cache = new BoundedCache<Promise<Uint8Array | null>>({ maxBytes: 2 * 260_000 })
    const loads = new Map<string, number>()
    const read = (name: string) =>
      memoize(
        cache,
        name,
        async () => {
          loads.set(name, (loads.get(name) ?? 0) + 1)
          return new Uint8Array(250_000)
        },
        sizeOf,
      )

    for (const name of ['a', 'b', 'a', 'c', 'a', 'b']) await read(name)

    expect(loads).toEqual(
      new Map([
        ['a', 1],
        ['b', 2],
        ['c', 1],
      ]),
    )
  })

  it('drops entries once they are older than their time to live', () => {
    vi.useFakeTimers()
    try {
      const cache = new BoundedCache<string>({ ttlMs: 1_000 })
      cache.set('a', 'held')
      vi.advanceTimersByTime(999)
      expect(cache.get('a')).toBe('held')
      vi.advanceTimersByTime(1)
      expect(cache.get('a')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
