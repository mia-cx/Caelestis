<script lang="ts">
  import { type ScopeChannel, TRACE } from '../colour.js'
  import DensityCanvas from './DensityCanvas.svelte'
  import { type Channels, combined, LEVELS, type Layer, paint, underLayer, WAVE_COLUMNS } from './scopes.js'

  /**
   * Level against image column, all channels overlaid or, as a parade, side by side. With two
   * images, the earlier stage draws neutral behind the later one.
   */
  let {
    channels,
    under,
    over,
    parade,
  }: {
    channels: readonly [ScopeChannel, ScopeChannel, ScopeChannel]
    under?: Channels | undefined
    over?: Channels | undefined
    parade: boolean
  } = $props()

  const GRID = [100, 75, 50, 25, 0]
  const rgb = ([r, g, b]: readonly number[]): string => `rgb(${r} ${g} ${b})`
  const pick = (grids: Channels, indices: readonly number[]): Float32Array[] =>
    indices.flatMap((index) => grids[index] ?? [])

  /** The layers for the given channels: the earlier stage neutral under the later one. */
  const layers = (indices: readonly number[]): Layer[] => {
    const coloured = (grids: Channels): Layer[] =>
      indices.flatMap((index) => {
        const density = grids[index]
        const channel = channels[index]
        return density === undefined || channel === undefined ? [] : [{ density, colour: TRACE[channel.name] }]
      })
    const below = under ? (over ? [underLayer(combined(pick(under, indices)))] : coloured(under)) : []
    return [...below, ...(over ? coloured(over) : [])]
  }

  const plots = $derived(
    (parade ? [[0], [1], [2]] : [[0, 1, 2]]).map((indices) => ({
      indices,
      image: paint(WAVE_COLUMNS, LEVELS, layers(indices)),
    })),
  )
</script>

<div class="waveform">
  <div class="scale" aria-hidden="true">
    {#each GRID as label (label)}<span>{label}</span>{/each}
  </div>
  <div class="plots" style:grid-template-columns="repeat({plots.length}, 1fr)">
    {#each plots as plot (plot.indices.join())}
      <div class="plot" role="img" aria-label="{plot.indices.map((index) => channels[index]?.label).join(', ')} waveform">
        <DensityCanvas image={plot.image} />
        <svg viewBox="0 0 1 100" preserveAspectRatio="none">
          {#each GRID as line (line)}
            <line x2="1" y1={100 - line} y2={100 - line} class="grid" vector-effect="non-scaling-stroke" />
          {/each}
        </svg>
        <div class="labels">
          {#each plot.indices as index (index)}
            {@const channel = channels[index]}
            {#if channel !== undefined}<span style:color={rgb(TRACE[channel.name])}>{channel.label}</span>{/if}
          {/each}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .waveform { display: flex; gap: 0.375rem; block-size: 100%; }
  .scale { display: flex; flex-direction: column; justify-content: space-between; color: rgb(255 255 255 / 0.45); font-size: 0.625rem; line-height: 1; text-align: end; font-variant-numeric: tabular-nums; }
  .scale span { margin-block: -0.3em; }
  .plots { display: grid; flex: 1; gap: 1px; background: rgb(255 255 255 / 0.1); }
  .plot { position: relative; background: black; }
  svg { position: absolute; inset: 0; inline-size: 100%; block-size: 100%; }
  .grid { stroke: rgb(255 255 255 / 0.12); }
  .labels { position: absolute; inset-block-start: 0.25rem; inset-inline-end: 0.375rem; display: flex; gap: 0.5rem; font-size: 0.6875rem; font-weight: 600; }
</style>
