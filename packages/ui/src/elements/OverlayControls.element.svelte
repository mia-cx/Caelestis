<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import OverlayControls from '../overlay/OverlayControls.svelte'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { OverlayControlsModel } from '../overlay/model.js'
  import { intentEmitter } from './registry.js'

  let { model }: { model?: OverlayControlsModel } = $props()
  const emit = intentEmitter($host(), 'caelestis-overlay-controls')
</script>

{#if model}<OverlayControls {model} onIntent={emit} />{/if}

<PixelStyles />

<style>
  :host { display: block; max-block-size: inherit; }
  :host {
    --dropdown-open-dur: var(--caelestis-duration-fast);
    --dropdown-close-dur: var(--caelestis-duration-quick);
    --dropdown-ease: var(--caelestis-ease-smooth-out);
    --caelestis-surface-close-duration: var(--dropdown-close-dur);
    transform-origin: top right;
    transform: scale(var(--caelestis-scale-large));
    opacity: 0;
    filter: blur(var(--caelestis-blur-small));
    pointer-events: none;
    transition:
      transform var(--dropdown-open-dur) var(--dropdown-ease),
      opacity   var(--dropdown-open-dur) var(--dropdown-ease),
      filter    var(--dropdown-open-dur) var(--dropdown-ease);
    will-change: transform, opacity;
  }
  :host([data-state='open']) { transform: scale(1); opacity: 1; filter: none; pointer-events: auto; }
  :host([data-state='closing']) {
    transform: scale(var(--caelestis-scale-large));
    opacity: 0;
    filter: blur(var(--caelestis-blur-small));
    pointer-events: none;
    transition-duration: var(--dropdown-close-dur);
  }
  @media (prefers-reduced-motion: reduce) {
    :host { transition: none !important; }
  }
</style>
