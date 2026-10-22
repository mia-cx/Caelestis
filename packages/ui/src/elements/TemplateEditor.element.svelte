<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />
<script lang="ts">
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import TemplateEditor from '../template-editor/TemplateEditor.svelte'
  import type { TemplateEditorIntent, TemplateEditorModel } from '../types.js'
  let { model }: { model: TemplateEditorModel } = $props()
  const element: HTMLElement = $host()
  const emit = (detail: TemplateEditorIntent): void => { element.dispatchEvent(new CustomEvent('caelestis-template-editor-intent', { detail, bubbles: true, composed: true })) }
</script>
<TemplateEditor {model} onIntent={emit} />
<PixelStyles />

<style>
  /* The userscript mounts/removes this host directly and drives it through data-state, as it does
     claim mode. The close duration is the children's, so the element outlives its exit. */
  :host {
    display: block;
    --caelestis-surface-close-duration: var(--caelestis-duration-fast);
  }
</style>
