import { localClock } from './presence-client.js'

/**
 * A capture run's countdown beeps, scheduled on the Web Audio clock so each lands on its
 * millisecond whatever the page's timers are doing. Browsers start audio only after a click, so
 * Join and Go prime it.
 */

/** A beep at a `localClock()` time: a short tick, or the longer, higher tone to paint now. */
export interface CaptureCue {
  readonly at: number
  readonly tone: 'tick' | 'go'
}

const TONES = {
  tick: { frequency: 880, seconds: 0.09 },
  go: { frequency: 1_320, seconds: 0.35 },
} as const
const VOLUME = 0.2
/** Fade in and out over this long, so the beep starts and stops without a click. */
const RAMP_SECONDS = 0.005

let context: AudioContext | null = null

/** Create or resume the audio context; call from a click so the browser lets it play. */
export const primeCaptureAudio = (): void => {
  try {
    context ??= new AudioContext()
    void context.resume()
  } catch {
    context = null
  }
}

/** Schedule beeps; past ones are skipped. Returns a function that silences any not yet played. */
export const scheduleCaptureCues = (cues: readonly CaptureCue[]): (() => void) => {
  const audio = context
  if (audio === null) return () => {}
  const now = localClock()
  const oscillators = cues
    .filter(({ at }) => at > now)
    .map(({ at, tone }) => {
      const { frequency, seconds } = TONES[tone]
      const start = audio.currentTime + (at - now) / 1_000
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(VOLUME, start + RAMP_SECONDS)
      gain.gain.setValueAtTime(VOLUME, start + seconds - RAMP_SECONDS)
      gain.gain.linearRampToValueAtTime(0, start + seconds)
      oscillator.connect(gain).connect(audio.destination)
      oscillator.start(start)
      oscillator.stop(start + seconds)
      return oscillator
    })
  return () => {
    for (const oscillator of oscillators) {
      try {
        oscillator.stop()
      } catch {
        // Already finished.
      }
    }
  }
}
