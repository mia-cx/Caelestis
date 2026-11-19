import { describe, expect, it, vi } from 'vitest'
import { DecodedPixelCache } from './decoded-pixel-cache.js'
import {
  createSharedClassifier,
  type SharedClassification,
  type SharedClassificationKey,
  sharedClassificationKey,
} from './shared-classification.js'

const key = (overrides: Partial<SharedClassificationKey> = {}): SharedClassificationKey => ({
  templateId: 'template-a',
  versionId: 'version-a',
  tile: { x: 12, y: 34 },
  chunkHash: 'c'.repeat(64),
  canvasHash: 'a'.repeat(64),
  ...overrides,
})

const classification = (correct: number): SharedClassification => ({
  correct,
  wrong: 0,
  blank: 0,
  colours: [{ index: 1, correct, wrong: 0, blank: 0, total: correct }],
  mask: new Uint8Array(12 + 250_000),
})

const deferred = <Value>() => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('shared classification', () => {
  it('keys on template, version, tile, chunk hash, and canvas hash', () => {
    const base = sharedClassificationKey(key())

    expect(sharedClassificationKey(key())).toBe(base)
    expect(sharedClassificationKey(key({ templateId: 'template-b' }))).not.toBe(base)
    expect(sharedClassificationKey(key({ versionId: 'version-b' }))).not.toBe(base)
    expect(sharedClassificationKey(key({ tile: { x: 13, y: 34 } }))).not.toBe(base)
    expect(sharedClassificationKey(key({ chunkHash: 'd'.repeat(64) }))).not.toBe(base)
    expect(sharedClassificationKey(key({ canvasHash: 'b'.repeat(64) }))).not.toBe(base)
  })

  it('shares one in-flight classification across concurrent reporters and reuses it afterwards', async () => {
    const classifier = createSharedClassifier()
    const pending = deferred<SharedClassification | null>()
    const load = vi.fn(() => pending.promise)

    const first = classifier.classify(key(), load)
    const second = classifier.classify(key(), load)
    expect(load).toHaveBeenCalledTimes(1)

    pending.resolve(classification(7))
    await expect(first).resolves.toEqual(classification(7))
    await expect(second).resolves.toEqual(classification(7))

    const third = await classifier.classify(key(), load)
    expect(third).toEqual(classification(7))
    expect(load).toHaveBeenCalledTimes(1)

    // A different canvas or chunk is different work.
    await classifier.classify(key({ canvasHash: 'b'.repeat(64) }), load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('never retains a missing result and lets a failed classification be retried', async () => {
    const classifier = createSharedClassifier()
    const missing = vi.fn(async () => null)
    expect(await classifier.classify(key(), missing)).toBeNull()
    expect(await classifier.classify(key(), missing)).toBeNull()
    expect(missing).toHaveBeenCalledTimes(2)

    const failing = deferred<SharedClassification | null>()
    const load = vi.fn(() => failing.promise)
    const waiting = [classifier.classify(key(), load), classifier.classify(key(), load)]
    failing.reject(new Error('chunk store unavailable'))
    await expect(waiting[0]).rejects.toThrow('chunk store unavailable')
    await expect(waiting[1]).rejects.toThrow('chunk store unavailable')

    const recovered = vi.fn(async () => classification(3))
    expect(await classifier.classify(key(), recovered)).toEqual(classification(3))
    expect(recovered).toHaveBeenCalledTimes(1)
  })

  it('bounds retained bytes by evicting the least recently used classification', async () => {
    const classifier = createSharedClassifier({
      cache: new DecodedPixelCache({ maxBytes: 2 * 260_000, maxEntries: 10 }),
    })
    const loads = new Map<string, number>()
    const load = (name: string) => async () => {
      loads.set(name, (loads.get(name) ?? 0) + 1)
      return classification(1)
    }

    await classifier.classify(key({ canvasHash: 'a'.repeat(64) }), load('a'))
    await classifier.classify(key({ canvasHash: 'b'.repeat(64) }), load('b'))
    await classifier.classify(key({ canvasHash: 'a'.repeat(64) }), load('a'))
    await classifier.classify(key({ canvasHash: 'c'.repeat(64) }), load('c'))
    await classifier.classify(key({ canvasHash: 'a'.repeat(64) }), load('a'))
    await classifier.classify(key({ canvasHash: 'b'.repeat(64) }), load('b'))

    expect(loads).toEqual(
      new Map([
        ['a', 1],
        ['b', 2],
        ['c', 1],
      ]),
    )
  })
})
