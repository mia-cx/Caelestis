<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { PaletteProgressModel } from '../progress/model.js'

  let { model }: { model?: PaletteProgressModel } = $props()
</script>

{#if model}<span aria-hidden="true">{model.value}</span>{/if}

<PixelStyles />

<style>
  :host { position: absolute; z-index: 1; inset-block-end: 0.125rem; inset-inline-end: 0.125rem; display: block; pointer-events: none; }
  :global(*) { box-sizing: border-box; }
  span { display: block; min-inline-size: 1.25rem; padding-inline: 0.1875rem; border-radius: var(--caelestis-pill-radius); background: rgb(15 18 24 / 0.82); box-shadow: 0 0 0 1px rgb(255 255 255 / 0.2); color: #fff; font: 650 0.5625rem/0.875rem var(--caelestis-font); font-variant-numeric: tabular-nums; pointer-events: none; text-align: center; white-space: nowrap; }
</style>
