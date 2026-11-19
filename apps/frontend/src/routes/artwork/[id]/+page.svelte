<script lang="ts">
  import { boundsRect, canvasPixelToLatLng, folderPath, WORLD_PIXELS } from '@caelestis/shared'
  import { Icon, TemplateState } from '@caelestis/ui'
  import { page } from '$app/state'
  import ScopePage from '#lib/components/ScopePage.svelte'
  import { useApp } from '#lib/state/app.svelte.js'

  const app = useApp()

  const entry = $derived(app.tree?.templateById.get(page.params.id ?? '') ?? null)
  const scope = $derived.by(() => {
    if (entry === null || app.tree === null) return null
    const { template } = entry
    return {
      title: template.name,
      ancestors:
        template.nodeId === null
          ? []
          : folderPath(app.tree, template.nodeId).map((folder) => folder.node),
      templates: [template],
      progress: entry.progress,
      colours: entry.colours,
      griefWatch: entry.alarm !== undefined,
    }
  })
  const rect = $derived(entry === null ? null : boundsRect(entry.template.bbox))

  // Deep link to the artwork on the live canvas, centred on the bbox.
  const wplaceUrl = $derived.by(() => {
    if (rect === null) return null
    const { lat, lng } = canvasPixelToLatLng({
      x: Math.floor(rect.x + rect.width / 2) % WORLD_PIXELS,
      y: Math.floor(rect.y + rect.height / 2),
    })
    return `https://wplace.live/?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&zoom=13`
  })
</script>

<ScopePage {scope}>
  {#snippet notFound()}
    <p class="font-semibold">Template not found</p>
    <p class="mt-1 text-sm">It may have been deleted or unpublished.</p>
  {/snippet}
  {#snippet header()}
    {#if entry !== null && rect !== null}
      {@const { template, alarm } = entry}
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
          {rect.width}×{rect.height}
          at ({template.bbox.minX}, {template.bbox.minY})
        </span>
        {#if wplaceUrl !== null}
          <a href={wplaceUrl} target="_blank" rel="noreferrer" class="btn btn-xs btn-outline gap-1 rounded-lg">
            <Icon name="popout" class="size-4.5" /> View on wplace
          </a>
        {/if}
      </header>
    {/if}
  {/snippet}
</ScopePage>
