import type {
  ContributionDay,
  LeaderboardEntry,
  PainterIdentity,
  WplaceUserId,
} from '@caelestis/shared'
import { untrack } from 'svelte'
import { getContributions, getLeaderboard } from '#lib/api/client.js'
import { useApp } from '#lib/state/app.svelte.js'
import { DAY_SECONDS, type StatsScope } from './stats-scope.svelte.js'

/** The heatmap draws up to a year of weeks, and that is all the contribution read is for. */
const CONTRIBUTION_SECONDS = DAY_SECONDS * 7 * 53
/** The same length whether the leaderboard streams or polls. */
export const LEADERBOARD_LIMIT = 100

/** A painter in a contribution history, with everything they placed in it. */
export interface ContributionPainter extends PainterIdentity {
  readonly placed: number
}

/**
 * Everyone in a contribution history, most pixels placed first, each under the latest name they
 * reported. Keyed by Wplace id, so a rename or a namesake never merges or splits a painter.
 */
export const contributionPainters = (days: readonly ContributionDay[]): ContributionPainter[] => {
  const painters = new Map<WplaceUserId, ContributionPainter & { named: number }>()
  for (const day of days) {
    const known = painters.get(day.wplaceUserId)
    const rename = day.displayName !== '' && (known === undefined || day.day >= known.named)
    painters.set(day.wplaceUserId, {
      wplaceUserId: day.wplaceUserId,
      displayName: rename ? day.displayName : (known?.displayName ?? ''),
      named: rename ? day.day : (known?.named ?? Number.NEGATIVE_INFINITY),
      placed: (known?.placed ?? 0) + day.placed,
    })
  }
  return [...painters.values()]
    .sort((a, b) => b.placed - a.placed || a.wplaceUserId - b.wplaceUserId)
    .map(({ wplaceUserId, displayName, placed }) => ({ wplaceUserId, displayName, placed }))
}

/** Contributions and the leaderboard for a scope: streamed on a live connection, polled otherwise. */
export class Community {
  contributions = $state<readonly ContributionDay[] | null>(null)
  leaderboard = $state<readonly LeaderboardEntry[] | null>(null)
  /** Everyone in the contributions: the heatmap's painter filter lists them. */
  readonly painters = $derived(contributionPainters(this.contributions ?? []))
  /** Whose contributions the heatmap shows, by Wplace id; null is everyone. */
  painter = $state<number | null>(null)
  /** One painter's view holds only their reported rows: imported estimates have no painter. */
  readonly shownContributions = $derived(
    this.painter === null
      ? this.contributions
      : (this.contributions?.filter((day) => day.wplaceUserId === this.painter) ?? null),
  )

  constructor(scope: StatsScope, season: () => number) {
    const app = useApp()
    let loadedScope: string | undefined
    $effect(() => {
      const templateIds = scope.templateIds
      if (templateIds.length === 0) return
      this.contributions = null
      this.leaderboard = null
      const key = templateIds.join('\0')
      if (loadedScope !== key) {
        loadedScope = key
        this.painter = null
      }
      if (app.live) {
        return app.subscribeDashboard(
          {
            templateIds,
            contributionsFrom: untrack(() => scope.clock.now) - CONTRIBUTION_SECONDS,
            leaderboardLimit: LEADERBOARD_LIMIT,
          },
          (snapshot) => {
            this.contributions = snapshot.contributions.days
            this.leaderboard = snapshot.leaderboard.entries
          },
        )
      }
      let cancelled = false
      let pending = false
      $effect(() => {
        const now = scope.clock.now
        if (pending) return
        pending = true
        void Promise.all([
          getContributions(templateIds, now - CONTRIBUTION_SECONDS, now).then((response) => {
            if (!cancelled) this.contributions = response.days
          }),
          getLeaderboard(season(), { templateIds, limit: LEADERBOARD_LIMIT }).then((response) => {
            if (!cancelled) this.leaderboard = response.entries
          }),
        ])
          // A failed poll keeps the last answer; the next tick asks again.
          .catch(() => {})
          .finally(() => {
            pending = false
          })
      })
      return () => {
        cancelled = true
      }
    })
  }
}
