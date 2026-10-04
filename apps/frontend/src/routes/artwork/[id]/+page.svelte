<script lang="ts">
  import { canvasPixelToLatLng } from '@caelestis/shared'
  import { Icon, MenuStyles, ProgressMeter, TemplateState } from '@caelestis/ui'
  import { page } from '$app/state'
  import ColourProgress from '$lib/components/ColourProgress.svelte'
  import StatsPanel from '$lib/components/StatsPanel.svelte'
  import TimelapsePanel from '$lib/components/TimelapsePanel.svelte'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import { useApp } from '$lib/state/app.svelte'
  import { TimelapsePlayer } from '$lib/timelapse-player.svelte'
  import { progressFromStatus } from '$lib/tree'

  const app = useApp()

  const template = $derived(
    app.manifest?.templates.find((entry) => entry.id === page.params.id) ?? null,
  )
  const status = $derived(template === null ? undefined : app.statuses.get(template.id))
  const alarm = $derived(template === null ? undefined : app.alarms.get(template.id))
  const progress = $derived(template === null ? null : progressFromStatus(template, status))
  const folder = $derived(
    template?.nodeId == null
      ? null
      : (app.manifest?.nodes.find((node) => node.id === template.nodeId) ?? null),
  )

  // Deep link to the artwork on the live canvas, centred on the bbox.
  const wplaceUrl = $derived.by(() => {
    if (template === null) return null
    const { minX, minY, maxX, maxY } = template.bbox
    const { lat, lng } = canvasPixelToLatLng({
      x: Math.floor((minX + (maxX > minX ? maxX : maxX + 2_048_000)) / 2),
      y: Math.floor((minY + maxY) / 2),
    })
    return `https://wplace.live/?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&zoom=13`
  })

  const player = new TimelapsePlayer(() => (template === null ? [] : [template]))
</script>

<MenuStyles />

<svelte:head>
  <title>{template === null ? 'Template' : template.name} · Caelestis</title>
</svelte:head>

{#if app.manifest === null}
  <div class="flex flex-col gap-4">
    <Skeleton class="h-8 w-64" />
    <Skeleton class="h-80 w-full rounded-2xl" />
  </div>
{:else if template === null || progress === null}
  <div class="rounded-2xl border-[1.5px] border-dashed border-base-300 p-10 text-center text-base-content/60">
    <p class="font-semibold">Template not found</p>
    <p class="mt-1 text-sm">It may have been deleted or unpublished.</p>
    <a href="/" class="btn btn-sm mt-4">Back to all templates</a>
  </div>
{:else}
  <div class="flex flex-col gap-4">
    <nav class="text-sm text-base-content/60" aria-label="breadcrumb">
      <a href="/" class="link link-hover">All templates</a>
      {#if folder !== null}
        <span aria-hidden="true"> / </span>
        <a href="/folder/{folder.id}" class="link link-hover">{folder.name}</a>
      {/if}
    </nav>

    <header class="flex flex-wrap items-baseline gap-x-4 gap-y-2">
      <h1 class="text-2xl font-bold">{template.name}</h1>
      {#if !template.published}
        <span class="badge badge-warning badge-sm">unpublished</span>
      {/if}
      <TemplateState
        finished={template.finished}
        frozen={template.timelapseFrozen}
        alarmKind={alarm?.kind}
        pixelsLost={alarm?.pixelsLost}
      />
      <span class="text-sm tabular-nums text-base-content/50">
        {template.totalPixels.toLocaleString()} px ·
        {template.bbox.maxX - template.bbox.minX}×{template.bbox.maxY - template.bbox.minY}
        at ({template.bbox.minX}, {template.bbox.minY})
      </span>
      {#if wplaceUrl !== null}
        <a href={wplaceUrl} target="_blank" rel="noreferrer" class="btn btn-xs btn-outline gap-1 rounded-lg">
          <Icon name="popout" class="size-4.5" /> View on wplace
        </a>
      {/if}
    </header>

    <ProgressMeter {progress} griefWatch={alarm !== undefined} />
    {#if progress.known < progress.total}
      <p class="-mt-2 text-xs text-base-content/50">
        {Math.round((progress.known / Math.max(1, progress.total)) * 100)}% of pixels scanned.
      </p>
    {/if}

    <TimelapsePanel {player} label={template.name} />

    <StatsPanel
      templates={[template]}
      season={app.manifest?.season ?? 0}
      liveDashboard={app.liveProtocol === 2}
      {progress}
      subscribeDashboard={app.subscribeDashboard}
      playhead={player.live ? null : player.playhead}
      onSeek={player.timeline.length > 0 ? player.seekTo : undefined}
      onScrubStart={player.beginScrub}
    />

    {#if status?.colours !== undefined && status.colours.length > 0}
      <section class="pixel-card bg-base-100 p-4">
        <h2 class="mb-3 font-semibold">Progress by colour</h2>
        <ColourProgress colours={status.colours} />
      </section>
    {/if}
  </div>
{/if}
