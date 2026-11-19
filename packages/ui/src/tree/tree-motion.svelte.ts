import { tick } from 'svelte'
import { prefersReducedMotion, surfaceCloseDurationMs } from '../foundations/motion.js'
import type { TreeEntryModel } from './model.js'

/**
 * The rows nested under `key` in a flattened tree: the contiguous run of entries after `key`
 * whose depth is greater, stopping at the first sibling or shallower row. Expanding or
 * collapsing a row adds or removes exactly this run, so it is also the set of rows a
 * grow/shrink transition should touch.
 */
export const descendantKeys = (
  entries: readonly { key: string; depth: number }[],
  key: string,
): Set<string> => {
  const keys = new Set<string>()
  let depth: number | undefined
  for (const entry of entries) {
    if (depth === undefined) {
      if (entry.key === key) depth = entry.depth
      continue
    }
    if (entry.depth <= depth) break
    keys.add(entry.key)
  }
  return keys
}

type TreeToggle = {
  readonly key: string
  readonly descendants: Set<string>
  readonly leaving: readonly TreeEntryModel[]
}

/**
 * Grow and shrink for expand and collapse. `toggle` snapshots the toggled key, its descendant
 * keys, and the descendant rows themselves (covering collapse, whose rows leave the next model).
 * The next `entries` change consumes it: rows that left stay rendered (inert) until their exit
 * animation ends while rows that arrived animate in; anything else snaps — never a search, a
 * filter, a server refresh, a reorder, or the first render. Row animation is WAAPI rather than a
 * Svelte transition because each-item outros do not survive the userscript's constant model
 * stream inside the custom element. Create it while a component initialises.
 */
export class TreeMotion {
  /** Rows shrinking out of a consumed collapse; render them inert. */
  leaving = $state<ReadonlySet<string>>(new Set())
  /** Rows growing in from a consumed expand; render them collapsed until they animate. */
  entering = $state<ReadonlySet<string>>(new Set())
  #animating = $state.raw<TreeToggle | null>(null)
  #pending: TreeToggle | null = null
  #lastEntries: readonly TreeEntryModel[] | undefined
  /** Pre-change card rects for the grid FLIP, captured while the old layout is still in place. */
  #gridRects: Map<string, DOMRect> | null = null

  readonly #entries: () => readonly TreeEntryModel[]
  readonly #tree: () => HTMLElement | undefined
  readonly #grid: () => boolean

  constructor(
    entries: () => readonly TreeEntryModel[],
    tree: () => HTMLElement | undefined,
    grid: () => boolean,
  ) {
    this.#entries = entries
    this.#tree = tree
    this.#grid = grid
    $effect.pre(() => this.#consume(this.#entries()))
  }

  /** The entries plus any rows still shrinking out from the consumed collapse. */
  readonly visibleEntries = $derived.by(() => {
    const entries = this.#entries()
    const toggle = this.#animating
    const kept = toggle?.leaving.filter((entry) => this.leaving.has(entry.key)) ?? []
    if (toggle === null || kept.length === 0) return entries
    const index = entries.findIndex((entry) => entry.key === toggle.key)
    const merged = [...entries]
    merged.splice(index === -1 ? merged.length : index + 1, 0, ...kept)
    return merged
  })

  /** Call before asking the host to expand or collapse `key`. */
  toggle(key: string): void {
    const entries = this.#entries()
    const descendants = descendantKeys(entries, key)
    this.#pending = {
      key,
      descendants,
      leaving: entries.filter((entry) => entry.type === 'row' && descendants.has(entry.key)),
    }
  }

