<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />
<script lang="ts">
  import CaptureRun from '../capture/CaptureRun.svelte'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { CaptureRunModel } from '../capture/model.js'
  import { intentEmitter } from './registry.js'
  let { model }: { model?: CaptureRunModel } = $props()
  const emit = intentEmitter($host(), 'caelestis-capture-run')
</script>
{#if model}<CaptureRun {model} onIntent={emit} />{/if}
<PixelStyles />

<style>
  /*
   * The element places itself: top-left, beside Wplace's column of map buttons, clear of the
   * bottom-centre Paint drawer and the right-hand rail. A host moves it with the two custom
   * properties, or overrides `inset` and `z-index` on the element directly.
   */
  :host {
    --caelestis-surface-close-duration: var(--caelestis-duration-fast);
    position: fixed;
    inset-block-start: var(--caelestis-capture-run-top, 0.5rem);
    inset-inline-start: var(--caelestis-capture-run-left, 3.5rem);
    /* Above the docked panel (30), below its popovers (40), like the claim editor. */
    z-index: 31;
    display: block;
    max-inline-size: calc(100vw - var(--caelestis-capture-run-left, 3.5rem) - 0.5rem);
    max-block-size: calc(100vh - var(--caelestis-capture-run-top, 0.5rem) - 0.5rem);
  }
  /*
   * Where the window is too narrow for the card beside Wplace's top-centre event scoreboard, it
   * sits below it, and stops above the bottom Paint controls rather than covering them.
   */
  @media (max-width: 1080px) {
    :host {
      inset-block-start: var(--caelestis-capture-run-top-narrow, 10.5rem);
      max-block-size: calc(100vh - var(--caelestis-capture-run-top-narrow, 10.5rem) - 6.5rem);
    }
  }
  /* A short window has no room below the scoreboard: the card takes the top and the full height,
     so the countdown and controls stay usable. */
  @media (max-width: 1080px) and (max-height: 560px) {
    :host {
      inset-block-start: 0.5rem;
      max-block-size: calc(100vh - 1rem);
    }
  }
  @media (max-width: 480px) {
    :host {
      inset-inline-start: 0.5rem;
      /* Clear of Wplace's right-hand column of buttons. */
      max-inline-size: calc(100vw - 5rem);
    }
  }
  /* A keyframe entrance, not a transition: it runs whenever the shadow styles attach, so the host
     needs no open step. `closeSurface` drives the exit through data-state. */
  @media (prefers-reduced-motion: no-preference) {
    :host {
      animation: enter var(--caelestis-duration-fast) var(--caelestis-ease-smooth-out);
      transition: opacity var(--caelestis-duration-fast) var(--caelestis-ease-smooth-out), translate var(--caelestis-duration-fast) var(--caelestis-ease-smooth-out);
    }
  }
  @keyframes enter { from { opacity: 0; translate: 0 calc(-1 * var(--caelestis-distance-base)); } }
  :host([data-state='closing']) { opacity: 0; translate: 0 calc(-1 * var(--caelestis-distance-base)); pointer-events: none; }
</style>
