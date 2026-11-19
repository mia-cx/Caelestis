<svelte:options customElement={{ shadow: { mode: 'open', delegatesFocus: true }, props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import RailControl from '../rail/RailControl.svelte'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { RailControlModel } from '../rail/model.js'

  let { model }: { model?: RailControlModel } = $props()

  // Chromium matches :focus-visible on focus a delegatesFocus host hands on, even right after a
  // pointer click, so the element's focus() focuses its button directly.
  const element: HTMLElement = $host()
  element.focus = (options?: FocusOptions) => element.shadowRoot?.querySelector('button')?.focus(options)
</script>

{#if model}<RailControl {model} />{/if}

<PixelStyles />

<style>
  :host { display: block; }
  /* data-enter="pop" scales a lone button in; data-enter="drop" drops a column in one after
     another by --stagger-index, and fades the group out together. */
  :host([data-enter]) {
    --caelestis-surface-close-duration: var(--caelestis-duration-quick);
    will-change: transform, opacity;
  }
  :host([data-enter='pop']) {
    transform: scale(var(--caelestis-scale-small));
    opacity: 0;
    transition:
      transform var(--caelestis-duration-quick) var(--caelestis-ease-smooth-out),
      opacity   var(--caelestis-duration-quick) var(--caelestis-ease-smooth-out);
  }
  :host([data-enter='drop']) {
    transform: translateY(calc(-1 * var(--caelestis-distance-small))) scale(var(--caelestis-scale-small));
    opacity: 0;
    transition:
      transform var(--caelestis-duration-fast) var(--caelestis-ease-smooth-out),
      opacity   var(--caelestis-duration-fast) var(--caelestis-ease-smooth-out);
    transition-delay: calc(var(--stagger-index, 0) * var(--caelestis-duration-stagger));
  }
  :host([data-enter][data-state='open']) { transform: none; opacity: 1; }
  :host([data-enter][data-state='closing']) {
    transform: scale(var(--caelestis-scale-tiny));
    opacity: 0;
    pointer-events: none;
    transition-duration: var(--caelestis-duration-quick);
    transition-delay: 0s;
  }
  @media (prefers-reduced-motion: reduce) {
    :host([data-enter]) { transition: none !important; }
  }
</style>
