<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />
<script lang="ts">
  import ClaimMode from '../claim/ClaimMode.svelte'
  import { CLAIM_MODE_INTENT, type ClaimModeIntent, type ClaimModeModel } from '../claim/model.js'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  let { model }: { model: ClaimModeModel } = $props()
  const element: HTMLElement = $host()
  const emit = (detail: ClaimModeIntent): void => { element.dispatchEvent(new CustomEvent(CLAIM_MODE_INTENT, { detail, bubbles: true, composed: true })) }
</script>
<ClaimMode {model} onIntent={emit} />
<PixelStyles />

<style>
  /* The userscript mounts/removes this host directly; the JS helper drives it through data-state.
     The close duration is the children's, so the element outlives its exit transition. */
  :host {
    display: block;
    --caelestis-surface-close-duration: var(--caelestis-duration-fast);
  }
</style>
