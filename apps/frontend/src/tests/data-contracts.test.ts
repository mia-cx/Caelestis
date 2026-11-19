import { seconds } from '@caelestis/shared'
import { mergeArchiveFrames } from '@caelestis/social'
import { describe, expect, it } from 'vitest'
import {
  archiveContributionDays,
  combineArchiveSamples,
} from '../lib/components/stats/archive-history'
import { contributionPainters } from '../lib/components/stats/community.svelte'
import { completionPace } from '../lib/components/stats/completion-pace'
import {
  selectAllPainters,
  togglePainterSelection,
} from '../lib/components/stats/pace-selection.svelte'
import { painterColour, rankPainters } from '../lib/components/stats/painter-identity'
import {
  combineProgressSamples,
  mergeObservedProgress,
} from '../lib/components/stats/progress-history'
import { clampWindow, clipSeries, rollingIntervalPace } from '../lib/components/stats/progress-pace'
import { template } from './fixtures'

const sample = (at: number, correct: number | null) => ({
  at: seconds(at),
  correct,
  mismatched: correct === null ? null : 10 - correct,
  total: 10,
})
const archive = (at: number, correct: number | null) => ({ ...sample(at, correct), snapshotId: at })

describe('observed progress and archive precedence', () => {
  it('keeps historical levels but excludes artwork revisions from rolling and lifetime painting pace', () => {
    const history = combineProgressSamples([
      [
        { ...sample(0, 2), revision: 'original' },
        { ...sample(3600, 8), revision: 'original' },
        { ...sample(7200, 100), mismatched: 100, total: 200, revision: 'replacement' },
        { ...sample(10800, 104), mismatched: 96, total: 200, revision: 'replacement' },
      ],
    ])
    const observed = mergeObservedProgress([], history)
    expect(observed.map(({ correct }) => correct)).toEqual([2, 8, 100, 104])
    expect(completionPace(observed, 10800, 10800)).toEqual({ correct: 5, hours: 2 })
    expect(completionPace(observed, 10800, null)).toEqual({ correct: 10 / 3, hours: 3 })
  })

  it('keeps incomplete scopes unknown and carries each scope forward only after its first observation', () => {
    expect(combineProgressSamples([[sample(10, 2), sample(30, null)], [sample(20, 3)]])).toEqual([
      sample(10, null),
      { ...sample(20, 5), mismatched: 15, total: 20 },
      { ...sample(30, null), total: 20 },
    ])
  })

  it('native gaps replace archive values and a current observation wins at the same timestamp', () => {
    const merged = mergeObservedProgress(
      [archive(10, 1), archive(20, 2), archive(30, 3)],
      [sample(20, null)],
      sample(30, 4),
    )
    expect(merged.map(({ at, correct, archive: imported }) => [at, correct, imported])).toEqual([
      [10, 1, true],
      [20, null, false],
      [30, 4, false],
    ])
    expect(
      mergeArchiveFrames({ frames: [{ bucketStart: seconds(20), hash: 'native', reporters: 1 }] }, [
        { at: 10, snapshotId: 10, hash: null },
        { at: 20, snapshotId: 20, hash: 'overlap' },
      ]),
    ).toEqual([
      { bucketStart: 10, hash: undefined, missing: true },
      { bucketStart: 20, hash: 'native', reporters: 1 },
    ])
  })

  it('archive totals require matching observations and an established basis for every scope', () => {
    const basis = {
      templateId: template().id,
      versionId: template().version,
      name: 'Artwork',
      season: 1,
      bbox: { minX: 0, minY: 0, maxX: 10, maxY: 1 },
      total: 10,
      chunks: [],
    }
    const histories = [
      { source: 'eralyon' as const, basis, samples: [archive(10, 2)], frames: [] },
      { source: 'eralyon' as const, basis, samples: [archive(20, 3)], frames: [] },
    ]
    const values = combineArchiveSamples(histories)
    expect(values.map(({ correct, total }) => ({ correct, total }))).toEqual([
      { correct: null, total: 20 },
      { correct: null, total: 20 },
    ])
    const imported = combineArchiveSamples([
      { ...histories[0], samples: [archive(0, 2), archive(3600, 4)] },
    ])
    const native = combineProgressSamples([[{ ...sample(7200, 6), revision: basis.versionId }]])
    const current = { ...sample(14400, 8), revision: JSON.stringify([basis.versionId]) }
    expect(completionPace(mergeObservedProgress(imported, native, current), 14400, null)).toEqual({
      correct: 1.5,
      hours: 4,
    })
    expect(completionPace(mergeObservedProgress(imported, [], current), 14400, null)).toEqual({
      correct: 1.5,
      hours: 4,
    })
    expect(
      combineArchiveSamples([{ source: 'eralyon', basis: null, samples: [], frames: [] }]),
    ).toEqual([])
  })

  it('keeps imported observations after creation until an actual native observation begins', () => {
    const imported = [archive(0, 2), archive(3600, 4), archive(10800, 6)]
    const creation = { ...sample(7200, null), revision: 'artwork', boundary: true as const }
    expect(
      mergeObservedProgress(imported, [creation]).map(({ at, correct }) => ({ at, correct })),
    ).toEqual(imported.map(({ at, correct }) => ({ at, correct })))
  })

  it('credits daily archive gains to their capture date and skips missing capture days', () => {
    const captures = [archive(0, 5), archive(86400, 3), archive(3 * 86400, 9)]
    expect([...archiveContributionDays(captures, 4 * 86400)]).toEqual([[86400, 0]])
  })
})

