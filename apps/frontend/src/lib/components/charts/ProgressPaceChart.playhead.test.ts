// @vitest-environment happy-dom
import { type HistoryBucket, seconds } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProgressPaceChart from './ProgressPaceChart.svelte'

let mounted: ReturnType<typeof mount> | null = null
const stored = new Map<string, string>()

beforeEach(() => {
  stored.clear()
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
  // Tweens and transitions become cuts, so every assertion below sees the settled chart.
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  })
})

afterEach(async () => {
  if (mounted !== null) await unmount(mounted)
  mounted = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

// 640px wide, 48px gutters on both sides: the plot and the strip both map time across 544px.
const PLOT_LEFT = 48
const PLOT_WIDTH = 544
const DAY = 86_400
const THREE_DAYS = 3 * DAY
const px = (t: number, from = 0, to = THREE_DAYS): number =>
  PLOT_LEFT + ((t - from) / (to - from)) * PLOT_WIDTH

const bucket = (bucketStart: number): HistoryBucket => ({
  templateId: 'template',
  resolution: 3_600,
  bucketStart: seconds(bucketStart),
  placed: 1,
  correct: 1,
  repairs: 0,
})

const mountThreeDays = (
  extra: { playhead?: number | null; onSeek?: (t: number) => void } = {},
): void => {
  mounted = mount(ProgressPaceChart, {
    target: document.body,
    props: {
      buckets: Array.from({ length: 72 }, (_, hour) => bucket(hour * 3_600)),
      resolution: 3_600,
      from: 0,
      to: THREE_DAYS,
      anchorCorrect: 72,
      anchorMismatched: 0,
      progressSamples: Array.from({ length: 73 }, (_, hour) => ({
        at: hour * 3600,
        correct: Math.min(hour + 1, 72),
        mismatched: 0,
        total: 100,
      })),
      ...extra,
    },
  })
  flushSync()
}

const chart = (): SVGSVGElement => {
  const found = document.querySelector('svg[role="img"]')
  if (!(found instanceof SVGSVGElement)) throw new Error('missing chart')
  found.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 240 }) as DOMRect
  return found
}
const playheadX = (): number | null => {
  const line = document.querySelector('[data-playhead] line')
  return line === null ? null : Number(line.getAttribute('x1'))
}
const brushPlayheadX = (): number | null => {
  const line = document.querySelector('[data-brush-playhead]')
  return line === null ? null : Number(line.getAttribute('x1'))
}
const gripValue = (edge: 'head' | 'tail'): number =>
  Number(document.querySelector(`[data-handle="${edge}"]`)?.getAttribute('aria-valuenow'))
