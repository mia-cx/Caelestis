<script lang="ts">
  import { Icon, TemplateState } from '@caelestis/ui'
  import TemplateViewer from '$lib/components/TemplateViewer.svelte'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import { Slider } from '$lib/components/ui/slider'
  import { persisted } from '$lib/persisted.svelte'
  import type { TimelapsePlayer } from '$lib/timelapse-player.svelte'

  let {
    player,
    label,
  }: {
    player: TimelapsePlayer
    /** Names the artwork for the viewer's accessible label. */
    label: string
  } = $props()

  // The canvas as it is comes first; the template art is opt-in via the slider.
  const storedOverlay = persisted<number>('caelestis:overlay-alpha', 0)
  const overlayAlpha = $derived(Math.min(1, Math.max(0, storedOverlay.value)))

  const finished = $derived(player.templates.every((template) => template.finished))
  const frozen = $derived(player.templates.every((template) => template.timelapseFrozen))

  const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4] as const

  const formatFrame = (t: number): string =>
    new Date(t * 1000).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
</script>

{#if player.archiveError}<p class="text-sm text-error" role="alert">{player.archiveError}</p>{/if}

<section class="overflow-hidden pixel-card bg-base-100">
  <TemplateViewer
    layout={player.layout}
    {label}
    hashFor={player.hashFor}
    {overlayAlpha}
    class="h-[28rem] w-full"
  />

  <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-t-[1.5px] border-base-300 px-4 py-3">
    <span class="shrink-0 text-sm text-base-content/70">Template overlay</span>
    <Slider
      type="single"
      min={0}
      max={1}
      step={0.05}
      value={overlayAlpha}
      onValueChange={(value: number) => (storedOverlay.value = value)}
      class="max-w-44 flex-1"
      aria-label="template overlay opacity"
    />
    <span class="w-9 text-end text-xs tabular-nums text-base-content/50">
      {Math.round(overlayAlpha * 100)}%
    </span>
  </div>

  <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t-[1.5px] border-base-300 px-4 py-3">
    {#if player.frames === null}
      <Skeleton class="h-6 w-full" />
    {:else if player.timeline.length === 0}
      <span class="text-sm text-base-content/50">
        No tile snapshots yet. New snapshots appear after the next six-hour canvas scan.
      </span>
    {:else}
      <button
        class="btn btn-sm btn-circle btn-primary"
        onclick={() => player.toggle()}
        aria-label={player.playing ? 'pause timelapse' : 'play timelapse'}
      >
        {#if player.playing}<Icon name="pause" class="size-4.5" />{:else}<Icon name="play" class="size-4.5" />{/if}
      </button>
      <div class="dropdown dropdown-top group">
        <button
          tabindex="0"
          class="btn btn-sm btn-ghost w-14 tabular-nums"
          aria-label="playback speed, currently {player.speed.toFixed(2)}×"
        >
          {player.speed.toFixed(2).replace(/0$/, '')}×
        </button>
        <div
          class="caelestis-menu dropdown-content pointer-events-none z-20 mb-1 flex w-64 flex-col gap-3 group-focus-within:pointer-events-auto"
        >
          <div class="flex items-center gap-2">
            <Slider
              type="single"
              min={0.05}
              max={4}
              step={0.05}
              value={player.speed}
              onValueChange={(value: number) => player.setSpeed(value)}
              class="flex-1"
              aria-label="playback speed"
            />
            <span class="w-12 text-end text-xs tabular-nums text-base-content/70">
              {player.speed.toFixed(2)}×
            </span>
          </div>
          <div class="grid grid-cols-4 gap-1">
            {#each SPEED_PRESETS as preset (preset)}
              <button
                class="btn btn-xs {player.speed === preset ? 'btn-primary' : 'btn-ghost'} tabular-nums"
                onclick={() => player.setSpeed(preset)}
              >
                {preset}×
              </button>
            {/each}
          </div>
        </div>
      </div>
      <Slider
        type="single"
        min={0}
        max={player.transport.steps}
        step={1}
        value={player.transport.toStep(player.playhead)}
        onValueChange={(step: number) => player.seekTo(player.transport.toTime(step))}
        class="min-w-40 flex-1"
        aria-label="timelapse position"
        aria-valuetext={formatFrame(player.playhead)}
        data-playhead={player.playhead}
      />
      <span class="w-32 shrink-0 text-end text-xs tabular-nums text-base-content/70">
        {#if player.live}
          <span class="badge badge-success badge-xs align-middle">{finished ? 'current' : 'live'}</span>
        {:else if player.scrubTime != null}
          {formatFrame(player.playhead)}
        {/if}
      </span>
    {/if}
  </div>
  {#if frozen}
    <div class="border-t-[1.5px] border-base-300 px-4 py-2">
      <TemplateState compact frozen />
    </div>
  {/if}
</section>
