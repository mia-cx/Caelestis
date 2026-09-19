import { seconds } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import type { SqlStore } from '../ports/index.js'
import { foldTileHistoryThrottled } from './history-fold-throttle.js'

const store = () => ({ foldTileHistory: vi.fn(async () => undefined) }) as unknown as SqlStore

describe('history fold throttle', () => {
  it('folds a tile on its first observation and then at most once per interval', async () => {
    const sql = store()
    let now = 1_000
    const clock = () => now
    const fold = (tile = { x: 1, y: 2 }) =>
      foldTileHistoryThrottled(sql, 0, tile, seconds(60), { intervalMs: 30_000, clock })

    expect(await fold()).toBe('folded')
    expect(await fold()).toBe('skipped')
    now += 29_999
    expect(await fold()).toBe('skipped')
    now += 1
    expect(await fold()).toBe('folded')
    expect(await fold({ x: 3, y: 4 })).toBe('folded')
    expect(sql.foldTileHistory).toHaveBeenCalledTimes(3)
  })

  it('lets a same-tile burst join one in-flight fold instead of starting more', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sql = { foldTileHistory: vi.fn(() => gate) } as unknown as SqlStore
    const tile = { x: 1, y: 2 }
    let now = 1_000
    const options = { intervalMs: 30_000, clock: () => now }
    const first = foldTileHistoryThrottled(sql, 0, tile, seconds(60), options)
    const overlapping = await Promise.all([
      foldTileHistoryThrottled(sql, 0, tile, seconds(60), options),
      foldTileHistoryThrottled(sql, 0, tile, seconds(60), options),
    ])
    // Still pending well past the interval: the running fold keeps its tile exclusive.
    now += 60_000
    expect(await foldTileHistoryThrottled(sql, 0, tile, seconds(60), options)).toBe('skipped')

    expect(overlapping).toEqual(['skipped', 'skipped'])
    expect(sql.foldTileHistory).toHaveBeenCalledTimes(1)
    release()
    expect(await first).toBe('folded')
    // The completed fold is remembered from its start, so the next observation folds again.
    expect(await foldTileHistoryThrottled(sql, 0, tile, seconds(60), options)).toBe('folded')
    expect(sql.foldTileHistory).toHaveBeenCalledTimes(2)
  })

  it('retries on the next observation when a fold fails, and keeps stores separate', async () => {
    const failing = store()
    vi.mocked(failing.foldTileHistory).mockRejectedValueOnce(new Error('fold unavailable'))
    const tile = { x: 1, y: 2 }
    await expect(foldTileHistoryThrottled(failing, 0, tile, seconds(60))).rejects.toThrow(
      'fold unavailable',
    )
    expect(await foldTileHistoryThrottled(failing, 0, tile, seconds(60))).toBe('folded')

    const other = store()
    expect(await foldTileHistoryThrottled(other, 0, tile, seconds(60))).toBe('folded')
    expect(other.foldTileHistory).toHaveBeenCalledTimes(1)
  })
})
