import type { PainterTotal, WplaceUserId } from '@caelestis/shared'
import { STORAGE_KEYS } from '#lib/deployment.js'
import { persisted } from '#lib/persisted.svelte.js'

/** How many leading painters a fresh chart draws before anyone touches the picker. */
const DEFAULT_VISIBLE_PAINTERS = 5
/** How many painters the panel asks the server to list; the route clamps to the same. */
export const MAX_PAINTER_OPTIONS = 500
/** How many painters may be drawn at once: the history route's `painters=` bound. */
export const MAX_SELECTED_PAINTERS = 50
const DEFAULT_WINDOWS = ['1h', '6h']

/** The coarsest bucket a rolling window can use: it needs at least two buckets. */
export const maxPaceResolution = (windowSeconds: number): number => windowSeconds / 2
export const paceWindowUsable = (windowSeconds: number, bucketSeconds: number): boolean =>
  bucketSeconds <= maxPaceResolution(windowSeconds)

/**
 * The next override map after toggling one painter, refusing to grow the selection past `max`
 * because `/painter-history` would refuse the request and every line would vanish with it.
 */
export const togglePainterSelection = (
  overrides: Readonly<Record<number, boolean>>,
  selected: ReadonlySet<number>,
  wplaceUserId: number,
  max = MAX_SELECTED_PAINTERS,
): Record<number, boolean> => {
  const shown = selected.has(wplaceUserId)
  if (!shown && selected.size >= max) return overrides
  return { ...overrides, [wplaceUserId]: !shown }
}

/** Set the entire picker selection in one update, within the history request limit. */
export const selectAllPainters = (
  options: readonly PainterTotal[],
  shown: boolean,
  max = MAX_SELECTED_PAINTERS,
): Record<number, boolean> =>
  Object.fromEntries(options.map((painter, index) => [painter.wplaceUserId, shown && index < max]))

/**
 * Which pace lines the chart draws: the rolling windows, everyone's lines, and which painters.
 * Windows and everyone's lines persist; painter choices last for the scope.
 */
export class PaceSelection {
  readonly #windows = persisted<string[]>(STORAGE_KEYS.paceWindows, DEFAULT_WINDOWS)
  readonly #allUsers = persisted<boolean>(STORAGE_KEYS.paceAllUsers, true)
  readonly #painters: () => readonly PainterTotal[]
  // The leading painters draw by default. The picker records an override per painter, so the
  // default set can shift with the data without undoing anyone's choices.
  #overrides = $state<Record<number, boolean>>({})

  constructor(painters: () => readonly PainterTotal[]) {
    this.#painters = painters
  }

  get #options(): readonly PainterTotal[] {
    return this.#painters()
  }

  readonly windows: ReadonlySet<string> = $derived(new Set(this.#windows.value))
  readonly allUsers = $derived(this.#allUsers.value !== false)
  readonly #defaults = $derived(
    new Set(
      this.#options.slice(0, DEFAULT_VISIBLE_PAINTERS).map((painter) => painter.wplaceUserId),
    ),
  )
  readonly painters: ReadonlySet<WplaceUserId> = $derived(
    new Set(
      this.#options
        .filter(
          (painter) =>
            this.#overrides[painter.wplaceUserId] ?? this.#defaults.has(painter.wplaceUserId),
        )
        .slice(0, MAX_SELECTED_PAINTERS)
        .map((painter) => painter.wplaceUserId),
    ),
  )

  toggleWindow = (key: string): void => {
    const next = new Set(this.#windows.value)
    if (!next.delete(key)) next.add(key)
    this.#windows.value = [...next]
  }

  toggleAllUsers = (): void => {
    this.#allUsers.value = !this.allUsers
  }

  togglePainter = (wplaceUserId: number): void => {
    this.#overrides = togglePainterSelection(this.#overrides, this.painters, wplaceUserId)
  }

  setAllPainters = (shown: boolean): void => {
    this.#overrides = selectAllPainters(this.#options, shown)
  }

  resetPainters(): void {
    this.#overrides = {}
  }
}
