// @vitest-environment happy-dom

import type { Progress, ProgressSample } from '@caelestis/shared'
import { millis, seconds, type Template, type TemplateStatus } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '#lib/state/app.svelte.js'
import { appState, manifest, template } from '../../../tests/fixtures'
import type { PainterHistorySource } from './progress-pace'

const client = vi.hoisted(() => ({
  getArchiveHistory: vi.fn(),
  getContributions: vi.fn(),
  getHistory: vi.fn(),
  getTemplateProgressHistory: vi.fn(),
  getLeaderboard: vi.fn(),
  getPainterHistory: vi.fn(),
  getPainterTotals: vi.fn(),
}))
vi.mock('#lib/api/client.js', () => client)
const fixture = vi.hoisted(() => ({
  app: null as unknown as AppState,
  chart: null as null | {
    samples: readonly ProgressSample[]
    from: number
    to: number
    live: boolean
    painterHistories: readonly PainterHistorySource[]
  },
}))
vi.mock('#lib/state/app.svelte.js', async (original) => ({
  ...(await original<typeof import('#lib/state/app.svelte.js')>()),
  useApp: () => fixture.app,
}))
vi.mock('./ProgressPaceChart.svelte', () => ({
  default: (_anchor: unknown, props: NonNullable<typeof fixture.chart>) => {
    fixture.chart = props
  },
  CHART_HEIGHT: 240,
}))

import StatsPanel from './StatsPanel.svelte'

const start = 1_800_000_000
const progress: Progress = { completed: 1, mismatched: 0, unpainted: 3, known: 4, total: 4 }
const live = (id: string): Template =>
  template({ id, createdAt: millis(start * 1_000), version: `${id}-v1` })
const subscribeDashboard = vi.fn<AppState['subscribeDashboard']>()

let mounted: ReturnType<typeof mount> | null = null

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime((start + 7_200) * 1_000)
  localStorage.clear()
  fixture.chart = null
  client.getArchiveHistory
    .mockReset()
    .mockResolvedValue({ source: 'eralyon', basis: null, samples: [], frames: [] })
  client.getTemplateProgressHistory.mockReset().mockResolvedValue({ samples: [] })
  client.getHistory.mockReset().mockResolvedValue({
    buckets: [
      {
        templateId: 'a',
        resolution: 60,
        bucketStart: seconds(start + 7_140),
        placed: 3,
        correct: 3,
        repairs: 0,
      },
    ],
  })
  client.getPainterTotals.mockReset().mockResolvedValue({ painters: [] })
  client.getPainterHistory.mockReset().mockResolvedValue({ buckets: [] })
  fixture.app = appState()
  // Streamed dashboards are the path these tests pin; the subscription itself is AppState's.
  fixture.app.live = true
  subscribeDashboard.mockReset().mockReturnValue(() => undefined)
  fixture.app.subscribeDashboard = subscribeDashboard
})

afterEach(() => {
  if (mounted !== null) unmount(mounted)
  mounted = null
  vi.useRealTimers()
})

const render = (templates: readonly Template[]) => {
  const props = $state({ templates, progress })
  mounted = mount(StatsPanel, { target: document.body, props })
  return props
}

it('reads no history again when a live status changes the progress', async () => {
  const props = render([live('a'), live('b')])
  await vi.advanceTimersByTimeAsync(0)
  const reads = [
    client.getHistory,
    client.getArchiveHistory,
    client.getTemplateProgressHistory,
    client.getPainterTotals,
  ]
  const before = reads.map((read) => read.mock.calls.length)

  props.progress = { ...progress, completed: 2 }
  flushSync()
  await vi.advanceTimersByTimeAsync(0)

  expect(reads.map((read) => read.mock.calls.length)).toEqual(before)
  expect(subscribeDashboard).toHaveBeenCalledTimes(1)
})

it('asks only for the newest buckets on each chart tick', async () => {
  render([live('a')])
  await vi.advanceTimersByTimeAsync(0)
  const [, lifetimeFrom] = client.getHistory.mock.calls[0] ?? []

  await vi.advanceTimersByTimeAsync(15_000)

  const [, from, , options] = client.getHistory.mock.calls.at(-1) ?? []
  // A tail read: past the lifetime start, yet early enough to reread the newest bucket held.
  expect(from).toBeGreaterThan(lifetimeFrom)
  expect(from).toBeLessThanOrEqual(start + 7_140)
  // On the full read's 60 s grid.
  expect(options).toEqual({ maxResolution: 60 })
})

