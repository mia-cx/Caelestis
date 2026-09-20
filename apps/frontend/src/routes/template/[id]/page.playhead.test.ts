// @vitest-environment happy-dom
import { millis, seconds, type Template } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// The pace chart renders for real here so the link runs both ways through the stats panel.
const fixture = vi.hoisted(() => ({
  app: {
    manifest: { season: 0, templates: [] as Template[], nodes: [] },
    statuses: new Map([['dense', { correct: 1, wrong: 0, blank: 0, total: 1 }]]),
    alarms: new Map(),
    canvas: new Map(),
    subscribeDashboard: () => () => undefined,
  },
  api: {
    getTileHistory: vi.fn(),
    getArchiveHistory: vi.fn(),
    getContributions: vi.fn(),
    getHistory: vi.fn(),
    getProgressHistory: vi.fn(),
    getLeaderboard: vi.fn(),
    getPainterHistory: vi.fn(),
    getPainterTotals: vi.fn(),
  },
  viewer: null as null | { hashFor: (key: string) => string | undefined },
}))
vi.mock('$app/state', () => ({ page: { params: { id: 'dense' } } }))
vi.mock('$lib/state/app.svelte', () => ({ useApp: () => fixture.app }))
vi.mock('$lib/api/client', () => fixture.api)
// A Svelte 5 component is a function of its anchor and props; this one only keeps the props.
vi.mock('$lib/components/TemplateViewer.svelte', () => ({
  default: (_anchor: unknown, props: { hashFor: (key: string) => string | undefined }) => {
    fixture.viewer = props
  },
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
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
  // Chart tweens become cuts, so the playhead maps through the settled window.
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
  fixture.app.manifest.templates = [template]
  fixture.viewer = null
  fixture.api.getTileHistory.mockReset().mockResolvedValue({
    frames: [0, 60, 180, 3_600].map((offset) => ({
      bucketStart: seconds(start + offset),
      hash: String(offset),
      reporters: 1,
    })),
  })
  fixture.api.getArchiveHistory
    .mockReset()
    .mockResolvedValue({ source: 'eralyon', basis: null, samples: [], frames: [] })
  fixture.api.getHistory.mockReset().mockResolvedValue({ buckets: [] })
  fixture.api.getProgressHistory.mockReset().mockResolvedValue({
    samples: [{ at: start + 60, correct: 1, mismatched: 0, total: 1 }],
  })
  fixture.api.getContributions.mockReset().mockResolvedValue({ days: [] })
  fixture.api.getLeaderboard.mockReset().mockResolvedValue({ entries: [] })
  fixture.api.getPainterHistory.mockReset().mockResolvedValue({ buckets: [] })
  fixture.api.getPainterTotals.mockReset().mockResolvedValue({ painters: [] })
})

afterEach(async () => {
  if (mounted) await unmount(mounted)
  mounted = null
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

const show = async () => {
  mounted = mount(Page, { target: document.body })
  flushSync()
  // The panel's sequential reads need a few turns before the chart mounts.
  for (let turn = 0; turn < 6; turn += 1) {
    await vi.advanceTimersByTimeAsync(0)
    flushSync()
  }
  expect(chart()).not.toBeNull()
}
const click = (label: string) => {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(button).not.toBeNull()
  button?.click()
  flushSync()
}
const position = () =>
  Number(
    document.querySelector('[aria-label="timelapse position"]')?.getAttribute('data-playhead'),
  ) - start
const paused = (): boolean => document.querySelector('[aria-label="play timelapse"]') !== null
const shownHash = (): string | undefined => fixture.viewer?.hashFor('0/0')
const advance = async (ms: number) => {
  vi.advanceTimersByTime(ms)
  flushSync()
}
const chart = (): SVGSVGElement | null => {
  const found = document.querySelector('svg[role="img"]')
  if (!(found instanceof SVGSVGElement)) return null
  found.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 240 }) as DOMRect
  return found
}
/** The chart's full range, read from the window grips, maps time across the 544px plot. */
const px = (t: number): number => {
  const from = Number(document.querySelector('[data-handle="head"]')?.getAttribute('aria-valuemin'))
  const to = Number(document.querySelector('[data-handle="tail"]')?.getAttribute('aria-valuemax'))
  return 48 + ((t - from) / (to - from)) * 544
}
const playheadX = (): number | null => {
  const line = document.querySelector('[data-playhead] line')
  return line === null ? null : Number(line.getAttribute('x1'))
}
const pointer = (type: string, init: PointerEventInit): PointerEvent =>
  new PointerEvent(type, { bubbles: true, clientY: 100, pointerType: 'mouse', ...init })
const clickChart = (t: number) => {
  chart()?.dispatchEvent(pointer('pointerdown', { clientX: px(t) }))
  window.dispatchEvent(pointer('pointerup', { clientX: px(t) }))
  flushSync()
}

it('draws the chart playhead at the transport time while playing, and hides it when live', async () => {
  await show()
  expect(position()).toBe(7_200)
  expect(playheadX()).toBeNull()

  click('play timelapse')
  expect(position()).toBe(0)
  expect(playheadX()).toBeCloseTo(px(start), 5)

  await advance(118)
  expect(position()).toBeCloseTo(60, -2)
  expect(playheadX()).toBeCloseTo(px(start + position()), 5)

  await advance(14_000)
  expect(position()).toBe(7_200)
  expect(playheadX()).toBeNull()
})

it('seeks the timelapse from a chart click, pausing playback on the latest snapshot before it', async () => {
  await show()
  click('play timelapse')
  await advance(100)
  expect(paused()).toBe(false)

  clickChart(start + 200)
  expect(position()).toBe(200)
  expect(paused()).toBe(true)
  expect(shownHash()).toBe('180')
  expect(playheadX()).toBeCloseTo(px(start + 200), 5)

  await advance(1_000)
  expect(position()).toBe(200)

  // Play resumes from the seeked time.
  click('play timelapse')
  await advance(4)
  expect(position()).toBeGreaterThanOrEqual(200)
  expect(position()).toBeLessThan(260)
})

it('clamps chart seeks to the retained history and keeps the right end live', async () => {
  await show()
  const from = Number(document.querySelector('[data-handle="head"]')?.getAttribute('aria-valuemin'))
  expect(from).toBeLessThan(start)

  clickChart(from)
  expect(position()).toBe(0)
  expect(shownHash()).toBe('0')

  const to = Number(document.querySelector('[data-handle="tail"]')?.getAttribute('aria-valuemax'))
  clickChart(to)
  expect(position()).toBe(7_200)
  expect(shownHash()).toBeUndefined()
  expect(document.body.textContent).toContain('live')
  expect(playheadX()).toBeNull()
})

it('scrubs from the playhead and leaves a drag elsewhere to zoom', async () => {
  await show()
  clickChart(start + 200)
  const plot = chart()

  plot?.dispatchEvent(pointer('pointerdown', { clientX: px(start + 200) + 4 }))
  window.dispatchEvent(pointer('pointermove', { clientX: px(start + 3_700) }))
  flushSync()
  expect(position()).toBe(3_700)
  expect(shownHash()).toBe('3600')
  window.dispatchEvent(pointer('pointerup', { clientX: px(start + 3_700) }))
  flushSync()
  expect(document.querySelector('[data-handle="tail"]')?.getAttribute('aria-valuenow')).toBe(
    document.querySelector('[data-handle="tail"]')?.getAttribute('aria-valuemax'),
  )

  plot?.dispatchEvent(pointer('pointerdown', { clientX: px(start + 1_000) }))
  window.dispatchEvent(pointer('pointermove', { clientX: px(start + 6_000) }))
  window.dispatchEvent(pointer('pointerup', { clientX: px(start + 6_000) }))
  flushSync()
  expect(position()).toBe(3_700)
  expect(document.querySelector('[data-handle="tail"]')?.getAttribute('aria-valuenow')).not.toBe(
    document.querySelector('[data-handle="tail"]')?.getAttribute('aria-valuemax'),
  )
})

it('seeks from the keyboard walk on the chart', async () => {
  await show()
  click('play timelapse')
  const plot = chart()
  const key = (init: KeyboardEventInit) => {
    plot?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
    flushSync()
  }

  key({ key: 'ArrowLeft' })
  key({ key: 'ArrowLeft' })
  key({ key: 'Enter' })

  expect(position()).toBe(60)
  expect(paused()).toBe(true)
  expect(shownHash()).toBe('60')
})

it.each([false, true])(
  'restores a canceled moved touch scrub when playing=%s',
  async (wasPlaying) => {
    await show()
    clickChart(start + 200)
    if (wasPlaying) click('play timelapse')
    const plot = chart()
    const touch = { pointerType: 'touch', pointerId: 7 }
    plot?.dispatchEvent(pointer('pointerdown', { ...touch, clientX: px(start + 200) }))
    window.dispatchEvent(pointer('pointermove', { ...touch, clientX: px(start + 3_700) }))
    flushSync()
    expect(position()).toBe(3_700)
    expect(paused()).toBe(true)
    window.dispatchEvent(pointer('pointercancel', touch))
    flushSync()
    expect(position()).toBe(200)
    expect(shownHash()).toBe('180')
    expect(paused()).toBe(!wasPlaying)
    await advance(100)
    if (wasPlaying) {
      expect(position()).toBeGreaterThan(200)
      expect(position()).toBeLessThan(260)
    } else {
      expect(position()).toBe(200)
    }
  },
)
