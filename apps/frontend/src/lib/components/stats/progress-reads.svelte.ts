import {
  type ArchiveHistory,
  DAY_SECONDS,
  HOUR_SECONDS,
  HOURLY_TILE_HISTORY_SECONDS,
  type ProgressSample,
  RAW_TILE_HISTORY_SECONDS,
} from '@caelestis/shared'
import { getArchiveHistory, getTemplateProgressHistory } from '#lib/api/client.js'
import { inProgressWindow } from '#lib/progress-window.js'
import { combineArchiveSamples } from './archive-history.js'
import { combineProgressSamples } from './progress-history.js'
import type { StatsScope } from './stats-scope.svelte.js'

/** Current counts stream separately; saved history needs only a slow refresh. */
const REFRESH_SECONDS = 5 * 60

/** Imported archive samples and saved canvas observations for a scope: the progress line. */
export class ProgressReads {
  archives = $state<readonly ArchiveHistory[] | null>(null)
  archiveError = $state<string | null>(null)
  samples = $state<readonly ProgressSample[] | null>(null)
  error = $state<string | null>(null)
  readonly contributionArchiveSamples = $derived(combineArchiveSamples(this.archives ?? []))
  readonly archiveSamples = $derived.by(() => {
    const windows = this.#scope.templates.map((template) => template.progressWindow)
    if (windows.every((window) => window?.start == null && window?.end == null))
      return this.contributionArchiveSamples
    return combineArchiveSamples(
      (this.archives ?? []).map((archive, index) => ({
        ...archive,
        samples: archive.samples.filter((sample) => inProgressWindow(sample.at, windows[index])),
      })),
      windows,
    )
  })
  readonly #scope: StatsScope

  constructor(scope: StatsScope) {
    this.#scope = scope
    $effect(() => {
      const templates = scope.templates.map(({ id, version }) => ({ id, version }))
      let cancelled = false
      this.archives = null
      this.archiveError = null
      // One template at a time bounds upstream concurrency for large folders.
      void (async () => {
        const results: ArchiveHistory[] = []
        for (const template of templates) {
          if (cancelled) return
          results.push(await getArchiveHistory(template.id, template.version))
        }
        if (!cancelled) this.archives = results
      })().catch(() => {
        if (cancelled) return
        this.archives = []
        this.archiveError = 'Imported progress history could not load.'
      })
      return () => {
        cancelled = true
      }
    })

    const to = $derived(
      scope.progressLive
        ? Math.floor(scope.progressTo / REFRESH_SECONDS) * REFRESH_SECONDS + 1
        : scope.progressTo,
    )
    let loadedScope: string | undefined
    $effect(() => {
      const templates = scope.templates
      const start = scope.progressFrom
      const end = to
      const key = templates
        .map(
          ({ id, version, progressWindow }) =>
            `${id}:${version}:${progressWindow?.start}:${progressWindow?.end}`,
        )
        .join(' ')
      if (loadedScope !== key) {
        loadedScope = key
        this.samples = null
        this.error = null
      }
      let cancelled = false
      void (async () => {
        const histories: (readonly ProgressSample[])[] = []
        for (const template of templates) {
          if (cancelled) return
          const notBefore = template.progressWindow?.start ?? undefined
          const from = Math.max(start, notBefore ?? 0)
          const to = Math.min(end, template.progressWindow?.end ?? Infinity)
          histories.push(from >= to ? [] : await readTiers(template.id, from, to, notBefore))
        }
        if (cancelled) return
        this.samples = combineProgressSamples(
          histories,
          templates.map((template) => template.progressWindow),
        )
        this.error = null
      })().catch(() => {
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
  notBefore?: number,
): Promise<readonly ProgressSample[]> => {
  const lifetime = await getTemplateProgressHistory(templateId, start, end, notBefore)
  const samples = new Map(lifetime.samples.map((sample) => [sample.at, sample]))
  for (const recentStart of [
    // A day inside the hourly tier's retention, on its grid.
    Math.floor((end - HOURLY_TILE_HISTORY_SECONDS + DAY_SECONDS) / HOUR_SECONDS) * HOUR_SECONDS,
    // Inside the raw day by more than `end` can trail the server's clock.
    end - RAW_TILE_HISTORY_SECONDS + 10 * 60,
  ]) {
    if (start >= recentStart) continue
    const recent = await getTemplateProgressHistory(templateId, recentStart, end, notBefore)
    let covered = false
    for (const sample of recent.samples) {
      if (sample.correct !== null) covered = true
      // Only the leading unknowns lack the state carried by the lifetime read.
      if (covered) samples.set(sample.at, sample)
    }
  }
  return [...samples.values()].sort((a, b) => a.at - b.at)
}
