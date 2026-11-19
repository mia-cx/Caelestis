import {
  type HistoryBucket,
  type HistoryResponse,
  HOUR_SECONDS,
  type PainterHistoryResponse,
  type PainterTotal,
} from '@caelestis/shared'
import { untrack } from 'svelte'
import { getHistory, getPainterHistory, getPainterTotals } from '#lib/api/client.js'
import { type HeldHistory, refreshHistory } from './history-tail.js'
import { maxPaceResolution } from './pace-model.js'
import { MAX_PAINTER_OPTIONS, type PaceSelection } from './pace-selection.svelte.js'
import { PACE_WINDOWS, type PainterHistorySource } from './progress-pace.js'
import type { StatsScope } from './stats-scope.svelte.js'

/**
 * Each tick reads only the buckets that can still change. An hourly full read lets the server choose
 * a tier for the grown range again and picks up writes delayed past that window.
 */
const FULL_READ_SECONDS = HOUR_SECONDS
/** Who painted is one bounded list per scope, summed by the server, refreshed on its own slow clock. */
const PAINTERS_REFRESH_SECONDS = 5 * 60

const fullReadKey = (scope: string, end: number): string =>
  `${scope}:${Math.floor(end / FULL_READ_SECONDS)}`

/** Placement history for a scope: the template buckets, who painted, and the chosen painters' lines. */
export class ActivityReads {
  buckets = $state<readonly HistoryBucket[] | null>(null)
  failed = $state(false)
  /** Who painted in the scope, leading first: the picker's list and the source of the default set. */
  painters = $state<readonly PainterTotal[]>([])
  /** The selected painters' retained tiers for each enabled rolling window. */
  painterHistories = $state<readonly PainterHistorySource[]>([])

  constructor(scope: StatsScope, selection: PaceSelection) {
    let held: HeldHistory<HistoryResponse> | null = null
    let loadedScope: string | undefined
    $effect(() => {
      const ids = scope.templateIds
      if (ids.length === 0) return
      const { from, to, key } = scope
      let cancelled = false
      if (loadedScope !== key) {
        loadedScope = key
        this.buckets = null
      }
      this.failed = false
      refreshHistory(held, fullReadKey(key, to), from, to, (start, maxResolution) =>
        getHistory(ids, start, to, maxResolution === undefined ? {} : { maxResolution }),
      )
        .then((next) => {
          if (cancelled) return
          held = next
          this.buckets = next.read.buckets
        })
        .catch(() => {
          if (!cancelled) this.failed = true
        })
      return () => {
        cancelled = true
      }
    })

    let painterScope: string | undefined
    const paintersTick = $derived(Math.floor(scope.clock.now / PAINTERS_REFRESH_SECONDS))
    $effect(() => {
      const ids = scope.templateIds
      if (ids.length === 0) return
      const { from, key } = scope
      void paintersTick
      let cancelled = false
      if (painterScope !== key) {
        painterScope = key
        this.painters = []
        this.painterHistories = []
        selection.resetPainters()
      }
      getPainterTotals(ids, from, untrack(() => scope.clock.now) + 1, {
        limit: MAX_PAINTER_OPTIONS,
      })
        .then((response) => {
          if (!cancelled) this.painters = response.painters
        })
        // A server without painter buckets still draws the template lines.
        .catch(() => {})
      return () => {
        cancelled = true
      }
    })

    // Painter lines read the same ladder as the template lines: one retained tier per enabled
    // rolling window, for the selected painters only. A window nobody enabled and a painter nobody
    // chose are never fetched, so a crowded server pays for what it draws.
    const heldPainterHistories = new Map<string, HeldHistory<PainterHistoryResponse>>()
    $effect(() => {
      const ids = scope.templateIds
      if (ids.length === 0) return
      const chosen = [...selection.painters]
      if (chosen.length === 0) {
        this.painterHistories = []
        return
      }
      const { from, to } = scope
      let cancelled = false
      const key = `${scope.key}:${chosen.join(',')}`
      Promise.all(
        PACE_WINDOWS.filter((window) => selection.windows.has(window.key)).map(
          async (window): Promise<PainterHistorySource | null> => {
            try {
              const next = await refreshHistory(
                heldPainterHistories.get(window.key) ?? null,
                fullReadKey(key, to),
                from,
                to,
                (start, maxResolution) =>
                  getPainterHistory(ids, chosen, start, to, {
                    maxResolution: maxResolution ?? maxPaceResolution(window.seconds),
                  }),
              )
              if (!cancelled) heldPainterHistories.set(window.key, next)
              return { window: window.key, history: next.read }
            } catch {
              // That window's painter lines are left out; the template lines still draw.
              return null
            }
          },
        ),
      ).then((responses) => {
        if (!cancelled) this.painterHistories = responses.filter((response) => response !== null)
      })
      return () => {
        cancelled = true
      }
    })
  }
}
