<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />
<script lang="ts">
  import ClaimMode from '../claim/ClaimMode.svelte'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { ClaimModeModel } from '../claim/model.js'
  import { intentEmitter } from './registry.js'
  let { model }: { model?: ClaimModeModel } = $props()
  const emit = intentEmitter($host(), 'caelestis-claim-mode')
</script>
{#if model}<ClaimMode {model} onIntent={emit} />{/if}
<PixelStyles />

<style>
  /* The close duration is the children's, so the element outlives its exit transition. */
  :host {
    display: block;
    --caelestis-surface-close-duration: var(--caelestis-duration-fast);
  }
</style>
