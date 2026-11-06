// @vitest-environment happy-dom
import { millis, seconds, type Template } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Progress } from '#lib/tree.js'
import { template } from '../../tests/fixtures'

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
vi.mock('#lib/components/charts/ProgressPaceChart.svelte', () => ({ default: () => undefined }))

import StatsPanel from './StatsPanel.svelte'

const start = 1_800_000_000
const progress: Progress = { completed: 1, mismatched: 0, unpainted: 3, known: 4, total: 4 }
const live = (id: string): Template =>
  template({ id, createdAt: millis(start * 1_000), version: `${id}-v1` })
const subscribeDashboard = vi.fn(
  (_templateIds: readonly string[], _contributionsFrom: number, _listener: unknown) => () =>
    undefined,
)

let mounted: ReturnType<typeof mount> | null = null

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime((start + 7_200) * 1_000)
  localStorage.clear()
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
  subscribeDashboard.mockClear()
})

afterEach(() => {
  if (mounted !== null) unmount(mounted)
  mounted = null
  vi.useRealTimers()
})

const render = (templates: readonly Template[]) => {
  const props = $state({ templates, season: 0, liveDashboard: true, progress, subscribeDashboard })
  mounted = mount(StatsPanel, { target: document.body, props })
  return props
}

it('reads no history again when a live status rebuilds the same templates', async () => {
  const props = render([live('a'), live('b')])
  await vi.advanceTimersByTimeAsync(0)
  const reads = [
    client.getHistory,
    client.getArchiveHistory,
    client.getTemplateProgressHistory,
    client.getPainterTotals,
  ]
  const before = reads.map((read) => read.mock.calls.length)

  // A status delta rebuilds the tree: new arrays and progress around the same templates.
  props.templates = [...props.templates]
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
  expect(lifetimeFrom).toBeLessThan(start)
  // Every bucket the server can still change: the last 3690 s, on the full read's 60 s grid.
  expect(from).toBe(start + 3_480)
  expect(options).toEqual({ maxResolution: 60 })
})
