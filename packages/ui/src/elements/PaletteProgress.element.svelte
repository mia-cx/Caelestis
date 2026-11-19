<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import PaletteProgress from '../progress/PaletteProgress.svelte'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { PaletteProgressModel } from '../progress/model.js'

  let { model }: { model?: PaletteProgressModel } = $props()
</script>

{#if model}<PaletteProgress {model} />{/if}

<PixelStyles />

<style>
  :host { position: absolute; z-index: 1; inset-block-end: 0.125rem; inset-inline-end: 0.125rem; display: block; pointer-events: none; }
</style>
