import { availableRangePresets, clampWindow, type TimeWindow } from './progress-pace.js'

const MIN_SELECTION_BUCKETS = 6

/**
 * Which part of the chart's range is shown. `null` shows the whole fetched range. Presets stay
 * attached to a moving live edge, while pointer and keyboard selections keep their absolute
 * timestamps across a re-fetch.
 */
export class ChartWindow {
  #selection = $state<TimeWindow | null>(null)
  #preset = $state<number | null>(null)
  readonly #range: () => { readonly from: number; readonly to: number; readonly resolution: number }

  constructor(
    range: () => { readonly from: number; readonly to: number; readonly resolution: number },
  ) {
    this.#range = range
  }

  get #bounds() {
    return this.#range()
  }

  readonly span = $derived(this.#bounds.to - this.#bounds.from)
  readonly minSelection = $derived(
    Math.min(this.span, this.#bounds.resolution * MIN_SELECTION_BUCKETS),
  )
  readonly view: TimeWindow = $derived.by(() => {
    const { from, to } = this.#bounds
    if (this.#preset !== null)
      return clampWindow({ from: to - this.#preset, to }, from, to, this.minSelection)
    return this.#selection === null
      ? { from, to }
      : clampWindow(this.#selection, from, to, this.minSelection)
  })
  readonly zoomed = $derived(this.view.from > this.#bounds.from || this.view.to < this.#bounds.to)
  readonly presets = $derived(availableRangePresets(this.span, this.minSelection))
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
