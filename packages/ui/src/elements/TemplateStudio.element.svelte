<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' }, mapBox: { type: 'Object' } } }} />
<script lang="ts">
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { Box } from '../studio/layout.js'
  import type { TemplateStudioModel } from '../studio/model.js'
  import TemplateStudio from '../studio/TemplateStudio.svelte'
  import { intentEmitter } from './registry.js'
  let { model, mapBox = null }: { model: TemplateStudioModel; mapBox?: Box | null } = $props()
  const emit = intentEmitter($host(), 'caelestis-template-studio')
</script>
<TemplateStudio {model} {mapBox} onIntent={emit} />
<PixelStyles />

<style>
  :host {
    display: block;
    --caelestis-surface-close-duration: var(--caelestis-duration-fast);
  }
</style>
