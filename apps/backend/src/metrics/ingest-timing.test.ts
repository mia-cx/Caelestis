import { describe, expect, it } from 'vitest'
import { IngestTimings } from './ingest-timing.js'

describe('ingest timings', () => {
  it('summarizes each stage per command with count, total, max, and percentiles', async () => {
    let now = 0
    const timings = new IngestTimings(() => now)
    for (const duration of [5, 1, 3, 100, 2]) {
      await timings.timed('upload', 'commit', async () => {
        now += duration
      })
    }
    timings.record('paint', 'apply', 7)
    timings.count('classification.shared')
    timings.count('classification.shared')
    timings.count('classification.computed')

    const snapshot = timings.snapshot()
    expect(snapshot.commands.upload.commit).toEqual({
      count: 5,
      totalMs: 111,
      maxMs: 100,
      p50Ms: 3,
      p99Ms: 100,
    })
    expect(snapshot.commands.paint.apply).toMatchObject({ count: 1, totalMs: 7 })
    expect(snapshot.commands.offer).toEqual({})
    expect(snapshot.counters).toEqual({
      'classification.shared': 2,
      'classification.computed': 1,
    })
  })

  it('records a stage even when its work throws, and resets on demand', async () => {
    let now = 0
    const timings = new IngestTimings(() => now)
    await expect(
      timings.timed('paint', 'apply', async () => {
        now += 4
        throw new Error('database unavailable')
      }),
    ).rejects.toThrow('database unavailable')
    expect(timings.snapshot().commands.paint.apply).toMatchObject({ count: 1, totalMs: 4 })

    timings.reset()
    expect(timings.snapshot().commands.paint).toEqual({})
    expect(timings.snapshot().counters).toEqual({})
  })

  it('keeps percentiles over a bounded window of recent samples', () => {
    const timings = new IngestTimings()
    for (let index = 0; index < 600; index += 1) {
      timings.record('upload', 'total', index < 88 ? 1_000 : 1)
    }
    const summary = timings.snapshot().commands.upload.total
    expect(summary).toMatchObject({ count: 600, maxMs: 1_000 })
    // The 88 slow samples fell out of the 512-sample window; the window holds only fast ones.
    expect(summary?.p99Ms).toBe(1)
  })
})
