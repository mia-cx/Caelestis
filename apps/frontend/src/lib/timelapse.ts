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

// Preserve the original hourly playback pace while allowing arbitrary snapshot intervals.
const RECORDED_SECONDS_PER_MS = 3_600 / 350

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

  /** Seek to a snapshot, or to the live stop at timeline.length. */
  seek(index: number): void {
    this.pause()
    this.position = this.timeline[index] ?? this.end
  }

  /** Pause without losing the elapsed portion of the current snapshot. */
  pause(): void {
    this.stop?.()
    this.stop = null
  }

  /** Play at recorded hours per 350 ms, reporting timeline.length at the live stop. */
  play(speed: number, onFrame: (index: number) => void): void {
    this.pause()
    const from = this.position
    const started = performance.now()
    const rate = RECORDED_SECONDS_PER_MS * speed
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
        onFrame(this.timeline.length)
        return
      }
      const index = frameAt(this.timeline, this.position)
      onFrame(index)
      const next = this.timeline[index + 1] ?? this.end
      timer = setTimeout(tick, Math.max(1, (next - this.position) / rate))
    }
    tick()
  }
}
