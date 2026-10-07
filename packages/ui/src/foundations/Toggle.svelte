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
</script>

<input
  type="checkbox"
  role="switch"
  aria-label={label}
  class:compact
  {checked}
  {disabled}
  data-caelestis-control={control}
  onchange={(event) => onChange?.(event.currentTarget.checked)}
/>

<style>
  input {
    --toggle-size: 1.25rem;
    --toggle-padding: calc(var(--toggle-size) * 0.125);
    --toggle-colour: color-mix(in oklab, var(--caelestis-text, var(--color-base-content, currentColor)) 50%, transparent);
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
    transition: color 300ms, grid-template-columns 200ms;
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
    box-shadow:
      0 -1px oklch(0% 0 0 / calc(var(--depth, 1) * 10%)) inset,
      0 8px 0 -4px oklch(100% 0 0 / calc(var(--depth, 1) * 10%)) inset,
      0 1px color-mix(in oklab, currentColor calc(var(--depth, 1) * 10%), transparent);
  }

  input:checked { --toggle-colour: var(--caelestis-primary, var(--color-primary, oklch(0.58 0.17 252))); grid-template-columns: 1fr 1fr 0fr; background: var(--caelestis-surface, var(--color-base-100, white)); }
  input.compact { --toggle-size: 1rem; }
  input:disabled { cursor: not-allowed; opacity: 0.3; }
  input:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }

  @media (prefers-reduced-motion: no-preference) {
    input::before { transition: background-color 100ms, translate 200ms; }
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
