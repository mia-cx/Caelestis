/** Find the latest observation at a recorded time in an ascending timeline. */
export const frameAt = (timeline: readonly number[], time: number): number => {
  let low = 0
  let high = timeline.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if ((timeline[middle] ?? Infinity) <= time) low = middle + 1
    else high = middle
  }
  return low - 1
}

/**
 * Slider positions across the recorded range. A pointer cannot place a thumb more precisely than
 * this, and bits-ui materialises every step between min and max on each value change, so the
 * transport must never step through recorded seconds directly.
 */
export const TRANSPORT_STEPS = 1_000

export interface TransportScale {
  /** The slider maximum; positions run from 0 to this inclusive. */
  readonly steps: number
  toStep(time: number): number
  toTime(step: number): number
}

/** Map recorded time to a bounded slider domain whose endpoints land exactly on start and end. */
export const transportScale = (start: number, end: number): TransportScale => {
  const span = Math.max(0, end - start)
  const steps = Math.max(1, Math.min(TRANSPORT_STEPS, span))
  return {
    steps,
    toStep: (time) =>
      span === 0 ? 0 : Math.round(Math.min(1, Math.max(0, (time - start) / span)) * steps),
    toTime: (step) =>
      step >= steps ? end : step <= 0 ? start : start + Math.round((step / steps) * span),
  }
}

// Preserve the original hourly playback pace while allowing arbitrary snapshot intervals.
const RECORDED_SECONDS_PER_MS = 3_600 / 350
const PLAYHEAD_UPDATE_MS = 1_000 / 60

/** The slowest playback speed; anything slower holds one snapshot for minutes. Faster is unbounded. */
export const MIN_SPEED = 0.05

/** A speed the player can keep: null for non-positive or non-finite input, otherwise at least MIN_SPEED. */
export const playbackSpeed = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(MIN_SPEED, value)
    : null

/**
 * The speed that plays `span` recorded seconds in about `ms`, rounded to two significant digits so
 * it reads as a preset. Null when that would be slower than MIN_SPEED, including an empty span.
 */
export const speedToFit = (span: number, ms: number): number | null => {
  const speed = Number((span / (ms * RECORDED_SECONDS_PER_MS)).toPrecision(2))
  return speed >= MIN_SPEED ? speed : null
}

/**
 * A recorded-time clock with variable frame deadlines. Late callbacks skip to the current frame
 * instead of slowing dense sections down. Pause and speed changes preserve time within a frame.
 */
export class TimelapseClock {
  private position: number
  private stop: (() => void) | null = null

  constructor(
    private readonly timeline: readonly number[],
    private readonly end: number,
  ) {
    this.position = timeline[0] ?? end
  }

  /** Seek to recorded time, including the gaps between observations. */
  seek(time: number): void {
    this.pause()
    this.position = time
  }

  /** Pause without losing the elapsed portion of the current snapshot. */
  pause(): void {
    this.stop?.()
    this.stop = null
  }

  /** Play at recorded hours per 350 ms, reporting timeline.length at the live stop. */
  play(speed: number, onFrame: (index: number, time: number) => void): void {
    this.pause()
    const from = this.position
    const started = performance.now()
    // Speed has no upper cap, so an overflowing rate saturates and playback jumps to live.
    const rate = Math.min(Number.MAX_VALUE, RECORDED_SECONDS_PER_MS * speed)
    let timer: ReturnType<typeof setTimeout> | undefined
    const updatePosition = () => {
      this.position = Math.min(this.end, from + (performance.now() - started) * rate)
    }
    this.stop = () => {
      clearTimeout(timer)
      updatePosition()
    }
    const tick = () => {
      updatePosition()
      if (this.position >= this.end) {
        this.stop = null
        onFrame(this.timeline.length, this.position)
        return
      }
      const index = frameAt(this.timeline, this.position)
      onFrame(index, this.position)
      const next = this.timeline[index + 1] ?? this.end
      // Keep the transport moving through sparse holds without changing the selected image.
      timer = setTimeout(
        tick,
        Math.max(1, Math.min(PLAYHEAD_UPDATE_MS, (next - this.position) / rate)),
      )
    }
    tick()
  }
}
