<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import OverlayControls from '../overlay/OverlayControls.svelte'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { OverlayControlsIntent, OverlayControlsModel } from '../types.js'

  const DEFAULT_MODEL: OverlayControlsModel = {
    name: 'Template',
    failures: [],
    appearance: {
      values: { size: 1, radius: 0, translateX: 0, translateY: 0, rotation: 0, opacity: 1, contrastOutline: false, contrastOutlineSize: 1, markMismatch: false, markUnpainted: false, unpaintedLimit: 0.05, markerColour: '#ff0000', markerSize: 9, markSelectedColour: false, selectedMarkerColour: '#ffffff', selectedMarkerSize: 9, dimOthers: false, otherOpacity: 0.15, otherColour: null },
      sliders: [], pixelPresets: [], colourPresets: [], palette: [], onlySelectedColour: false, paintOpen: false,
    },
  }
  let { model = DEFAULT_MODEL }: { model?: OverlayControlsModel } = $props()
  const element: HTMLElement = $host()
  const emit = (detail: OverlayControlsIntent): void => {
    element.dispatchEvent(new CustomEvent('caelestis-overlay-intent', { detail, bubbles: true, composed: true }))
  }
</script>

<OverlayControls {model} onIntent={emit} />

<PixelStyles />

<style>
  :host { display: block; max-block-size: inherit; }
  /* The userscript mounts/removes this host directly, so the transition lives on the host and the
     JS helper drives it through data-state. */
  :host {
    --dropdown-open-dur: var(--caelestis-duration-fast);
    --dropdown-close-dur: var(--caelestis-duration-quick);
    --dropdown-pre-scale: var(--caelestis-scale-medium);
    --dropdown-closing-scale: var(--caelestis-scale-tiny);
    --dropdown-ease: var(--caelestis-ease-smooth-out);
    --caelestis-surface-close-duration: var(--caelestis-duration-quick);
    transform-origin: top right;
    transform: scale(var(--dropdown-pre-scale));
    opacity: 0;
    pointer-events: none;
    transition:
      transform var(--dropdown-open-dur) var(--dropdown-ease),
      opacity   var(--dropdown-open-dur) var(--dropdown-ease);
    will-change: transform, opacity;
  }
  :host([data-state='open']) { transform: scale(1); opacity: 1; pointer-events: auto; }
  :host([data-state='closing']) {
    transform: scale(var(--dropdown-closing-scale));
    opacity: 0;
    transition-duration: var(--dropdown-close-dur);
  }
  @media (prefers-reduced-motion: reduce) {
    :host { transition: none !important; }
  }
</style>
