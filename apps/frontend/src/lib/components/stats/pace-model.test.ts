import { describe, expect, it } from 'vitest'
import { cumulativePlacements, progressSegments } from './pace-model'

const DAY = 86_400

describe('pace model', () => {
  it('keeps progress continuous across an artwork revision and steps at its boundary', () => {
    const segments = progressSegments([
      { at: 0, correct: 5, mismatched: 5, total: 10, revision: 'original', archive: false },
      {
        at: DAY,
        correct: 8,
        mismatched: 12,
        total: 20,
        revision: 'replacement',
        boundary: true,
        archive: false,
      },
      {
        at: 3 * DAY,
        correct: 9,
        mismatched: 11,
        total: 20,
        revision: 'replacement',
        archive: false,
      },
    ])

    expect(segments).toHaveLength(1)
    expect(segments[0]?.filter((point) => point.t === DAY).map((point) => point.v)).toEqual([5, 8])
  })

  it('fills missing buckets with nothing and leaves out the bucket still open at the right edge', () => {
    const points = cumulativePlacements(
      [
        { bucketStart: 0, placed: 2 },
        { bucketStart: 7_200, placed: 3 },
        { bucketStart: 10_800, placed: 4 },
      ],
      3_600,
      0,
      12_000,
    )

    expect(points).toEqual([
      { t: 0, cumPlaced: 2 },
      { t: 3_600, cumPlaced: 2 },
      { t: 7_200, cumPlaced: 5 },
    ])
  })
})
