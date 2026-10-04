<script lang="ts">
  interface Props {
    label: string
    checked: boolean
    disabled?: boolean
    compact?: boolean
    control?: string
    onChange?: (checked: boolean) => void
  }

  let { label, checked, disabled = false, compact = false, control, onChange }: Props = $props()
  // The "off" keyframes must not play on mount — they only arm once the user has toggled.
  let initiated = $state(false)
</script>

<input
  type="checkbox"
  role="switch"
  aria-label={label}
  class:compact
  class:is-init={initiated}
  {checked}
  {disabled}
  data-caelestis-control={control}
  onchange={(event) => { initiated = true; onChange?.(event.currentTarget.checked) }}
/>

<style>
  input {
    --toggle-size: 1.25rem;
    --toggle-padding: calc(var(--toggle-size) * 0.125);
    --toggle-colour: color-mix(in oklab, var(--caelestis-text, var(--color-base-content, currentColor)) 50%, transparent);
    /* The thumb's resting offset is the column it jumps to; --toggle-travel is that column's width. */
    --toggle-dur: var(--caelestis-duration-fast);
    --toggle-travel: calc(var(--toggle-size) - (var(--border, 1px) + var(--toggle-padding)) * 2);
    --toggle-ov1: 1px;
    --toggle-ov2: 0px;
    --toggle-ease: var(--caelestis-ease-bounce);
    appearance: none;
    position: relative;
    display: inline-grid;
    flex-shrink: 0;
    grid-template-columns: 0fr 1fr 1fr;
    place-content: center;
    inline-size: calc((var(--toggle-size) * 2) - (var(--border, 1px) + var(--toggle-padding)) * 2);
    block-size: var(--toggle-size);
    margin: 0;
    padding: var(--toggle-padding);
    border: var(--border, 1px) solid currentColor;
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: transparent;
    color: var(--toggle-colour);
    box-shadow: 0 1px color-mix(in oklab, currentColor calc(var(--depth, 1) * 10%), transparent) inset;
    cursor: pointer;
    transition: color var(--caelestis-duration-fast);
  }

  input::before {
    content: '';
    position: relative;
    grid-column: 2;
    grid-row: 1;
    inline-size: 100%;
    block-size: 100%;
    aspect-ratio: 1;
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: currentColor;
    translate: 0 0;
    will-change: translate;
    box-shadow:
      0 -1px oklch(0% 0 0 / calc(var(--depth, 1) * 10%)) inset,
      0 8px 0 -4px oklch(100% 0 0 / calc(var(--depth, 1) * 10%)) inset,
      0 1px color-mix(in oklab, currentColor calc(var(--depth, 1) * 10%), transparent);
  }

  input:checked { --toggle-colour: var(--caelestis-primary, var(--color-primary, oklch(0.58 0.17 252))); grid-template-columns: 1fr 1fr 0fr; background: var(--caelestis-surface, var(--color-base-100, white)); }
  input.compact { --toggle-size: 1rem; }
  input:disabled { cursor: not-allowed; opacity: 0.3; }
  input:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }

  /* The layout jump is instant; the keyframes replay it as a two-step overshoot so a mid-flight
     retoggle continues from wherever the thumb actually is. */
  input.is-init:checked::before { animation: toggle-thumb-on var(--toggle-dur) var(--toggle-ease) both; }
  input.is-init:not(:checked)::before { animation: toggle-thumb-off var(--toggle-dur) var(--toggle-ease) both; }

  @keyframes toggle-thumb-on {
    0% { translate: calc(-1 * var(--toggle-travel)) 0; }
    55% { translate: var(--toggle-ov1) 0; }
    80% { translate: calc(-1 * var(--toggle-ov2)) 0; }
    100% { translate: 0 0; }
  }
  @keyframes toggle-thumb-off {
    0% { translate: var(--toggle-travel) 0; }
    55% { translate: calc(-1 * var(--toggle-ov1)) 0; }
    80% { translate: var(--toggle-ov2) 0; }
    100% { translate: 0 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    input { transition: none; }
    input::before { animation: none !important; }
  }

  /* Pixel chrome: Wplace's .toggle — well-shade track, square ink thumb, checked goes primary. */
  :host([data-caelestis-style='pixel']) input {
    --border: 2px;
    border: 2px solid var(--caelestis-pixel-ink);
    border-radius: 0;
    background: var(--caelestis-pixel-well-shade);
    box-shadow: inset 3px 3px 0 var(--caelestis-pixel-field-shade);
    transition-timing-function: steps(2, end);
  }
  :host([data-caelestis-style='pixel']) input::before {
    box-sizing: border-box;
    border: 2px solid var(--caelestis-pixel-ink);
    border-radius: 0;
    background: var(--caelestis-pixel-thumb);
    box-shadow: inset -2px -2px 0 var(--caelestis-pixel-button-shade);
    transition-timing-function: steps(2, end);
  }
  :host([data-caelestis-style='pixel']) input:checked {
    background: var(--caelestis-primary);
    box-shadow: inset 3px 3px 0 var(--caelestis-pixel-primary-shade);
    color: var(--color-primary-content, white);
  }
  :host([data-caelestis-style='pixel']) input:focus-visible {
    outline: 2px solid var(--caelestis-primary);
    outline-offset: 2px;
  }
  @media (forced-colors: active) {
    :host([data-caelestis-style='pixel']) input { border-color: CanvasText; background: Canvas; box-shadow: none; }
    :host([data-caelestis-style='pixel']) input::before { border-color: CanvasText; background: Canvas; box-shadow: none; }
    :host([data-caelestis-style='pixel']) input:checked { background: Highlight; box-shadow: none; }
    :host([data-caelestis-style='pixel']) input:checked::before { background: HighlightText; }
  }
</style>
