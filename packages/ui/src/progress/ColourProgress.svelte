<script lang="ts">
  // Aliased: this component's own name is ColourProgress.
  import { type ColourProgress as ColourRow, formatCount, formatExactCount, formatPixels, WPLACE_PALETTE } from '@caelestis/shared'
  import { type ColourProgressSort, compareColours } from './colour-sorts.js'

  /** One row per palette colour in `colours`, ordered by `sort`; the host renders the sort control. */
  let { colours, sort = 'index' }: {
    colours: readonly ColourRow[]
    sort?: ColourProgressSort
  } = $props()

  const rows = $derived(
    colours
      .toSorted(compareColours(sort))
      .flatMap((colour) => {
        const palette = WPLACE_PALETTE[colour.index]
        return palette === undefined ? [] : [{ colour, palette, completed: colour.completed, total: colour.total }]
      }),
  )
</script>

<div class="colours"><ul>
  {#each rows as { colour, palette, completed, total } (colour.index)}
    {@const done = total === 0 ? 0 : completed / total}
    <li title={`${palette.name}: ${formatExactCount(completed)} of ${formatPixels(total)} complete`} aria-label={`${palette.name}: ${formatExactCount(completed)} of ${formatPixels(total)} complete`}>
      <span class="index">{colour.index}</span>
      <span class="swatch" style:background={palette.hex} title={`${palette.name} (${palette.kind})`}></span>
      <span class="name" title={palette.name}>{palette.name}</span>
      <span class="track"><span style:width={`${done * 100}%`} style:background={palette.hex}></span></span>
      <span class="count">{formatCount(completed)}/{formatCount(total)}</span>
      <span class="percent">{(done * 100).toFixed(1)}%</span>
    </li>
  {/each}
</ul></div>

<style>
  /* The rows fit the space they are given: a phone, a sidebar, or a narrow pane. */
  .colours { container-type: inline-size; min-inline-size: 0; }
  ul { display: flex; flex-direction: column; gap: 0.375rem; margin: 0; padding: 0; list-style: none; }
  li { display: grid; grid-template-columns: 1.5rem 1rem minmax(5rem, 9rem) minmax(4rem, 1fr) 8.5rem; align-items: center; gap: 0.5rem; color: var(--caelestis-text); font-family: inherit; font-size: inherit; line-height: 1.2; }
  .index, .count, .percent { color: var(--caelestis-muted-text); text-align: end; font-size: inherit; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .swatch { inline-size: 1rem; block-size: 1rem; border: 1px solid color-mix(in oklch, var(--caelestis-text) 20%, transparent); border-radius: var(--caelestis-radius); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track { block-size: 0.375rem; overflow: hidden; border-radius: var(--caelestis-radius); background: var(--caelestis-raised-surface); }
  .track > span { display: block; block-size: 100%; border-radius: inherit; }
  .percent { display: none; }
  @container (max-width: 30rem) { li { grid-template-columns: 1rem minmax(3rem, 5rem) minmax(3rem, 1fr) 3.5rem; } .index, .count { display: none; } .percent { display: block; } }
</style>
