<!--
  Caelestis's slider, for any `<input type="range" class="caelestis-slider">`: a filled track to
  `--fill` (a percentage the input sets) and a square thumb in classic, and Wplace's own range in
  pixel style: an 8px ink-framed track and a bevelled 16px thumb. Render it once per shadow root
  that has sliders.
-->
<style>
  :global(.caelestis-slider) {
    appearance: none;
    block-size: 1rem;
    overflow: hidden;
    border: 0;
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: transparent;
    color: var(--caelestis-primary, var(--color-primary, oklch(0.58 0.17 252)));
    cursor: pointer;
    vertical-align: middle;
  }
  :global(.caelestis-slider::-webkit-slider-runnable-track) {
    inline-size: 100%;
    block-size: 0.5rem;
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: linear-gradient(to right, currentColor var(--fill), color-mix(in oklab, currentColor 10%, transparent) var(--fill));
  }
  :global(.caelestis-slider::-webkit-slider-thumb) {
    appearance: none;
    position: relative;
    inset-block-start: 50%;
    inline-size: 1rem;
    block-size: 1rem;
    border: 0.25rem solid currentColor;
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: var(--caelestis-surface, var(--color-base-100, white));
    transform: translateY(-50%);
  }
  :global(.caelestis-slider::-moz-range-track) {
    inline-size: 100%;
    block-size: 0.5rem;
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: color-mix(in oklab, currentColor 10%, transparent);
  }
  :global(.caelestis-slider::-moz-range-progress) { block-size: 0.5rem; background: currentColor; }
  :global(.caelestis-slider::-moz-range-thumb) {
    inline-size: 0.5rem;
    block-size: 0.5rem;
    border: 0.25rem solid currentColor;
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: var(--caelestis-surface, var(--color-base-100, white));
  }
  :global(.caelestis-slider:focus-visible) { outline: 2px solid var(--caelestis-focus, currentColor); outline-offset: 2px; }

  :global(:host([data-caelestis-style='pixel']) .caelestis-slider) { border-radius: 0; background: none; overflow: visible; }
  /* Each engine drops a whole rule over a pseudo-element it does not know, so they stay apart. */
  :global(:host([data-caelestis-style='pixel']) .caelestis-slider::-webkit-slider-runnable-track) {
    box-sizing: border-box;
    block-size: 8px;
    border: 2px solid var(--caelestis-pixel-ink);
    border-radius: 0;
    background: linear-gradient(to right, var(--caelestis-primary) var(--fill), var(--caelestis-pixel-well-shade) var(--fill));
  }
  :global(:host([data-caelestis-style='pixel']) .caelestis-slider::-moz-range-track) {
    box-sizing: border-box;
    block-size: 8px;
    border: 2px solid var(--caelestis-pixel-ink);
    border-radius: 0;
    background: linear-gradient(to right, var(--caelestis-primary) var(--fill), var(--caelestis-pixel-well-shade) var(--fill));
  }
  :global(:host([data-caelestis-style='pixel']) .caelestis-slider::-moz-range-progress) { block-size: 4px; background: var(--caelestis-primary); }
  :global(:host([data-caelestis-style='pixel']) .caelestis-slider::-webkit-slider-thumb) {
    appearance: none;
    box-sizing: border-box;
    inline-size: 16px;
    block-size: 16px;
    border: 2px solid var(--caelestis-pixel-ink);
    border-radius: 0;
    background: var(--caelestis-pixel-thumb);
    box-shadow: inset -2px -2px 0 var(--caelestis-pixel-button-shade);
  }
  :global(:host([data-caelestis-style='pixel']) .caelestis-slider::-moz-range-thumb) {
    box-sizing: border-box;
    inline-size: 16px;
    block-size: 16px;
    border: 2px solid var(--caelestis-pixel-ink);
    border-radius: 0;
    background: var(--caelestis-pixel-thumb);
    box-shadow: inset -2px -2px 0 var(--caelestis-pixel-button-shade);
  }
  :global(:host([data-caelestis-style='pixel']) .caelestis-slider:disabled) { opacity: 0.55; cursor: not-allowed; }
  :global(:host([data-caelestis-style='pixel']) .caelestis-slider:focus-visible) { outline: 2px solid var(--caelestis-primary); outline-offset: 2px; }
  @media (forced-colors: active) {
    :global(:host([data-caelestis-style='pixel']) .caelestis-slider::-webkit-slider-runnable-track) { border-color: CanvasText; background: Canvas; }
    :global(:host([data-caelestis-style='pixel']) .caelestis-slider::-moz-range-track) { border-color: CanvasText; background: Canvas; }
    :global(:host([data-caelestis-style='pixel']) .caelestis-slider::-webkit-slider-thumb) { border-color: CanvasText; background: Highlight; box-shadow: none; }
    :global(:host([data-caelestis-style='pixel']) .caelestis-slider::-moz-range-thumb) { border-color: CanvasText; background: Highlight; box-shadow: none; }
  }
</style>
