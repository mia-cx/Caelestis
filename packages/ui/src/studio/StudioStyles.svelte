<!-- Form roles every studio window shares. TemplateStudio renders this once for its shadow root. -->
<style>
  :global(.studio .caelestis-field), :global(.studio select.caelestis-select) {
    box-sizing: border-box;
    block-size: 2rem;
    padding-block: 0;
    padding-inline-start: 0.5rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.5rem);
    background-color: var(--caelestis-raised-surface, #eee);
    color: var(--caelestis-text);
    font: inherit;
    font-variant-numeric: tabular-nums;
  }
  :global(.studio .caelestis-field) { padding-inline-end: 0.5rem; }
  /* The caret is the select's own background, in its end padding. The label clips at the content
     edge, not the padding edge `hidden` would use, so a long one stops short of the caret. */
  :global(.studio select.caelestis-select) {
    display: flex;
    align-items: center;
    inline-size: 100%;
    overflow: clip;
    overflow-clip-margin: content-box;
    padding-inline-end: 1.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  :global(.studio .caelestis-field:disabled) { opacity: 0.6; }
  /* A label names its control in the text colour; only hints step back. */
  :global(.studio .field-label) { margin: 0; color: var(--caelestis-text); }
  :global(.studio .hint) { margin: 0; color: var(--caelestis-muted-text); font-size: 0.8125rem; line-height: 1.4; }
  /*
    Every window lays out the same way. A named setting is a `.field-row`: its label in a fixed
    column, so controls line up across rows and windows. A yes/no setting is a `.switch-row`: its
    label, then the switch at the end. Buttons for the rows above them sit in `.row-actions`, in the
    controls' column. What the window itself shows (swatches, layers, graphs) spans the width.
  */
  :global(.studio) { --studio-label-width: 5.75rem; }
  :global(.studio .field-row) { display: grid; grid-template-columns: var(--studio-label-width) minmax(0, 1fr); align-items: center; gap: 0.5rem; min-block-size: 2rem; }
  :global(.studio .switch-row) { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.125rem 0.5rem; min-block-size: 2rem; }
  :global(.studio .switch-row .hint) { grid-column: 1 / -1; }
  :global(.studio label.switch-row) { cursor: pointer; }
  :global(.studio .row-actions) { display: flex; flex-wrap: wrap; gap: 0.5rem; padding-inline-start: calc(var(--studio-label-width) + 0.5rem); }
  /*
    One choice of a few, side by side: Colours' presets, a channel, the scopes to show. Classic
    styles sit in :where() so pixel style's bevel, and its pressed state, always win.
  */
  :global(.studio .choices) { display: flex; align-items: center; gap: 0.25rem; min-inline-size: 0; }
  /* A list of items to pick between, such as an effect's curves: each its own width, wrapping. */
  :global(.studio .choices.wrap) { flex-wrap: wrap; }
  :global(.studio .choices.wrap .choice) { flex: 0 0 auto; padding-inline: 0.5rem; }
  /* Together they fill the row, each as wide as its label needs and an equal share of the rest. */
  :global(.studio :where(.choice)) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    flex: 1 1 auto;
    min-inline-size: 0;
    min-block-size: 2rem;
    padding: 0 0.25rem;
    overflow: hidden;
    border: 1px solid var(--caelestis-border);
    border-radius: min(var(--caelestis-radius, 0.4rem), 0.4rem);
    background: var(--caelestis-raised-surface, #eee);
    color: var(--caelestis-text);
    font: 600 0.75rem/1 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif);
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  :global(.studio :where(.choice:is([aria-pressed='true'], [aria-checked='true']))) {
    border-color: var(--caelestis-primary, oklch(0.68 0.15 244));
    background: var(--caelestis-primary, oklch(0.68 0.15 244));
    color: var(--color-primary-content, white);
  }
  :global(.studio .choice:disabled) { opacity: 0.5; cursor: not-allowed; }
  :global(.studio .choice:focus-visible) { outline: 2px solid var(--caelestis-focus, currentColor); outline-offset: 1px; }
  :global(.studio .number) { position: relative; display: flex; align-items: center; gap: 0.375rem; min-inline-size: 0; }
  :global(.studio .number input) { flex: 1; min-inline-size: 0; inline-size: 100%; padding-inline: 0.5rem; text-align: end; }
  /* A unit inside the field's end, such as px or ×. */
  :global(.studio .number .unit) { position: absolute; inset-inline-end: 0.5rem; color: var(--caelestis-muted-text); pointer-events: none; }
  :global(.studio .number:has(.unit) input) { padding-inline-end: 1.75rem; }
  /* No spinner: it would take the digits' room, and the slider or the map's handles step better. */
  :global(.studio .number input) { appearance: textfield; }
  :global(.studio .number input::-webkit-inner-spin-button), :global(.studio .number input::-webkit-outer-spin-button) { appearance: none; margin: 0; }
  :global(.studio .actions-row) { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  /* A titled group inside a window, set off from the group above it. */
  :global(.studio .section) { margin: 0.25rem 0 0; padding-block-start: 0.75rem; border-block-start: 1px solid var(--caelestis-border); color: var(--caelestis-text); font-weight: 600; }
  @media (pointer: coarse) {
    :global(.studio :is(.caelestis-field, select.caelestis-select)) { block-size: 2.75rem; min-block-size: 2.75rem; }
  }
</style>
