import { DAY_SECONDS, type Template } from '@caelestis/shared'

const TICK_MS = 15_000

const nowSeconds = (): number => Math.floor(Date.now() / 1_000)

/**
 * The panel's one clock: seconds since the epoch, advanced every 15 s while the page is visible and
 * again when it becomes visible. Polls and the chart's live edge follow it, so a hidden tab reads
 * nothing.
 */
class VisibleClock {
  now = $state(nowSeconds())

  constructor() {
    $effect(() => {
      const tick = (): void => {
        if (document.visibilityState === 'visible') this.now = nowSeconds()
      }
      const interval = setInterval(tick, TICK_MS)
      document.addEventListener('visibilitychange', tick)
      return () => {
        clearInterval(interval)
        document.removeEventListener('visibilitychange', tick)
      }
    })
  }
}

/** The templates a stats panel reads and the time range their history covers. */
export class StatsScope {
  readonly clock = new VisibleClock()
  readonly #read: () => readonly Template[]

  constructor(templates: () => readonly Template[]) {
    this.#read = templates
  }

  get templates(): readonly Template[] {
    return this.#read()
  }

  readonly templateIds = $derived(this.templates.map((template) => template.id))
  /** A day boundary, so every retained tier can return the bucket holding the first creation. */
  readonly from = $derived(
    Math.floor(
      Math.min(...this.templates.map((template) => template.createdAt / 1_000)) / DAY_SECONDS,
    ) * DAY_SECONDS,
  )
  /** Some template is still painted, so the range ends now and moves with the clock. */
  readonly live = $derived(this.templates.some((template) => template.finishedAt === null))
  /** Names the history the server holds for the scope: a loader starts over when it changes. */
  readonly key = $derived(
    `${this.templates.map((template) => `${template.id}:${template.version}`).join(' ')}@${this.from}`,
  )
  readonly to = $derived(
    this.live
      ? this.clock.now + 1
      : Math.floor(
          Math.max(...this.templates.map((template) => template.finishedAt ?? 0)) / 1_000,
        ) + 1,
  )
}
