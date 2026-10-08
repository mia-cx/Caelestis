<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import Panel from '../panel/Panel.svelte'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { PanelIntent, PanelModel } from '../types.js'

  const DEFAULT_MODEL: PanelModel = { view: 'tree', width: 360, minWidth: 260, maxWidth: 720 }
  let { model = DEFAULT_MODEL }: { model?: PanelModel } = $props()
  const element: HTMLElement = $host()

  $effect(() => { element.style.width = `${model.width}px` })

  const emit = (detail: PanelIntent): void => {
    if (detail.type === 'resize-preview' || detail.type === 'resize-commit') {
      element.style.width = `${detail.width}px`
    }
    element.dispatchEvent(new CustomEvent('caelestis-panel-intent', { detail, bubbles: true, composed: true }))
  }
</script>

{#snippet content()}<svelte:element this={'slot'} />{/snippet}
<div class="pane"><Panel {model} onIntent={emit} children={content} /></div>

<PixelStyles />

<style>
  :host { display: block; min-block-size: 0; }
  /* The userscript mounts/removes this host directly; the JS helper drives it through data-state.
     The slide lives on .pane, not :host: the host's layout box stays untransformed so the map
     controls measuring its left edge always see the resting position, and a transformed
     ancestor would pin position:fixed descendants for the whole dwell — so at rest (data-state
     gone or open) there is no transform and no will-change. --pane-inset is the host's right
     offset (CLEAR_OF_RAIL, or 0 for the alliance drawer), set inline by the mounter. */
  :host {
    --pane-open-dur: var(--caelestis-duration-medium);
    --pane-close-dur: var(--caelestis-duration-fast);
    --pane-inset: 0px;
    --pane-ease: var(--caelestis-ease-smooth-out);
    --caelestis-surface-close-duration: var(--pane-close-dur);
  }
  .pane { block-size: 100%; min-block-size: 0; }
  .pane {
    transform: translateX(calc(100% + var(--pane-inset)));
    opacity: 0;
    transition:
      transform var(--pane-open-dur) var(--pane-ease),
      opacity   var(--pane-open-dur) var(--pane-ease);
  }
  :host([data-state='open']) .pane { transform: none; opacity: 1; }
  :host([data-state='closing']) .pane { transform: translateX(calc(100% + var(--pane-inset))); opacity: 0; pointer-events: none; transition-duration: var(--pane-close-dur); }
  @media (prefers-reduced-motion: reduce) {
    .pane { transition: none !important; }
  }
</style>
