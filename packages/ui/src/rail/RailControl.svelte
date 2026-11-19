<script lang="ts">
  import Icon from '../foundations/Icon.svelte'
  import type { RailControlModel } from './model.js'

  let { model }: { model: RailControlModel } = $props()
</script>

<button
  type="button"
  class="caelestis-bevel"
  class:pressed={model.pressed}
  class:danger={model.danger}
  title={model.title ?? model.label}
  aria-label={model.label}
  aria-busy={model.busy}
  aria-pressed={model.pressed}
  aria-expanded={model.expanded}
  aria-controls={model.controls}
  aria-haspopup={model.popup}
  aria-disabled={model.disabled}
>
  <Icon name={model.icon} size="1.25rem" />
  {#if model.badge !== undefined && model.badge > 0}
    <span class="badge" aria-label={`${model.badge} new alarms`}>{model.badge}</span>
  {/if}
</button>

<style>
  button {
    --button-base-colour: var(--caelestis-raised-surface);
    --button-colour: var(--button-base-colour);
    position: relative;
    display: grid;
    place-items: center;
    inline-size: var(--caelestis-touch-target);
    block-size: var(--caelestis-touch-target);
    padding: 0;
    border: 1px solid color-mix(in oklab, var(--button-colour), #000 5%);
    border-radius: var(--caelestis-pill-radius);
    outline-color: var(--button-colour);
    background: var(--button-colour);
    color: var(--caelestis-text);
    box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
  }
  button.pressed { --button-base-colour: var(--caelestis-primary); color: white; }
  button.danger { color: var(--caelestis-danger); }
  button[aria-disabled='true'] { cursor: not-allowed; opacity: 0.5; }
  @media (hover: hover) { button:hover:not([aria-disabled='true']) { --button-colour: color-mix(in oklab, var(--button-base-colour), #000 7%); } }
  button:active:not([aria-disabled='true']) { translate: 0 0.5px; box-shadow: none; }
  button:focus-visible { outline: 2px solid var(--button-colour, var(--caelestis-focus)); outline-offset: 2px; }
  .badge { position: absolute; inset-block-start: -0.35rem; inset-inline-end: -0.35rem; display: grid; place-items: center; min-inline-size: 1.2rem; block-size: 1.2rem; padding-inline: 0.25rem; border: 2px solid var(--button-colour); border-radius: var(--caelestis-pill-radius); background: var(--caelestis-danger); color: white; font: 800 0.65rem/1 var(--caelestis-font); }
  @media (prefers-reduced-motion: no-preference) { button { transition: color 200ms, background-color 200ms, border-color 200ms, box-shadow 200ms, translate 200ms; } }

  /* Pixel chrome: square bevel flush with Wplace's own rail buttons. */
  :host([data-caelestis-style='pixel']) button {
    --bevel-size: var(--caelestis-touch-target);
    border-radius: 0;
    box-shadow: 3px 3px 0 var(--caelestis-pixel-shadow);
  }
  /* The rail's own pressed look is solid primary; it out-specifies the shared pressed rule. */
  :host([data-caelestis-style='pixel']) button.pressed[aria-pressed='true']:not([aria-disabled='true']) {
    --bevel-color: var(--caelestis-primary);
    --bevel-light: var(--caelestis-pixel-primary-light);
    --bevel-dark: var(--caelestis-pixel-primary-shade);
    color: var(--caelestis-primary-content);
    background: var(--bevel-stack);
  }
  :host([data-caelestis-style='pixel']) button.danger { color: var(--caelestis-danger); }
  :host([data-caelestis-style='pixel']) button:focus-visible {
    outline: 2px solid var(--caelestis-primary);
    outline-offset: 2px;
  }
  :host([data-caelestis-style='pixel']) .badge {
    border-color: var(--caelestis-pixel-ink);
    border-radius: 0;
  }
  @media (forced-colors: active) {
    :host([data-caelestis-style='pixel']) button { border: 2px solid ButtonText; }
    /* As specific as the pixel pressed rule above, so the system colours win over its bevel. */
    :host([data-caelestis-style='pixel']) button.pressed[aria-pressed='true']:not([aria-disabled='true']) { background: Highlight; color: HighlightText; }
  }
</style>
