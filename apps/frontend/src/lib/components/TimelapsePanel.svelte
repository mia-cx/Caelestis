<script lang="ts">
  import { Icon, TemplateState } from '@caelestis/ui'
  import TemplateViewer from '$lib/components/TemplateViewer.svelte'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import { Slider } from '$lib/components/ui/slider'
  import { persisted } from '$lib/persisted.svelte'
  import { MIN_SPEED, speedToFit } from '$lib/timelapse'
  import type { TimelapsePlayer } from '$lib/timelapse-player.svelte'

  let {
    player,
    label,
  }: {
    player: TimelapsePlayer
    /** Names the artwork for the viewer's accessible label. */
    label: string
  } = $props()
  const uid = $props.id()

  // The canvas as it is comes first; the template art is opt-in via the slider.
  const storedOverlay = persisted<number>('caelestis:overlay-alpha', 0)
  const overlayAlpha = $derived(Math.min(1, Math.max(0, storedOverlay.value)))

  const finished = $derived(player.templates.every((template) => template.finished))
  const frozen = $derived(player.templates.every((template) => template.timelapseFrozen))

  const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4] as const
  /** Presets that play the whole recorded history in a fixed time, whatever its length. */
  const HISTORY_FITS = [
    { label: '10 s', ms: 10_000 },
    { label: '30 s', ms: 30_000 },
    { label: '1 min', ms: 60_000 },
  ] as const
  const fits = $derived(
    HISTORY_FITS.flatMap(({ label, ms }) => {
      const speed = speedToFit(player.span, ms)
      return speed === null ? [] : [{ label, speed }]
    }),
  )

  // Compact notation stops at trillions, so enormous custom speeds switch to scientific.
  const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 })
  const scientific = new Intl.NumberFormat(undefined, {
    notation: 'scientific',
    maximumFractionDigits: 1,
  })
  const formatSpeed = (speed: number): string =>
    `${(speed < 1e15 ? compact : scientific).format(speed)}×`

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
          class="btn btn-sm btn-ghost min-w-14 tabular-nums"
          aria-label="playback speed, currently {formatSpeed(player.speed)}"
        >
          {formatSpeed(player.speed)}
        </button>
        <div
          class="caelestis-menu dropdown-content pointer-events-none z-20 mb-1 flex w-64 flex-col gap-3 group-focus-within:pointer-events-auto"
        >
          <label class="input input-sm w-full text-base tabular-nums sm:text-sm">
            <!-- Commit on change, not input, so clearing the field to type a new value keeps playing. -->
            <input
              type="number"
              inputmode="decimal"
              min={MIN_SPEED}
              step="any"
              value={player.speed}
              onchange={(event) => {
                player.setSpeed(event.currentTarget.valueAsNumber)
                event.currentTarget.value = String(player.speed)
              }}
              aria-label="playback speed"
            />
            <span class="text-base-content/70">×</span>
          </label>
          <div class="grid grid-cols-4 gap-1">
            {#each SPEED_PRESETS as preset (preset)}
              <button
                class="btn btn-xs {player.speed === preset ? 'btn-primary' : 'btn-ghost'} tabular-nums"
                onclick={() => player.setSpeed(preset)}
              >
                {formatSpeed(preset)}
              </button>
            {/each}
          </div>
          {#if fits.length > 0}
            <div class="flex flex-col gap-1" role="group" aria-labelledby="{uid}-fits">
              <span id="{uid}-fits" class="text-xs text-base-content/70">Whole history in</span>
              <div class="grid grid-cols-3 gap-1">
                {#each fits as fit (fit.label)}
                  <button
                    class="btn btn-xs {player.speed === fit.speed ? 'btn-primary' : 'btn-ghost'}"
                    title={formatSpeed(fit.speed)}
                    onclick={() => player.setSpeed(fit.speed)}
                  >
                    {fit.label}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
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
