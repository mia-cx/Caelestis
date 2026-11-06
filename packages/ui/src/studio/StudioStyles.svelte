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
  /* The caret is the select's own background; its end padding keeps the label clear of it. */
  :global(.studio select.caelestis-select) {
    display: flex;
    align-items: center;
    inline-size: 100%;
    overflow: hidden;
    padding-inline-end: 1.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  :global(.studio .caelestis-field:disabled) { opacity: 0.6; }
  /* A label names its control in the text colour; only hints step back. */
  :global(.studio .field-label) { margin: 0; color: var(--caelestis-text); }
  :global(.studio .hint) { margin: 0; color: var(--caelestis-muted-text); font-size: 0.8125rem; line-height: 1.4; }
  /* A row of label and control, label column fixed so controls line up across rows. */
  :global(.studio .field-row) { display: grid; grid-template-columns: 5.75rem minmax(0, 1fr); align-items: center; gap: 0.5rem; min-block-size: 2rem; }
  :global(.studio .fields) { display: grid; gap: 0.5rem; }
  :global(.studio .fields.two) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  :global(.studio .number) { position: relative; display: flex; align-items: center; gap: 0.375rem; min-inline-size: 0; }
  :global(.studio .number > span:first-child) { color: var(--caelestis-muted-text); }
  :global(.studio .number input) { flex: 1; min-inline-size: 0; inline-size: 100%; padding-inline: 0.5rem; text-align: end; }
  /* A unit inside the field's end, such as px or ×. */
  :global(.studio .number .unit) { position: absolute; inset-inline-end: 0.5rem; color: var(--caelestis-muted-text); pointer-events: none; }
  :global(.studio .number:has(.unit) input) { padding-inline-end: 1.75rem; }
  :global(.studio .actions-row) { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  /* A titled group inside a window, set off from the group above it. */
  :global(.studio .section) { margin: 0.25rem 0 0; padding-block-start: 0.75rem; border-block-start: 1px solid var(--caelestis-border); color: var(--caelestis-text); font-weight: 600; }
  :global(.studio input[type='range']) { inline-size: 100%; accent-color: var(--caelestis-primary, oklch(0.68 0.15 244)); }
  @media (pointer: coarse) {
    :global(.studio :is(.caelestis-field, select.caelestis-select)) { block-size: 2.75rem; min-block-size: 2.75rem; }
  }
</style>