const preset = (key: string): HTMLButtonElement => {
  const found = document.querySelector(`button[data-range-preset="${key}"]`)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing ${key} preset`)
  return found
}
const pointer = (type: string, init: PointerEventInit): PointerEvent =>
  new PointerEvent(type, { bubbles: true, ...init })
const press = (target: EventTarget, init: PointerEventInit): void => {
  target.dispatchEvent(pointer('pointerdown', { clientY: 100, ...init }))
}
const drag = (clientX: number, init: PointerEventInit = {}): void => {
  window.dispatchEvent(pointer('pointermove', { clientX, clientY: 100, ...init }))
  flushSync()
}
const release = (clientX: number, init: PointerEventInit = {}): void => {
  window.dispatchEvent(pointer('pointerup', { clientX, clientY: 100, ...init }))
  flushSync()
}
const key = (init: KeyboardEventInit): void => {
  chart().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
  flushSync()
}

describe('timelapse playhead', () => {
  it('draws the playhead where the shown window maps its time, in the plot and the strip', () => {
    mountThreeDays({ playhead: DAY, onSeek: vi.fn() })

    expect(playheadX()).toBeCloseTo(px(DAY), 5)
    expect(brushPlayheadX()).toBeCloseTo(px(DAY), 5)
  })

  it('keeps the playhead in the strip when a zoomed window leaves it out of the plot', () => {
    mountThreeDays({ playhead: DAY, onSeek: vi.fn() })
    preset('1d').click()
    flushSync()

    expect(playheadX()).toBeNull()
    expect(brushPlayheadX()).toBeCloseTo(px(DAY), 5)

    // Back inside a window, the plot maps it through that window's scale.
    preset('all').click()
    flushSync()
    expect(playheadX()).toBeCloseTo(px(DAY), 5)
  })

  it('seeks on a click and still zooms on a drag', () => {
    const onSeek = vi.fn()
    mountThreeDays({ playhead: null, onSeek })
    const plot = chart()

    press(plot, { clientX: px(DAY) })
    release(px(DAY) + 2)
    expect(onSeek).toHaveBeenCalledTimes(1)
    expect(onSeek.mock.calls[0]?.[0]).toBeCloseTo(DAY, 5)

    press(plot, { clientX: px(DAY / 2) })
    drag(px(1.5 * DAY))
    expect(plot.querySelector('rect[data-plot-selection]')).not.toBeNull()
    release(px(1.5 * DAY))

    expect(onSeek).toHaveBeenCalledTimes(1)
    expect(gripValue('head')).toBe(DAY / 2)
    expect(gripValue('tail')).toBe(1.5 * DAY)
  })

  it('maps a click through the zoomed window', () => {
    const onSeek = vi.fn()
    mountThreeDays({ playhead: null, onSeek })
    preset('1d').click()
    flushSync()
    const plot = chart()

    press(plot, { clientX: px(2.5 * DAY, 2 * DAY, THREE_DAYS) })
    release(px(2.5 * DAY, 2 * DAY, THREE_DAYS))

    expect(onSeek.mock.calls[0]?.[0]).toBeCloseTo(2.5 * DAY, 5)
  })

  it.each([
    ['mouse', 8],
    ['touch', 18],
  ])('scrubs instead of zooming when a %s drag starts on the playhead', (pointerType, offset) => {
    const onSeek = vi.fn()
    mountThreeDays({ playhead: DAY, onSeek })
    const plot = chart()

    press(plot, { clientX: px(DAY) + offset, pointerType })
    drag(px(1.5 * DAY), { pointerType })
    expect(plot.querySelector('rect[data-plot-selection]')).toBeNull()
    expect(plot.classList.contains('cursor-ew-resize')).toBe(true)
    drag(px(2 * DAY), { pointerType })
    release(px(2 * DAY), { pointerType })

    const times = onSeek.mock.calls.map(([t]) => t)
    expect(times).toHaveLength(2)
    expect(times[0]).toBeCloseTo(1.5 * DAY, 5)
    expect(times[1]).toBeCloseTo(2 * DAY, 5)
    expect(gripValue('head')).toBe(0)
    expect(gripValue('tail')).toBe(THREE_DAYS)
    expect(plot.classList.contains('cursor-crosshair')).toBe(true)
  })

  it('zooms when the drag starts just beyond the playhead grab zone', () => {
    const onSeek = vi.fn()
    mountThreeDays({ playhead: DAY, onSeek })
    const plot = chart()

    press(plot, { clientX: px(DAY) + 12, pointerType: 'mouse' })
    drag(px(2 * DAY), { pointerType: 'mouse' })
    release(px(2 * DAY), { pointerType: 'mouse' })

    expect(onSeek).not.toHaveBeenCalled()
    expect(gripValue('tail')).toBe(2 * DAY)
  })

  it('does not seek when the browser cancels a touch to scroll the page', () => {
    const onSeek = vi.fn()
    mountThreeDays({ playhead: null, onSeek })
    const plot = chart()

    press(plot, { clientX: px(DAY), pointerId: 1, pointerType: 'touch' })
    window.dispatchEvent(pointer('pointercancel', { pointerId: 1, pointerType: 'touch' }))
    flushSync()
    window.dispatchEvent(
      pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: px(DAY) }),
    )
    flushSync()

    expect(onSeek).not.toHaveBeenCalled()
    expect(plot.classList.contains('cursor-crosshair')).toBe(true)
  })

  it('shows the resize cursor over the playhead and the crosshair elsewhere', () => {
    mountThreeDays({ playhead: DAY, onSeek: vi.fn() })
    const plot = chart()

    plot.dispatchEvent(pointer('pointermove', { clientX: px(DAY) + 3, pointerType: 'mouse' }))
    flushSync()
    expect(plot.classList.contains('cursor-ew-resize')).toBe(true)

    plot.dispatchEvent(pointer('pointermove', { clientX: px(2 * DAY), pointerType: 'mouse' }))
    flushSync()
    expect(plot.classList.contains('cursor-crosshair')).toBe(true)
  })

  it('seeks to the value under the keyboard walk with Enter and announces it', () => {
    const onSeek = vi.fn()
    mountThreeDays({ playhead: null, onSeek })

    key({ key: 'Enter' })
    expect(onSeek).not.toHaveBeenCalled()

    key({ key: 'ArrowLeft' })
    key({ key: 'ArrowLeft' })
    key({ key: 'Enter' })

    expect(onSeek).toHaveBeenCalledWith(THREE_DAYS - 3_600)
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain(
      'Timelapse moved to',
    )
    expect(chart().getAttribute('aria-label')).toContain('move the timelapse')
  })

  it('stays a plain zoomable chart without a timelapse', () => {
    mountThreeDays()
    const plot = chart()

    expect(playheadX()).toBeNull()
    expect(brushPlayheadX()).toBeNull()
    expect(plot.getAttribute('aria-label')).not.toContain('timelapse')

    press(plot, { clientX: px(DAY) })
    release(px(DAY))
    key({ key: 'ArrowLeft' })
    key({ key: 'Enter' })
    expect(gripValue('head')).toBe(0)
    expect(gripValue('tail')).toBe(THREE_DAYS)

    press(plot, { clientX: px(DAY / 2) })
    drag(px(1.5 * DAY))
    release(px(1.5 * DAY))
    expect(gripValue('head')).toBe(DAY / 2)
    expect(gripValue('tail')).toBe(1.5 * DAY)
  })
})
