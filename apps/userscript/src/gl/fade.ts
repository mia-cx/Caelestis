/**
 * Opacity ramps, for anything that can be switched on and off.
 *
 * Nothing in the overlay appears or disappears: it arrives and it leaves. That is not decoration —
 * a template, a marker layer and a colour all occupy the same pixels, so a switch that acts
 * instantly gives no clue which of the three moved, and toggling one to find out is exactly what
 * the transition saves you from. Three hundred milliseconds is long enough to see *what* changed
 * and short enough that it never becomes a wait.
 */

/** How long anything takes to arrive or leave. */
export const FADE_MS = 300

/**
 * Cubic ease-in-out: slow to leave, quick through the middle, slow to land. CSS's own
 * `ease-in-out` is a gentler curve than this one.
 */
const CONTROL = [0.65, 0, 0.35, 1] as const

/**
 * That bezier, evaluated. A CSS cubic bezier is a curve in two dimensions with its ends pinned to
 * (0,0) and (1,1), so getting `y` for a given time means first solving `x(t) = time` for the
 * parameter.
 */
const bezier = (a: number, b: number, at: number): number => {
  const curve = (t: number, p1: number, p2: number): number => {
    const u = 1 - t
    return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t
  }
  let low = 0
  let high = 1
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2
    if (curve(mid, a, b) < at) low = mid
    else high = mid
  }
  return curve((low + high) / 2, CONTROL[1], CONTROL[3])
}

const ease = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : bezier(CONTROL[0], CONTROL[2], t))

/** The shared fade curve at an elapsed duration, for non-opacity motion that must stay in step. */
export const fadeProgress = (elapsedMs: number): number => ease(elapsedMs / FADE_MS)

interface Fade {
  /** Where the ramp started, so a fade interrupted midway carries on from where it was. */
  readonly from: number
  readonly to: number
  readonly since: number
}

export interface Ramps {
  /** Advance a ramp towards `target`, and say whether it still has somewhere to go. */
  readonly advance: (id: string, target: number, now: number) => { value: number; done: boolean }
  /** Drop ramps for things that no longer exist. */
  readonly prune: (keep: ReadonlySet<string>) => void
}

/**
 * A set of ramps, keyed by whatever the caller is fading.
 *
 * `startAt` decides what an unseen ramp is worth on its first frame. `'zero'` makes everything
 * arrive, which is right for the thing itself. `'target'` starts settled, which is right for
 * anything drawn *inside* something that is already arriving — two ramps multiplied together take
 * twice as long to reach full and look like a slower fade rather than a composed one.
 */
export const ramps = ({ startAt = 'zero' }: { startAt?: 'zero' | 'target' } = {}): Ramps => {
  const fades = new Map<string, Fade>()

  const at = (fade: Fade, now: number): number => {
    return fade.from + (fade.to - fade.from) * fadeProgress(now - fade.since)
  }

  return {
    advance: (id, target, now) => {
      const existing = fades.get(id)
      if (existing === undefined) {
        const from = startAt === 'target' ? target : 0
        fades.set(id, { from, to: target, since: now })
        return { value: from, done: from === target }
      }
      const value = at(existing, now)
      if (existing.to !== target) {
        fades.set(id, { from: value, to: target, since: now })
        return { value, done: false }
      }
      return { value, done: (now - existing.since) / FADE_MS >= 1 }
    },
    prune: (keep) => {
      for (const id of [...fades.keys()]) if (!keep.has(id)) fades.delete(id)
    },
  }
}