it('caps imported observations, native history, and the live endpoint of the progress chart', async () => {
  const from = seconds(start + 1_000)
  const to = seconds(start + 5_000)
  const artwork = { ...live('a'), progressWindow: { start: from, end: to } }
  const sample = (at: number) => ({ at: seconds(at), correct: 1, mismatched: 0, total: 4 })
  client.getArchiveHistory.mockResolvedValue({
    source: 'eralyon',
    basis: { versionId: artwork.version, total: 4 },
    samples: [start, from, to].map((at) => ({ ...sample(at), snapshotId: at })),
    frames: [],
  })
  client.getTemplateProgressHistory.mockResolvedValue({ samples: [sample(start + 2_000)] })
  render([artwork])
  await vi.advanceTimersByTimeAsync(0)
  flushSync()

  expect(client.getTemplateProgressHistory).toHaveBeenCalledWith('a', from, to, from)
  expect(fixture.chart).toMatchObject({ from, to, live: false })
  expect(fixture.chart?.samples.map(({ at }) => at)).toEqual([from, start + 2_000])
})

it('excludes a capped sibling’s placements from painter pace', async () => {
  const painter = { wplaceUserId: 123, displayName: 'Painter' }
  client.getPainterTotals.mockResolvedValue({
    painters: [{ ...painter, placed: 4, correct: 4, repairs: 0 }],
  })
  client.getPainterHistory.mockResolvedValue({
    buckets: ['a', 'b'].map((templateId) => ({
      ...painter,
      templateId,
      resolution: 60,
      bucketStart: seconds(start + 7_140),
      placed: 2,
      correct: 2,
      repairs: 0,
    })),
  })
  render([
    { ...live('a'), progressWindow: { start: null, end: seconds(start + 5_000) } },
    live('b'),
  ])
  await vi.advanceTimersByTimeAsync(0)
  flushSync()
  const histories = fixture.chart?.painterHistories ?? []
  expect(histories.length).toBeGreaterThan(0)
  for (const { history } of histories)
    expect(history.buckets.map(({ templateId }) => templateId)).toEqual(['b'])
})

it('shows current counts for just the templates still inside their windows', async () => {
  const a = { ...live('a'), progressWindow: { start: null, end: seconds(start + 5_000) } }
  const b = live('b')
  fixture.app.manifest = manifest({ templates: [a, b] })
  fixture.app.statuses = new Map([
    ['a', { templateId: 'a', correct: 2, wrong: 0, blank: 2, total: 4 } as TemplateStatus],
    ['b', { templateId: 'b', correct: 3, wrong: 1, blank: 0, total: 4 } as TemplateStatus],
  ])
  render([a, b])
  await vi.advanceTimersByTimeAsync(0)
  flushSync()
  expect(fixture.chart?.samples.at(-1)).toMatchObject({
    at: start + 7_201,
    correct: 3,
    mismatched: 1,
    total: 4,
    revision: JSON.stringify([null, b.version]),
  })
})

it('chooses default painters from placements inside each template window', async () => {
  const cutoff = seconds(start + 5_000)
  const painter = (wplaceUserId: number, placed: number) => ({
    wplaceUserId,
    displayName: `Painter ${wplaceUserId}`,
    placed,
    correct: placed,
    repairs: 0,
  })
  client.getPainterTotals.mockImplementation(async (_ids, _from, _to, options) => ({
    painters: options?.windows?.some(
      ({ id, end }: { id: string; end: number }) => id === 'a' && end === cutoff,
    )
      ? [painter(6, 7), painter(7, 2)]
      : [...[1, 2, 3, 4, 5].map((id) => painter(id, 100)), painter(6, 7)],
  }))
  render([{ ...live('a'), progressWindow: { start: null, end: cutoff } }, live('b')])
  await vi.advanceTimersByTimeAsync(0)
  flushSync()
  expect(client.getPainterTotals).toHaveBeenCalledOnce()
  expect(client.getPainterTotals).toHaveBeenCalledWith(
    ['a', 'b'],
    expect.any(Number),
    start + 7_201,
    { limit: 500, windows: [{ id: 'a', start: null, end: cutoff }] },
  )
  expect(client.getPainterHistory.mock.lastCall?.[1]).toEqual([6, 7])
})
