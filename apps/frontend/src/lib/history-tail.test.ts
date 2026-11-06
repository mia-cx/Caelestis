import { type HistoryBucket, seconds } from '@caelestis/shared'
import { expect, it, vi } from 'vitest'
import { refreshHistory } from './history-tail'

const bucket = (
  templateId: string,
  resolution: number,
  bucketStart: number,
  placed: number,
): HistoryBucket => ({
  templateId,
  resolution,
  bucketStart: seconds(bucketStart),
  placed,
  correct: placed,
  repairs: 0,
})

it('folds a finer tail read onto the full read grid, replacing the open bucket', async () => {
  const full = vi.fn().mockResolvedValue({
    buckets: [bucket('a', 900, 0, 5), bucket('a', 900, 900, 2), bucket('b', 900, 900, 1)],
  })
  const held = await refreshHistory(null, 'scope', 0, 1_200, full)

  // The open 900–1800 bucket is read again at 300 s, with new placements since the full read.
  const tail = vi.fn().mockResolvedValue({
    resolution: 300,
    buckets: [
      bucket('a', 300, 900, 2),
      bucket('a', 300, 1_500, 4),
      bucket('b', 300, 1_200, 1),
      bucket('a', 300, 1_800, 7),
    ],
  })
  const next = await refreshHistory(held, 'scope', 0, 2_000, tail)

  expect(tail).toHaveBeenCalledWith(900, 900)
  expect(next.read.buckets).toEqual(
    expect.arrayContaining([
      bucket('a', 900, 0, 5),
      bucket('a', 900, 900, 6),
      bucket('b', 900, 900, 1),
      bucket('a', 900, 1_800, 7),
    ]),
  )
  expect(next.read.buckets).toHaveLength(4)
})

it('reads the whole range again for a new key', async () => {
  const held = await refreshHistory(null, 'scope', 0, 1_200, async () => ({
    buckets: [bucket('a', 900, 0, 5)],
  }))
  const read = vi.fn().mockResolvedValue({ buckets: [] })

  await refreshHistory(held, 'other scope', 0, 2_000, read)

  expect(read).toHaveBeenCalledWith(0, undefined)
})
