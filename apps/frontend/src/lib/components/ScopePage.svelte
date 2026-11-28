<script lang="ts">
  import type { ColourProgress as Colours, Node, Progress, Template } from '@caelestis/shared'
  import { ProgressMeter } from '@caelestis/ui'
  import { type Snippet, untrack } from 'svelte'
  import ColourProgress from '#lib/components/ColourProgress.svelte'
  import StatsPanel from '#lib/components/stats/StatsPanel.svelte'
  import TimelapsePanel from '#lib/components/TimelapsePanel.svelte'
  import { resolveProgressWindows } from '#lib/progress-window.js'
  import { pageTitle } from '#lib/server-info.js'
  import { useApp } from '#lib/state/app.svelte.js'
  import { TimelapsePlayer } from '#lib/timelapse-player.svelte.js'

  /** The page for one artwork or one folder: progress, timelapse, stats and colours of a scope. */
  let {
    scope,
    notFound,
    header,
    children,
  }: {
    /** Null while the scope is missing from the loaded tree. */
    scope: {
      readonly title: string
      /** Folders above the scope, root first. */
      readonly ancestors: readonly Node[]
      readonly templates: readonly Template[]
      readonly progress: Progress
      readonly colours: readonly Colours[] | undefined
      readonly griefWatch?: boolean
    } | null
    notFound: Snippet
    header: Snippet
    children?: Snippet
  } = $props()

  const app = useApp()
  const windows = $derived(app.manifest == null ? undefined : resolveProgressWindows(app.manifest))
  // Live statuses rebuild the scope's template list on every delta. The timelapse and the stats
  // get a new list, and read history again, only when a field they read can differ.
  const templatesKey = $derived(
    (scope?.templates ?? [])
      .map(
        (template) =>
          `${template.id}:${template.version}:${template.createdAt}:${template.finishedAt}:${template.finished}:${template.timelapseFrozen}:${windows?.get(template.id)?.start}:${windows?.get(template.id)?.end}`,
      )
      .join(' '),
  )
  const templates = $derived.by(() => {
    void templatesKey
    return untrack(() =>
      (scope?.templates ?? []).map((template) => {
        const window = windows?.get(template.id)
        return window === undefined ? template : { ...template, progressWindow: window }
      }),
    )
  })
  const player = new TimelapsePlayer({
    templates: () => templates,
    season: () => app.manifest?.season,
    canvas: () => app.canvas,
  })
</script>

<svelte:head>
  <title>{pageTitle(app.server?.name, scope?.title)}</title>
</svelte:head>

{#if app.tree === null}
  <div class="flex flex-col gap-4">
    <div class="skeleton h-8 w-64"></div>
    <div class="skeleton h-80 w-full rounded-2xl"></div>
  </div>
{:else if scope === null}
  <div class="rounded-2xl border-[1.5px] border-dashed border-base-300 p-10 text-center text-base-content/60">
    {@render notFound()}
    <a href="/" class="btn btn-sm mt-4">Back to all templates</a>
  </div>
{:else}
  {@const { progress } = scope}
  <div class="flex flex-col gap-4">
    <nav class="flex flex-wrap gap-x-1 text-sm text-base-content/60" aria-label="breadcrumb">
      <a href="/" class="link link-hover">All templates</a>
      {#each scope.ancestors as ancestor (ancestor.id)}
        <span aria-hidden="true">/</span>
        <a href="/folder/{ancestor.id}" class="link link-hover">{ancestor.name}</a>
      {/each}
      <span aria-hidden="true">/</span>
      <span>{scope.title}</span>
    </nav>

    {@render header()}

    {#if progress.total > 0}
      <ProgressMeter {progress} griefWatch={scope.griefWatch ?? false} />
      {#if progress.known < progress.total}
        <p class="-mt-2 text-xs text-base-content/50">
          {Math.round((progress.known / progress.total) * 100)}% of pixels scanned.
        </p>
      {/if}
    {:else}
      <p class="text-sm text-base-content/50">No published templates yet.</p>
    {/if}

    {#if templates.length > 0 && app.manifest !== null}
      <TimelapsePanel {player} label={scope.title} />
      <StatsPanel
        {templates}
        {progress}
        captureRange={player.captureRange}
        playhead={player.live ? null : player.playhead}
        onSeek={player.timeline.length > 0 ? player.seekTo : undefined}
        onScrubStart={player.beginScrub}
      />
    {/if}

    {#if scope.colours !== undefined}
      <section class="pixel-card bg-base-100 p-4">
        <h2 class="mb-3 font-semibold">Progress by colour</h2>
        <ColourProgress colours={scope.colours} />
      </section>
    {/if}

    {@render children?.()}
  </div>
{/if}
