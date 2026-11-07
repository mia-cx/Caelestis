<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' }, mapBox: { type: 'Object' } } }} />
<script lang="ts">
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { Box } from '../studio/layout.js'
  import type { TemplateStudioIntent, TemplateStudioModel } from '../studio/model.js'
  import TemplateStudio from '../studio/TemplateStudio.svelte'
  let { model, mapBox = null }: { model: TemplateStudioModel; mapBox?: Box | null } = $props()
  const element: HTMLElement = $host()
  const emit = (detail: TemplateStudioIntent): void => { element.dispatchEvent(new CustomEvent('caelestis-template-studio-intent', { detail, bubbles: true, composed: true })) }
</script>
<TemplateStudio {model} {mapBox} onIntent={emit} />
<PixelStyles />

<style>
  /* The userscript mounts/removes this host directly and drives it through data-state. */
  :host {
    display: block;
    --caelestis-surface-close-duration: var(--caelestis-duration-fast);
  }
</style>