describe('pace and chart windows', () => {
  it('measures signed matching-pixel progress without inventing activity across gaps or future samples', () => {
    const samples = [
      sample(0, 2),
      sample(3600, 8),
      sample(7200, 5),
      sample(10800, null),
      sample(14400, 9),
    ].map((sample) => ({ ...sample, archive: false }))
    expect(completionPace(samples, 7200, 7200)).toEqual({ correct: 1.5, hours: 2 })
    expect(completionPace(samples, 7200, 3600)).toEqual({ correct: -3, hours: 1 })
    expect(completionPace(samples, 14400, 3600)).toBeNull()
    expect(completionPace(samples, 14400, null)).toEqual({ correct: 7 / 4, hours: 4 })
    expect(completionPace(samples, 3600, 3600)).toEqual({ correct: 6, hours: 1 })
    expect(completionPace([], 7200, 3600)).toBeNull()
  })

  it('runs rolling rates flat at zero through observation gaps', () => {
    expect(
      rollingIntervalPace(
        [
          { from: 0, to: 3600, pixels: 10 },
          { from: 10800, to: 14400, pixels: 20 },
        ],
        3600,
      ),
    ).toEqual([
      [
        { t: 3600, v: 10 },
        { t: 7200, v: 0 },
        { t: 10800, v: 0 },
        { t: 14400, v: 20 },
      ],
    ])
  })

  it('spreads an observation longer than the window evenly across it', () => {
    expect(rollingIntervalPace([{ from: 0, to: 7200, pixels: 20 }], 3600)).toEqual([
      [
        { t: 3600, v: 10 },
        { t: 7200, v: 10 },
      ],
    ])
  })

  it('constrains keyboard/drag windows and interpolates visible series edges', () => {
    expect(clampWindow({ from: -20, to: 30 }, 0, 100, 10)).toEqual({ from: 0, to: 50 })
    expect(clampWindow({ from: 49, to: 51 }, 0, 100, 20)).toEqual({ from: 40, to: 60 })
    expect(
      clipSeries(
        [
          { t: 0, v: 0 },
          { t: 10, v: 20 },
        ],
        2,
        8,
        (a, b, f) => ({ t: a.t + (b.t - a.t) * f, v: a.v + (b.v - a.v) * f }),
      ),
    ).toEqual([
      { t: 2, v: 4 },
      { t: 8, v: 16 },
    ])
  })

  it('painter selection remains within the server request limit and search keeps identity matches', () => {
    const options = [
      { wplaceUserId: 1, displayName: 'Alice', placed: 30, correct: 20, repairs: 0 },
      { wplaceUserId: 2, displayName: 'Bob', placed: 20, correct: 10, repairs: 0 },
    ]
    expect(selectAllPainters(options, true, 1)).toEqual({ 1: true, 2: false })
    expect(togglePainterSelection({}, new Set([1]), 2, 1)).toEqual({})
    expect(togglePainterSelection({}, new Set([1]), 1, 1)).toEqual({ 1: false })
    expect(rankPainters(options, '2').map((p) => p.wplaceUserId)).toEqual([2])
  })

  it("painter colours repeat Wplace's 14-colour id cycle", () => {
    const cycle = Array.from({ length: 14 }, (_, id) => painterColour(id))
    expect(new Set(cycle).size).toBe(14)
    expect(painterColour(14)).toBe(painterColour(0))
    expect(painterColour(27)).toBe(painterColour(13))
  })

  it('heatmap painters stay apart by id, take their latest name, and lead by pixels placed', () => {
    const row = (wplaceUserId: number, displayName: string, day: number, placed: number) => ({
      templateId: 't',
      wplaceUserId,
      displayName,
      day: seconds(day * 86_400),
      placed,
      correct: placed,
      repairs: 0,
    })
    expect(
      contributionPainters([
        row(2, 'Mira', 2, 5),
        row(1, 'Old name', 1, 4),
        row(1, 'Mira', 3, 4),
        row(1, '', 4, 1),
        row(3, '', 1, 2),
      ]),
    ).toEqual([
      { wplaceUserId: 1, displayName: 'Mira', placed: 9 },
      { wplaceUserId: 2, displayName: 'Mira', placed: 5 },
      { wplaceUserId: 3, displayName: '', placed: 2 },
    ])
  })
})
