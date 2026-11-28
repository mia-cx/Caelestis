import {
  type ArchiveHistory,
  DAY_SECONDS,
  HOUR_SECONDS,
  HOURLY_TILE_HISTORY_SECONDS,
  type ProgressSample,
  RAW_TILE_HISTORY_SECONDS,
} from '@caelestis/shared'
import { getArchiveHistory, getTemplateProgressHistory } from '#lib/api/client.js'
import { combineArchiveSamples } from './archive-history.js'
import { combineProgressSamples } from './progress-history.js'
import type { StatsScope } from './stats-scope.svelte.js'

/** Current counts stream separately; saved history needs only a slow refresh. */
const REFRESH_SECONDS = 5 * 60

/** Bound per-folder fan-out so large folders load concurrently without saturating the backend. */
const ARCHIVE_CONCURRENCY = 6
const PROGRESS_TEMPLATE_CONCURRENCY = 4

const mapConcurrent = async <T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
  cancelled: () => boolean,
): Promise<readonly R[]> => {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (!cancelled()) {
      const index = next++
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      results[index] = await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

/** Imported archive samples and saved canvas observations for a scope: the progress line. */
export class ProgressReads {
  archives = $state<readonly ArchiveHistory[] | null>(null)
  archiveError = $state<string | null>(null)
  samples = $state<readonly ProgressSample[] | null>(null)
  error = $state<string | null>(null)
  readonly archiveSamples = $derived(combineArchiveSamples(this.archives ?? []))

  constructor(scope: StatsScope) {
    $effect(() => {
      const templates = scope.templates.map(({ id, version }) => ({ id, version }))
      let cancelled = false
      this.archives = null
      this.archiveError = null
      void mapConcurrent(
        templates,
        ARCHIVE_CONCURRENCY,
        (template) => getArchiveHistory(template.id, template.version),
        () => cancelled,
      )
        .then((results) => {
          if (!cancelled) this.archives = results
        })
        .catch(() => {
          if (cancelled) return
          this.archives = []
          this.archiveError = 'Imported progress history could not load.'
        })
      return () => {
        cancelled = true
      }
    })

    const to = $derived(
      scope.live ? Math.floor(scope.to / REFRESH_SECONDS) * REFRESH_SECONDS + 1 : scope.to,
    )
    let loadedScope: string | undefined
    $effect(() => {
      const templates = scope.templates.map(({ id, version }) => ({ id, version }))
      const start = scope.from
      const end = to
      if (loadedScope !== scope.key) {
        loadedScope = scope.key
        this.samples = null
        this.error = null
      }
      let cancelled = false
      void mapConcurrent(
        templates,
        PROGRESS_TEMPLATE_CONCURRENCY,
        (template) => readTiers(template.id, start, end),
        () => cancelled,
      )
        .then((histories) => {
          if (cancelled) return
          this.samples = combineProgressSamples(histories)
          this.error = null
        })
        .catch(() => {
          if (cancelled) return
          this.samples ??= []
          this.error = 'Saved progress history could not load.'
        })
      return () => {
        cancelled = true
      }
    })
  }
}

/**
 * A lifetime read can be daily. The server keeps hourly measurements for a week and every
 * measurement for a day, so short pace windows read those finer tiers too.
 */
const readTiers = async (
  templateId: string,
  start: number,
  end: number,
): Promise<readonly ProgressSample[]> => {
  const recentStarts = [
    // A day inside the hourly tier's retention, on its grid.
    Math.floor((end - HOURLY_TILE_HISTORY_SECONDS + DAY_SECONDS) / HOUR_SECONDS) * HOUR_SECONDS,
    // Inside the raw day by more than `end` can trail the server's clock.
    end - RAW_TILE_HISTORY_SECONDS + 10 * 60,
  ].filter((recentStart) => start < recentStart)
  const [lifetime, ...recents] = await Promise.all([
    getTemplateProgressHistory(templateId, start, end),
    ...recentStarts.map((recentStart) => getTemplateProgressHistory(templateId, recentStart, end)),
  ])
  const samples = new Map(lifetime.samples.map((sample) => [sample.at, sample]))
  for (const recent of recents) {
    let covered = false
    for (const sample of recent.samples) {
      if (sample.correct !== null) covered = true
      // Only the leading unknowns lack the state carried by the lifetime read.
      if (covered) samples.set(sample.at, sample)
    }
  }
  return [...samples.values()].sort((a, b) => a.at - b.at)
}
