import { DAY_SECONDS, HOUR_SECONDS } from '@caelestis/shared'

export interface TimeWindow {
  readonly from: number
  readonly to: number
}

/**
 * Keep a window inside `[from, to]` and at least `minimum` wide. A window that is too narrow grows
 * around its centre; one that pokes outside the range slides back in without changing its width.
 */
export const clampWindow = (
  window: TimeWindow,
  from: number,
  to: number,
  minimum: number,
): TimeWindow => {
  const span = Math.min(to - from, Math.max(minimum, window.to - window.from))
  let start = window.from
  if (window.to - window.from < span) start = (window.from + window.to) / 2 - span / 2
  start = Math.min(to - span, Math.max(from, start))
  return { from: start, to: start + span }
}

const RANGE_PRESETS = [
  { key: '6h', seconds: 6 * HOUR_SECONDS, label: 'the last 6 hours' },
  { key: '1d', seconds: DAY_SECONDS, label: 'the last day' },
  { key: '3d', seconds: 3 * DAY_SECONDS, label: 'the last 3 days' },
  { key: '7d', seconds: 7 * DAY_SECONDS, label: 'the last 7 days' },
  { key: '30d', seconds: 30 * DAY_SECONDS, label: 'the last 30 days' },
] as const

/** One arrow-key nudge: about a hundredth of the history, never finer than a bucket. */
export const windowKeyStep = (span: number, resolution: number): number =>
  Math.max(resolution, Math.ceil(span / 100 / resolution) * resolution)

const MIN_SELECTION_BUCKETS = 6

/** The whole fetched range and its bucket width. */
interface ChartRange extends TimeWindow {
  readonly resolution: number
}

/**
 * Which part of the chart's range is shown. `null` shows the whole fetched range. Presets stay
 * attached to a moving live edge, while pointer and keyboard selections keep their absolute
 * timestamps across a re-fetch.
 */
export class ChartWindow {
  #selection = $state<TimeWindow | null>(null)
  #preset = $state<number | null>(null)
  readonly #range: () => ChartRange

  constructor(range: () => ChartRange) {
    this.#range = range
  }

  get range(): ChartRange {
    return this.#range()
  }

  readonly span = $derived(this.range.to - this.range.from)
  readonly minSelection = $derived(
    Math.min(this.span, this.range.resolution * MIN_SELECTION_BUCKETS),
  )
  readonly view: TimeWindow = $derived.by(() => {
    const { from, to } = this.range
    if (this.#preset !== null)
      return clampWindow({ from: to - this.#preset, to }, from, to, this.minSelection)
    return this.#selection === null
      ? { from, to }
      : clampWindow(this.#selection, from, to, this.minSelection)
  })
  readonly zoomed = $derived(this.view.from > this.range.from || this.view.to < this.range.to)
  /** Only presets narrower than the whole history and wide enough to show detail. */
  readonly presets = $derived(
    RANGE_PRESETS.filter(
      (preset) => preset.seconds < this.span && preset.seconds >= this.minSelection,
    ),
  )
  /** The active preset's key, `all` for the whole range, or null when none matches. */
  readonly activePreset = $derived(
    this.zoomed
      ? (this.presets.find((preset) => preset.seconds === this.#preset)?.key ?? null)
      : 'all',
  )

  select = (window: TimeWindow): void => {
    this.#preset = null
    this.#selection = window
  }

  preset = (seconds: number): void => {
    this.#preset = seconds
    this.#selection = null
  }

  reset = (): void => {
    this.#preset = null
    this.#selection = null
  }
}
