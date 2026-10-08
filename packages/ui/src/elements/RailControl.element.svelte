<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import RailControl from '../rail/RailControl.svelte'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { RailControlIntent, RailControlModel } from '../types.js'

  const DEFAULT_MODEL: RailControlModel = { id: 'panel', label: 'Caelestis', pressed: false }
  let { model = DEFAULT_MODEL }: { model?: RailControlModel } = $props()
  const element: HTMLElement = $host()
  const emit = (detail: RailControlIntent): void => {
    element.dispatchEvent(new CustomEvent('caelestis-rail-intent', { detail, bubbles: true, composed: true }))
  }
</script>

<RailControl {model} onIntent={emit} />

<PixelStyles />

<style>
  :host { display: block; }
  /* Placement rail actions (apply/cancel) are mounted and removed by the userscript; the JS
     helper drives them through data-state like the other mounted surfaces. */
  :host([data-caelestis-placement-action]) {
    --caelestis-surface-close-duration: var(--caelestis-duration-quick);
    transform: scale(var(--caelestis-scale-small));
    opacity: 0;
    transition:
      transform var(--caelestis-duration-quick) var(--caelestis-ease-smooth-out),
      opacity   var(--caelestis-duration-quick) var(--caelestis-ease-smooth-out);
    will-change: transform, opacity;
  }
  :host([data-caelestis-placement-action][data-state='open']) { transform: scale(1); opacity: 1; }
  :host([data-caelestis-placement-action][data-state='closing']) { transform: scale(var(--caelestis-scale-tiny)); opacity: 0; pointer-events: none; }
  /* Menu rail actions below the gear: staggered drop-in on open, a quick group fade on close. */
  :host([data-caelestis-rail-action]) {
    --caelestis-surface-close-duration: var(--caelestis-duration-quick);
    transform: translateY(calc(-1 * var(--caelestis-distance-small))) scale(var(--caelestis-scale-small));
    opacity: 0;
    transition:
      transform var(--caelestis-duration-fast) var(--caelestis-ease-smooth-out),
      opacity   var(--caelestis-duration-fast) var(--caelestis-ease-smooth-out);
    transition-delay: calc(var(--rail-action-index, 0) * var(--caelestis-duration-stagger));
    will-change: transform, opacity;
  }
  :host([data-caelestis-rail-action][data-state='open']) { transform: none; opacity: 1; }
  :host([data-caelestis-rail-action][data-state='closing']) {
    transform: scale(var(--caelestis-scale-tiny));
    opacity: 0;
    pointer-events: none;
    transition-duration: var(--caelestis-duration-quick);
    transition-delay: 0s;
  }
  @media (prefers-reduced-motion: reduce) {
    :host([data-caelestis-placement-action]), :host([data-caelestis-rail-action]) { transition: none !important; }
  }
</style>
