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
<Panel {model} onIntent={emit} children={content} />

<PixelStyles />

<style>
  :host { display: block; min-block-size: 0; }
  /* The userscript mounts/removes this host directly; the JS helper drives it through data-state. */
  :host {
    --pane-open-dur: var(--caelestis-duration-fast);
    --pane-close-dur: var(--caelestis-duration-quick);
    --pane-shift: var(--caelestis-distance-medium);
    --pane-ease: var(--caelestis-ease-smooth-out);
    --caelestis-surface-close-duration: var(--pane-close-dur);
    transform: translateX(var(--pane-shift));
    opacity: 0;
    transition:
      transform var(--pane-open-dur) var(--pane-ease),
      opacity   var(--pane-open-dur) var(--pane-ease);
    will-change: transform, opacity;
  }
  :host([data-state='open']) { transform: translateX(0); opacity: 1; }
  :host([data-state='closing']) { transform: translateX(var(--pane-shift)); opacity: 0; pointer-events: none; transition-duration: var(--pane-close-dur); }
  @media (prefers-reduced-motion: reduce) {
    :host { transition: none !important; }
  }
</style>
