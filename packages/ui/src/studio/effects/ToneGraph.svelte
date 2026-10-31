<script lang="ts">
  import { type Neutral, type ToneMap, tonePath } from './tone.js'

  /**
   * A read-only plot of how an effect maps input tone (x) to output tone (y), over quarter
   * gridlines and the dashed line where nothing changes.
   */
  let {
    label,
    curves,
    neutral = 'diagonal',
  }: { label: string; curves: readonly { map: ToneMap; colour: string }[]; neutral?: Neutral } = $props()

  const SIZE = 256
  const start = $derived({ diagonal: SIZE, flat: SIZE / 2, full: 0 }[neutral])
  const end = $derived({ diagonal: 0, flat: SIZE / 2, full: 0 }[neutral])
</script>

<svg viewBox="0 0 {SIZE} {SIZE}" role="img" aria-label={label}>
  {#each [0.25, 0.5, 0.75] as line (line)}
    <line x1={line * SIZE} x2={line * SIZE} y1="0" y2={SIZE} class="grid" />
    <line y1={line * SIZE} y2={line * SIZE} x1="0" x2={SIZE} class="grid" />
  {/each}
  <line x1="0" y1={start} x2={SIZE} y2={end} class="neutral" />
  {#each curves as curve, index (index)}
    <path d={tonePath(curve.map, SIZE)} fill="none" stroke={curve.colour} stroke-width="2" />
  {/each}
</svg>

<style>
  svg {
    display: block;
    inline-size: 100%;
    max-inline-size: 12rem;
    margin-inline: auto;
    aspect-ratio: 1;
    border: 1px solid var(--caelestis-border);
    background: color-mix(in oklab, var(--caelestis-raised-surface, #eee) 50%, transparent);
  }
  .grid { stroke: var(--caelestis-border); }
  .neutral { stroke: color-mix(in oklab, currentColor 40%, transparent); stroke-dasharray: 4 4; }
</style>
