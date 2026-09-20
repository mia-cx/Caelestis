// @vitest-environment happy-dom
import { millis, seconds, type Template } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  app: {
    manifest: { season: 0, templates: [] as Template[], nodes: [] },
    statuses: new Map([['dense', { correct: 1, wrong: 0, blank: 0, total: 1 }]]),
    alarms: new Map(),
    canvas: new Map(),
  },
  history: vi.fn(),
  archive: vi.fn(),
}))
vi.mock('$app/state', () => ({ page: { params: { id: 'dense' } } }))
vi.mock('$lib/state/app.svelte', () => ({ useApp: () => fixture.app }))
vi.mock('$lib/api/client', () => ({
  getTileHistory: fixture.history,
  getArchiveHistory: fixture.archive,
}))
vi.mock('$lib/components/StatsPanel.svelte', async () => ({
  default: (await import('$lib/components/ui/skeleton')).Skeleton,
}))
vi.mock('$lib/components/TemplateViewer.svelte', async () => ({
  default: (await import('$lib/components/ui/skeleton')).Skeleton,
}))

import Page from './+page.svelte'

let mounted: ReturnType<typeof mount> | null = null
const start = 1_800_000_000
const template: Template = {
  id: 'dense',
  nodeId: null,
  name: 'Dense history',
  version: 'v1',
  bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  totalPixels: 1,
  chunks: [],
  published: true,
  finished: false,
  finishedAt: null,
  timelapseFrozen: false,
  createdAt: millis(start * 1_000),
  updatedAt: millis(start * 1_000),
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime((start + 7_200) * 1_000)
  localStorage.clear()
  localStorage.setItem('caelestis:timelapse-speed', '0.05')
  fixture.app.manifest.templates = [template]
  fixture.history.mockReset().mockResolvedValue({
    frames: [0, 60, 180, 3_600].map((offset) => ({
      bucketStart: seconds(start + offset),
      hash: String(offset),
      reporters: 1,
    })),
  })
  fixture.archive.mockReset().mockResolvedValue({ frames: [] })
})

afterEach(async () => {
  if (mounted) await unmount(mounted)
  mounted = null
  vi.useRealTimers()
  document.body.replaceChildren()
})

const show = async () => {
  mounted = mount(Page, { target: document.body })
  flushSync()
  await vi.advanceTimersByTimeAsync(0)
  flushSync()
}
const click = (label: string) => {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(button).not.toBeNull()
  button?.click()
  flushSync()
}
const position = () =>
  Number(
    document
      .querySelector('[aria-label="timelapse position"] [role="slider"]')
      ?.getAttribute('aria-valuenow'),
  ) - start
const advance = async (ms: number) => {
  vi.advanceTimersByTime(ms)
  flushSync()
}

it('plays dense history at timestamp deadlines, preserves a pause, and replays', async () => {
  await show()
  expect(position()).toBe(7_200)
  click('play timelapse')
  expect(position()).toBe(0)
  await advance(118)
  expect(position()).toBeCloseTo(60, -2)
  const paused = position()
  click('pause timelapse')
  await advance(1_000)
  expect(position()).toBe(paused)
  click('play timelapse')
  await advance(234)
  expect(position()).toBeCloseTo(180, -1)
  await advance(6_650)
  expect(position()).toBeCloseTo(3_600, -1)
  await advance(7_000)
  expect(position()).toBe(7_200)
  click('play timelapse')
  expect(position()).toBe(0)
})

it('retimes the current hold when a speed preset changes and persists the choice', async () => {
  await show()
  click('play timelapse')
  await advance(50)
  const preset = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === '1×',
  )
  preset?.click()
  flushSync()
  await advance(4)
  expect(position()).toBeCloseTo(66, -1)
  expect(localStorage.getItem('caelestis:timelapse-speed')).toBe('1')
})

it('seeks with the keyboard and pauses active playback', async () => {
  await show()
  click('play timelapse')
  const slider = document.querySelector<HTMLElement>(
    '[aria-label="timelapse position"] [role="slider"]',
  )
  slider?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  flushSync()
  expect(position()).toBe(7_200)
  expect(document.querySelector('[aria-label="play timelapse"]')).not.toBeNull()
  await advance(1_000)
  expect(position()).toBe(7_200)
})

it('bounds finished history and imported frames at the finish instant', async () => {
  fixture.app.manifest.templates = [
    {
      ...template,
      finished: true,
      timelapseFrozen: true,
      finishedAt: millis((start + 3_600) * 1_000),
    },
  ]
  fixture.history.mockResolvedValue({ frames: [] })
  fixture.archive.mockResolvedValue({
    frames: [
      { at: start, hash: 'old', snapshotId: 1 },
      { at: start + 3_601, hash: 'after-finish', snapshotId: 2 },
    ],
  })
  await show()
  expect(fixture.history).toHaveBeenCalledWith(0, 0, 0, start, start + 3_601)
  expect(position()).toBe(3_600)
  click('play timelapse')
  await advance(7_000)
  expect(position()).toBe(3_600)
  expect(document.body.textContent).toContain('current')
})

it('moves the transport evenly through dense and sparse sections', async () => {
  await show()
  click('play timelapse')
  await advance(1_750)
  expect(position()).toBeCloseTo(900, -2)
  await advance(1_750)
  expect(position()).toBeCloseTo(1_800, -2)
  await advance(3_500)
  expect(position()).toBeCloseTo(3_600, -1)
})