  #consume(entries: readonly TreeEntryModel[]): void {
    if (entries === this.#lastEntries) return
    const previous = this.#lastEntries
    this.#lastEntries = entries
    const toggle = this.#pending
    // Progress ticks rebuild entries every ~50ms; only a pending toggle earns the key-set work.
    if (toggle === null) return
    const previousKeys = new Set(previous?.map((entry) => entry.key) ?? [])
    const nextKeys = new Set(entries.map((entry) => entry.key))
    const changed = new Set(
      [...previousKeys, ...nextKeys].filter((key) => previousKeys.has(key) !== nextKeys.has(key)),
    )
    const descendants = descendantKeys(entries, toggle.key)
    // Content ticks (progress, refresh) keep the same keys — they must not consume the
    // toggle. A change elsewhere in the tree is unrelated, so the pending snapshot dies.
    const touched = [...changed].some((key) => toggle.descendants.has(key) || descendants.has(key))
    if (!touched) {
      if (changed.size > 0) this.#pending = null
      return
    }
    this.#pending = null
    this.#animating = toggle
    this.leaving = new Set(
      toggle.leaving.filter((entry) => !nextKeys.has(entry.key)).map((entry) => entry.key),
    )
    this.entering = new Set([...descendants].filter((key) => !toggle.descendants.has(key)))
    const grid = this.#grid()
    const tree = this.#tree()
    this.#gridRects =
      grid && tree !== undefined
        ? new Map(
            [...tree.querySelectorAll<HTMLElement>('[data-caelestis-tree-key]')].map((row) => [
              row.dataset.caelestisTreeKey ?? '',
              row.getBoundingClientRect(),
            ]),
          )
        : null
    // Leaving rows stay rendered until every toggle animation has finished or been cancelled.
    void tick()
      .then(() =>
        Promise.allSettled(
          (grid ? this.#animateGrid() : this.#animateRows()).map((animation) => animation.finished),
        ),
      )
      .then(() => {
        if (this.#animating !== toggle) return
        this.#animating = null
        this.leaving = new Set()
        this.entering = new Set()
      })
  }

  /** WAAPI grow/shrink for rows a user toggle added or removed; everything else snaps. */
  #animateRows(): Animation[] {
    const tree = this.#tree()
    if (prefersReducedMotion() || tree === undefined) return []
    const duration = surfaceCloseDurationMs(tree, '--caelestis-duration-fast')
    if (duration <= 0) return []
    const easing =
      getComputedStyle(tree).getPropertyValue('--caelestis-ease-smooth-out') || 'ease-out'
    // `.tree` is a gapped flex column, so a zero-height row still holds its share of the gap —
    // a negative block-start margin pulls that back or the list snaps by gap × rows.
    const rowGap = getComputedStyle(tree).rowGap
    return [...tree.querySelectorAll<HTMLElement>('.row.leaving, .row.entering')].map((row) => {
      // `.entering` collapses the row so it paints at zero — drop it before measuring; the
      // animation's fill still covers the first frame.
      const entering = row.classList.contains('entering')
      if (entering) row.classList.remove('entering')
      const style = getComputedStyle(row)
      const hidden = {
        height: '0px',
        minBlockSize: '0px',
        paddingTop: '0px',
        paddingBottom: '0px',
        marginBlockStart: `-${rowGap}`,
        opacity: 0,
        overflow: 'hidden',
      }
      const shown = {
        height: `${row.offsetHeight}px`,
        minBlockSize: style.minBlockSize,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        opacity: 1,
        overflow: 'hidden',
      }
      return row.animate(entering ? [hidden, shown] : [shown, hidden], {
        duration,
        easing,
        fill: 'both',
      })
    })
  }

  /**
   * Grid-mode counterpart: leaving cards pop out of flow at their old rect and fade/scale/blur
   * away; entering cards fade/scale/blur in on a stagger; everything else FLIPs so the grid
   * reflows without snapping.
   */
  #animateGrid(): Animation[] {
    const tree = this.#tree()
    const previous = this.#gridRects
    this.#gridRects = null
    if (prefersReducedMotion() || tree === undefined || previous === null) return []
    const style = getComputedStyle(tree)
    const duration = surfaceCloseDurationMs(tree, '--caelestis-duration-fast')
    if (duration <= 0) return []
    const stagger = surfaceCloseDurationMs(tree, '--caelestis-duration-stagger')
    const scale = Number.parseFloat(style.getPropertyValue('--caelestis-scale-large')) || 1
    const blur = Number.parseFloat(style.getPropertyValue('--caelestis-blur-small')) || 0
    const easing = style.getPropertyValue('--caelestis-ease-smooth-out') || 'ease-out'
    const treeBox = tree.getBoundingClientRect()
    const shown = { opacity: 1, scale: 1, filter: 'blur(0px)' }
    const hidden = { opacity: 0, scale, filter: `blur(${blur}px)` }
    let enteringIndex = 0
    const animations: Animation[] = []
    for (const row of tree.querySelectorAll<HTMLElement>('[data-caelestis-tree-key]')) {
      const key = row.dataset.caelestisTreeKey ?? ''
      const box = row.getBoundingClientRect()
      const before = previous.get(key)
      if (this.leaving.has(key)) {
        // Out of flow at the old spot so the grid reflows underneath it at once.
        if (before !== undefined) {
          Object.assign(row.style, {
            position: 'absolute',
            left: `${before.left - treeBox.left}px`,
            top: `${before.top - treeBox.top}px`,
            inlineSize: `${before.width}px`,
            blockSize: `${before.height}px`,
            margin: '0',
          })
        }
        animations.push(row.animate([shown, hidden], { duration, easing, fill: 'both' }))
      } else if (this.entering.has(key)) {
        const delay = Math.min(enteringIndex * stagger, duration)
        enteringIndex += 1
        animations.push(row.animate([hidden, shown], { duration, delay, easing, fill: 'both' }))
      } else if (before !== undefined) {
        const dx = before.left - box.left
        const dy = before.top - box.top
        if (dx !== 0 || dy !== 0) {
          animations.push(
            row.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
              duration,
              easing,
            }),
          )
        }
      }
    }
    return animations
  }
}
