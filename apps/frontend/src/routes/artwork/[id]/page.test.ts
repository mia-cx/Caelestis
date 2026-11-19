// @vitest-environment happy-dom
import { millis, seconds } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STORAGE_KEYS } from '#lib/deployment.js'
import type { AppState } from '#lib/state/app.svelte.js'
import { appState, template as artwork, manifest } from '../../../tests/fixtures'

// The timelapse and the pace chart both render for real, so their link runs both ways through the
// stats panel.
const fixture = vi.hoisted(() => ({
  app: null as unknown as AppState,
  api: {
    getTileHistory: vi.fn(),
    getArchiveHistory: vi.fn(),
    getContributions: vi.fn(),
    getHistory: vi.fn(),
    getTemplateProgressHistory: vi.fn(),
    getLeaderboard: vi.fn(),
    getPainterHistory: vi.fn(),
    getPainterTotals: vi.fn(),
  },
  viewer: null as null | { hashFor: (key: string) => string | undefined },
}))
vi.mock('$app/state', () => ({ page: { params: { id: 'dense' } } }))
vi.mock('#lib/state/app.svelte.js', async (original) => ({
  ...(await original<typeof import('#lib/state/app.svelte.js')>()),
  useApp: () => fixture.app,
}))
vi.mock('#lib/api/client.js', () => fixture.api)
// A Svelte 5 component is a function of its anchor and props; this one only keeps the props.
vi.mock('#lib/components/TemplateViewer.svelte', () => ({
  default: (_anchor: unknown, props: { hashFor: (key: string) => string | undefined }) => {
    fixture.viewer = props
  },
}))

import Page from './+page.svelte'

let mounted: ReturnType<typeof mount> | null = null
const start = 1_800_000_000
const template = artwork({
  id: 'dense',
  name: 'Dense history',
  version: 'v1',
  bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  totalPixels: 1,
  chunks: [],
  createdAt: millis(start * 1_000),
  updatedAt: millis(start * 1_000),
})
/** Async turns the stats panel's one-after-another reads may take before the chart mounts. */
const MAX_MOUNT_TURNS = 20

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime((start + 7_200) * 1_000)
  localStorage.clear()
  localStorage.setItem(STORAGE_KEYS.timelapseSpeed, '0.05')
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
  // Chart tweens become cuts, so the playhead maps through the settled window.
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
  fixture.app = appState({
    manifest: manifest({ season: 0, templates: [template] }),
    statuses: [
      { templateId: 'dense', correct: 1, wrong: 0, blank: 0, total: 1, observedAt: millis(0) },
    ],
  })
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
  fixture.api.getTemplateProgressHistory.mockReset().mockResolvedValue({
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

const chart = (): SVGSVGElement | null => {
  const found = document.querySelector('svg[role="img"]')
  if (!(found instanceof SVGSVGElement)) return null
  found.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 240 }) as DOMRect
  return found
}
const show = async () => {
  mounted = mount(Page, { target: document.body })
  flushSync()
  for (let turn = 0; chart() === null; turn += 1) {
    if (turn === MAX_MOUNT_TURNS) throw new Error('the pace chart never mounted')
    await vi.advanceTimersByTimeAsync(0)
    flushSync()
  }
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
const advance = async (ms: number) => {
  vi.advanceTimersByTime(ms)
  flushSync()
}
const paused = (): boolean => document.querySelector('[aria-label="play timelapse"]') !== null
const shownHash = (): string | undefined => fixture.viewer?.hashFor('0/0')
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
  expect(localStorage.getItem(STORAGE_KEYS.timelapseSpeed)).toBe('1')
})

const transport = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="timelapse position"]')
const moveTransport = (step: number) => {
  const input = transport()
  if (input === null) throw new Error('no transport slider')
  input.value = String(step)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  flushSync()
}

it('bounds the transport slider steps across a week of history and still seeks its ends', async () => {
  vi.setSystemTime((start + 604_800) * 1_000)
  await show()
  expect(transport()?.max).toBe('1000')
  expect(position()).toBe(604_800)
  moveTransport(0)
  expect(position()).toBe(0)
  moveTransport(1)
  expect(position()).toBe(605)
  moveTransport(1_000)
  expect(position()).toBe(604_800)
  expect(document.body.textContent).toContain('live')
})

it('seeks from the slider and pauses active playback', async () => {
  await show()
  click('play timelapse')
  moveTransport(Number(transport()?.max))
  expect(position()).toBe(7_200)
  expect(document.querySelector('[aria-label="play timelapse"]')).not.toBeNull()
  await advance(1_000)
  expect(position()).toBe(7_200)
})

it('bounds finished history and imported frames at the finish instant', async () => {
  fixture.app.manifest = manifest({
    season: 0,
    templates: [
      {
        ...template,
        finished: true,
        timelapseFrozen: true,
        finishedAt: millis((start + 3_600) * 1_000),
      },
    ],
  })
  fixture.api.getTileHistory.mockResolvedValue({ frames: [] })
  fixture.api.getArchiveHistory.mockResolvedValue({
    source: 'eralyon',
    basis: null,
    samples: [],
    frames: [
      { at: start, hash: 'old', snapshotId: 1 },
      { at: start + 3_601, hash: 'after-finish', snapshotId: 2 },
    ],
  })
  await show()
  expect(fixture.api.getTileHistory).toHaveBeenCalledWith(0, 0, 0, start, start + 3_601)
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

it('plays a typed speed above 4×, keeps it across a reload, and ignores invalid entries', async () => {
  await show()
  const field = document.querySelector<HTMLInputElement>('input[aria-label="playback speed"]')
  const enter = (value: string) => {
    if (field === null) throw new Error('no speed field')
    field.value = value
    field.dispatchEvent(new Event('change', { bubbles: true }))
    flushSync()
  }
  enter('40')
  for (const invalid of ['', '0', '-3', '1e400']) enter(invalid)
  expect(field?.value).toBe('40')
  expect(localStorage.getItem(STORAGE_KEYS.timelapseSpeed)).toBe('40')

  // Two recorded hours take 175 ms at 4×; at 40× they are done well within 20 ms.
  click('play timelapse')
  await advance(20)
  expect(position()).toBe(7_200)

  if (mounted) await unmount(mounted)
  await show()
  expect(
    document.querySelector('button[aria-label="playback speed, currently 40×"]'),
  ).not.toBeNull()
})

it('plays the whole history in about ten seconds from its preset', async () => {
  vi.setSystemTime((start + 604_800) * 1_000)
  await show()
  const preset = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === '10 s',
  )
  preset?.click()
  flushSync()
  expect(localStorage.getItem(STORAGE_KEYS.timelapseSpeed)).toBe('5.9')
  click('play timelapse')
  await advance(9_800)
  expect(position()).toBeLessThan(604_800)
  await advance(200)
  expect(position()).toBe(604_800)
})

it.each(['0', '"fast"'])('plays at 1× from a corrupt saved speed %s', async (saved) => {
  localStorage.setItem(STORAGE_KEYS.timelapseSpeed, saved)
  await show()
  expect(document.querySelector('button[aria-label="playback speed, currently 1×"]')).not.toBeNull()
  click('play timelapse')
  await advance(350)
  expect(position()).toBeCloseTo(3_600, -1)
})

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
