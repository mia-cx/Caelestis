<script lang="ts">
  import type { Progress, Template } from '@caelestis/shared'
  import Select from '#lib/components/Select.svelte'
  import { STORAGE_KEYS } from '#lib/deployment.js'
  import { persisted } from '#lib/persisted.svelte.js'
  import { useApp } from '#lib/state/app.svelte.js'
  import { ActivityReads } from './activity-reads.svelte.js'
  import { archiveContributionDays } from './archive-history.js'
  import { Community } from './community.svelte.js'
  import { completionPace } from './completion-pace.js'
  import ContributionHeatmap from './ContributionHeatmap.svelte'
  import Leaderboard from './Leaderboard.svelte'
  import { PaceSelection } from './pace-selection.svelte.js'
  import PainterFilter from './PainterFilter.svelte'
  import { mergeObservedProgress } from './progress-history.js'
  import { ProgressReads } from './progress-reads.svelte.js'
  import ProgressPaceChart, { CHART_HEIGHT } from './ProgressPaceChart.svelte'
  import { DAY_SECONDS, StatsScope } from './stats-scope.svelte.js'

  let {
    templates,
    progress,
    playhead = null,
    onSeek,
    onScrubStart,
  }: {
    /** Every new list reads history again, so pass a new one only when the scope changes. */
    templates: readonly Template[]
    /** The scope's current counts: the chart's right edge and the pixels still to paint. */
    progress: Progress
    /** The page's timelapse position, when it has one, for the chart to draw as a playhead. */
    playhead?: number | null
    /** Lets the chart seek that timelapse. Scopes without one leave it unset. */
    onSeek?: (t: number) => void
    /** Supplies cancellation rollback for the linked timelapse's playhead drag. */
    onScrubStart?: () => () => void
  } = $props()

  /** The grid an empty history's axis uses; it draws no buckets. */
  const EMPTY_HISTORY_RESOLUTION = 900

  const app = useApp()
  const scope = new StatsScope(() => templates)
  const reads = new ProgressReads(scope)
  const selection = new PaceSelection(() => activity.painters)
  const activity = new ActivityReads(scope, selection)
  const community = new Community(scope, () => app.manifest?.season ?? 0)

  const progressRevision = $derived(JSON.stringify(templates.map((template) => template.version)))
  const remainingPixels = $derived(progress.total - progress.completed)
  const displayFrom = $derived(
    Math.min(scope.from, ...reads.archiveSamples.map((sample) => sample.at)),
  )
  const importedContributions = $derived(
    archiveContributionDays(
      reads.archiveSamples,
      Math.min(...(activity.buckets ?? []).map((bucket) => bucket.bucketStart)),
    ),
  )
  /** Every observation once, ending with the current counts at the right edge. */
  const observations = $derived(
    reads.samples === null
      ? null
      : mergeObservedProgress(reads.archiveSamples, reads.samples, {
          at: scope.to,
          correct: progress.completed,
          mismatched: progress.mismatched,
          revision: progressRevision,
        }),
  )

  const estimatePeriods = [
    { key: '1d', seconds: DAY_SECONDS, label: 'last day' },
    { key: '3d', seconds: 3 * DAY_SECONDS, label: 'last 3 days' },
    { key: '7d', seconds: 7 * DAY_SECONDS, label: 'last 7 days' },
    { key: '30d', seconds: 30 * DAY_SECONDS, label: 'last 30 days' },
    { key: '1y', seconds: 365 * DAY_SECONDS, label: 'last year' },
    { key: 'all', seconds: null, label: 'all' },
  ] as const
  const storedEstimatePeriod = persisted<string>(STORAGE_KEYS.estimatePeriod, '7d')
  const estimatePeriod = $derived(
    estimatePeriods.find((period) => period.key === storedEstimatePeriod.value) ??
      estimatePeriods[2],
  )
  const pace = $derived(
    reads.archives === null || observations === null
      ? null
      : completionPace(observations, scope.to, estimatePeriod.seconds),
  )
  const eta = $derived(
    pace === null || pace.correct <= 0 || remainingPixels <= 0
      ? null
      : (remainingPixels / pace.correct) * 3_600,
  )

  const formatEta = (seconds: number): string => {
    if (seconds < 3_600 * 36) return `~${Math.max(1, Math.round(seconds / 3_600))} h`
    if (seconds >= DAY_SECONDS * 365) return `~${(seconds / (DAY_SECONDS * 365)).toLocaleString(undefined, { maximumFractionDigits: 1 })} y`
    return `~${Math.round(seconds / DAY_SECONDS)} d`
  }
</script>

<div class="flex flex-col gap-4">
  <section class="pixel-card bg-base-100 p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-semibold">Progress &amp; pace</h2>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-base-content/60">
        <span class="font-medium text-base-content">
          {#if remainingPixels <= 0 && progress.total > 0}
            Complete
          {:else if eta !== null}
            Estimated completion in {formatEta(eta)}
          {:else}
            Completion estimate unavailable
          {/if}
        </span>
        <span class="inline-flex items-center gap-2">
          <span id="estimate-period-label">based on</span>
          <Select
            value={estimatePeriod.key}
            options={estimatePeriods}
            onValueChange={(key) => { storedEstimatePeriod.value = key }}
            labelledby="estimate-period-label"
          />
        </span>
      </div>
    </div>
    {#if activity.failed}
      <div class="flex items-center justify-center text-sm text-base-content/50" style:height="{CHART_HEIGHT}px">
        Could not load pace history.
      </div>
    {:else if activity.buckets === null || reads.archives === null || observations === null}
      <div class="skeleton w-full" style:height="{CHART_HEIGHT}px"></div>
    {:else}
      <ProgressPaceChart
        samples={observations}
        buckets={activity.buckets}
        resolution={activity.buckets[0]?.resolution ?? EMPTY_HISTORY_RESOLUTION}
        from={displayFrom}
        to={scope.to}
        live={scope.live}
        paces={selection}
        painters={activity.painters}
        painterHistories={activity.painterHistories}
        {playhead}
        {onSeek}
        {onScrubStart}
      />
    {/if}
    {#if reads.archiveError}<p class="mt-2 text-sm text-error" role="alert">{reads.archiveError}</p>{/if}
    {#if reads.error}<p class="mt-2 text-sm text-error" role="alert">{reads.error}</p>{/if}
  </section>

  <section class="pixel-card bg-base-100 p-4">
    <h2 class="mb-3 font-semibold">Leaderboard</h2>
    {#if community.leaderboard === null}
      <div class="skeleton h-40 w-full"></div>
    {:else}
      <Leaderboard entries={community.leaderboard} />
    {/if}
  </section>

  <section class="pixel-card bg-base-100 p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-semibold">Contributions</h2>
      {#if community.painters.length > 0}
        <div class="flex items-center gap-2 text-xs" role="group" aria-label="whose contributions">
          <span class="text-base-content/65">who</span>
          <PainterFilter
            options={community.painters}
            selected={community.painter}
            onSelect={(wplaceUserId) => { community.painter = wplaceUserId }}
          />
        </div>
      {/if}
    </div>
    {#if community.shownContributions === null}
      <div class="skeleton h-28 w-full"></div>
    {:else}
      <ContributionHeatmap
        days={community.shownContributions}
        imported={community.painter === null ? importedContributions : new Map()}
      />
    {/if}
  </section>
</div>
