<script lang="ts">
  import { Icon, TemplateState } from '@caelestis/ui'
  import TemplateViewer from '#lib/components/TemplateViewer.svelte'
  import { Persisted } from '#lib/persisted.svelte.js'
  import { STORAGE_KEYS } from '#lib/deployment.js'
  import { formatTime } from '#lib/time-format.js'
  import { MIN_SPEED, speedToFit } from '#lib/timelapse.js'
  import type { TimelapsePlayer } from '#lib/timelapse-player.svelte.js'

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
  const storedOverlay = new Persisted<number>(STORAGE_KEYS.overlayAlpha, 0)
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
    <input
      type="range"
      min={0}
      max={1}
      step={0.05}
      value={overlayAlpha}
      oninput={(event) => (storedOverlay.value = event.currentTarget.valueAsNumber)}
      class="slider max-w-44 flex-1"
      style:--fill="{overlayAlpha * 100}%"
      aria-label="template overlay opacity"
    />
    <span class="w-9 text-end text-xs tabular-nums text-base-content/50">
      {Math.round(overlayAlpha * 100)}%
    </span>
  </div>

  <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t-[1.5px] border-base-300 px-4 py-3">
    {#if player.frames === null}
      <div class="skeleton h-6 w-full"></div>
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
      <input
        type="range"
        min={0}
        max={player.transport.steps}
        step={1}
        value={player.transport.toStep(player.playhead)}
        oninput={(event) =>
          player.seekTo(player.transport.toTime(event.currentTarget.valueAsNumber))}
        class="slider min-w-40 flex-1"
        style:--fill="{(player.transport.toStep(player.playhead) / player.transport.steps) * 100}%"
        aria-label="timelapse position"
        aria-valuetext={formatTime(player.playhead)}
        data-playhead={player.playhead}
      />
      <span class="w-32 shrink-0 text-end text-xs tabular-nums text-base-content/70">
        {#if player.live}
          <span class="badge badge-success badge-xs align-middle">{finished ? 'current' : 'live'}</span>
        {:else if player.scrubTime != null}
          {formatTime(player.playhead)}
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

<style>
  /*
   * A thin track filled to --fill with a small outlined thumb, both with the pixel corners every
   * rounded-full shape takes. Chromium has no fill pseudo-element, so the fill is a gradient.
   */
  .slider {
    --track: 0.375rem;
    --thumb: 0.75rem;
    appearance: none;
    block-size: var(--thumb);
    background: transparent;
  }
  .slider:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  /* Chromium draws the thumb inside the track, so clipping the track would hide the thumb. */
  .slider::-webkit-slider-runnable-track {
    block-size: var(--track);
    background: linear-gradient(to right, var(--color-primary) var(--fill), var(--color-base-300) var(--fill));
  }
  .slider::-moz-range-track {
    block-size: var(--track);
    background: linear-gradient(to right, var(--color-primary) var(--fill), var(--color-base-300) var(--fill));
    clip-path: var(--pixel-corners-xs);
  }
  .slider::-webkit-slider-thumb {
    appearance: none;
    box-sizing: border-box;
    inline-size: var(--thumb);
    block-size: var(--thumb);
    margin-block-start: calc((var(--track) - var(--thumb)) / 2);
    border: 1px solid var(--color-primary);
    background: white;
    clip-path: var(--pixel-corners-xs);
  }
  .slider::-moz-range-thumb {
    box-sizing: border-box;
    inline-size: var(--thumb);
    block-size: var(--thumb);
    border: 1px solid var(--color-primary);
    border-radius: 0;
    background: white;
    clip-path: var(--pixel-corners-xs);
  }
</style>
