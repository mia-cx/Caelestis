import { describe, expect, it, vi } from 'vitest'

/**
 * Two extension tabs over one asynchronous store, wired the way the bridge wires them: writes are
 * stored in order, and a fetch answers only after the same tab's earlier writes are stored.
 */
const store = new Map<string, string>()

const tab = async () => {
  vi.resetModules()
  const values = new Map(store)
  let queue: Promise<unknown> = Promise.resolve()
  const later = <T>(work: () => T): Promise<T> => {
    const next = queue.then(() => new Promise<T>((resolve) => setTimeout(() => resolve(work()))))
    queue = next
    return next
  }
  const storage = await import('../src/stored-values.js')
  storage.useStoredValues(values, {
    persist: (key, value) =>
      void later(() => (value === null ? store.delete(key) : store.set(key, value))),
    fetch: () => later(() => Object.fromEntries(store)),
  })
  return storage
}

describe('stored values shared between extension tabs', () => {
  it('a sync hands one tab’s writes and deletes to the next', async () => {
    store.set('caelestis.region-claims.v1', '[]')
    store.set('caelestis.region-claims.v1.retired:a', 'false')
    const first = await tab()
    const second = await tab()
    const changed = vi.fn()
    second.onStoredValueChange(changed)

    first.storeValue('caelestis.region-claims.v1', '[{"id":"mine"}]')
    first.deleteStoredValue('caelestis.region-claims.v1.retired:a')
    await first.syncStoredValues()
    await second.syncStoredValues()

    expect(second.storedValue('caelestis.region-claims.v1')).toBe('[{"id":"mine"}]')
    expect(second.storedValue('caelestis.region-claims.v1.retired:a')).toBeNull()
    expect(changed.mock.calls.map(([key]) => key).sort()).toEqual([
      'caelestis.region-claims.v1',
      'caelestis.region-claims.v1.retired:a',
    ])
  })
})
