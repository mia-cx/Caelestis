<script lang="ts">
  import { type ScopeChannel, TRACE } from '../colour.js'
  import { type Channels, LEVELS } from './scopes.js'

  /**
   * One level plot per channel. With two images, the earlier stage draws neutral behind the
   * later one.
   */
  let {
    channels,
    under,
    over,
  }: {
    channels: readonly [ScopeChannel, ScopeChannel, ScopeChannel]
    under?: Channels | undefined
    over?: Channels | undefined
  } = $props()

  const HEIGHT = 100
  const QUARTERS = [0.25, 0.5, 0.75]
  const rgb = ([r, g, b]: readonly number[], alpha = 1): string => `rgb(${r} ${g} ${b} / ${alpha})`

  /** A filled step outline of `bins`, scaled so the fullest level reaches the top. */
  const area = (bins: Float32Array | undefined): string => {
    if (bins === undefined) return ''
    let peak = 0
    for (const weight of bins) peak = Math.max(peak, weight)
    if (!peak) return ''
    let path = `M0 ${HEIGHT}`
    bins.forEach((weight, level) => {
      path += `V${HEIGHT - (weight / peak) * HEIGHT}H${level + 1}`
    })
    return `${path}V${HEIGHT}Z`
  }
</script>

<div class="plots">
  {#each channels as channel, index (channel.name)}
    {@const colour = TRACE[channel.name]}
    <div class="plot">
      <svg viewBox="0 0 {LEVELS} {HEIGHT}" preserveAspectRatio="none" role="img" aria-label="{channel.label} histogram">
        {#each QUARTERS as quarter (quarter)}
          <line x1={quarter * LEVELS} x2={quarter * LEVELS} y2={HEIGHT} class="grid" vector-effect="non-scaling-stroke" />
        {/each}
        {#if under}
          <path
            d={area(under[index])}
            fill={over ? 'rgb(255 255 255 / 0.16)' : rgb(colour, 0.3)}
            stroke={over ? 'none' : rgb(colour, 0.9)}
            vector-effect="non-scaling-stroke"
          />
        {/if}
        {#if over}
          <path d={area(over[index])} fill={rgb(colour, 0.35)} stroke={rgb(colour)} vector-effect="non-scaling-stroke" />
        {/if}
      </svg>
      <span class="label" style:color={rgb(colour)}>{channel.label}</span>
    </div>
  {/each}
</div>

<style>
  .plots { display: grid; grid-template-rows: repeat(3, 1fr); gap: 1px; block-size: 100%; background: rgb(255 255 255 / 0.1); }
  .plot { position: relative; background: black; }
  svg { position: absolute; inset: 0; inline-size: 100%; block-size: 100%; }
  .grid { stroke: rgb(255 255 255 / 0.1); }
  .label { position: absolute; inset-block-start: 0.25rem; inset-inline-start: 0.375rem; font-size: 0.6875rem; font-weight: 600; }
</style>
