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

it('folds a finer tail read onto the full read grid, rereading every bucket the server can still change', async () => {
  const full = vi.fn().mockResolvedValue({
    buckets: [
      bucket('a', 900, 0, 5),
      bucket('a', 900, 5_400, 2),
      bucket('a', 900, 6_300, 1),
      bucket('b', 900, 6_300, 1),
    ],
  })
  const held = await refreshHistory(null, 'scope', 0, 7_200, full)

  // Read again at 300 s from an hour and a half back: a late flush landed in the 5400 bucket, the
  // open 6300 bucket grew, and a new bucket began.
  const tail = vi.fn().mockResolvedValue({
    resolution: 300,
    buckets: [
      bucket('a', 300, 5_400, 2),
      bucket('a', 300, 5_700, 3),
      bucket('a', 300, 6_300, 1),
      bucket('a', 300, 6_900, 4),
      bucket('b', 300, 6_300, 1),
      bucket('a', 300, 7_200, 7),
    ],
  })
  const next = await refreshHistory(held, 'scope', 0, 9_000, tail)

  expect(tail).toHaveBeenCalledWith(2_700, 900)
  expect(next.read.buckets).toEqual(
    expect.arrayContaining([
      bucket('a', 900, 0, 5),
      bucket('a', 900, 5_400, 5),
      bucket('a', 900, 6_300, 5),
      bucket('b', 900, 6_300, 1),
      bucket('a', 900, 7_200, 7),
    ]),
  )
  expect(next.read.buckets).toHaveLength(5)
})

it('reads the whole range again for a new key', async () => {
  const held = await refreshHistory(null, 'scope', 0, 1_200, async () => ({
    buckets: [bucket('a', 900, 0, 5)],
  }))
  const read = vi.fn().mockResolvedValue({ buckets: [] })

  await refreshHistory(held, 'other scope', 0, 2_000, read)

  expect(read).toHaveBeenCalledWith(0, undefined)
})
