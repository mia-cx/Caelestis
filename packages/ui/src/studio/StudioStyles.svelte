<!-- Form roles every studio window shares. TemplateStudio renders this once for its shadow root. -->
<style>
  :global(.studio .caelestis-field), :global(.studio select.caelestis-select) {
    box-sizing: border-box;
    block-size: 2rem;
    padding: 0 0.5rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.5rem);
    background: var(--caelestis-raised-surface, #eee);
    color: var(--caelestis-text);
    font: inherit;
    font-variant-numeric: tabular-nums;
  }
  :global(.studio select.caelestis-select) { inline-size: 100%; }
  :global(.studio .caelestis-field:disabled) { opacity: 0.6; }
  /* A label above or beside its control. */
  :global(.studio .field-label) { margin: 0; color: var(--caelestis-muted-text); font-size: 0.75rem; }
  :global(.studio .hint) { margin: 0; color: var(--caelestis-muted-text); font-size: 0.75rem; }
  /* A row of label and control, label column fixed so controls line up across rows. */
  :global(.studio .row) { display: grid; grid-template-columns: 5rem minmax(0, 1fr); align-items: center; gap: 0.5rem; }
  :global(.studio .fields) { display: grid; gap: 0.35rem; }
  :global(.studio .fields.two) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  :global(.studio .number) { position: relative; display: flex; align-items: center; gap: 0.3rem; min-inline-size: 0; color: var(--caelestis-muted-text); }
  :global(.studio .number input) { flex: 1; min-inline-size: 0; inline-size: 100%; padding-inline: 0.35rem; text-align: end; }
  /* A unit inside the field's end, such as px or ×. */
  :global(.studio .number .unit) { position: absolute; inset-inline-end: 0.5rem; pointer-events: none; font-size: 0.75rem; }
  :global(.studio .number:has(.unit) input) { padding-inline-end: 1.75rem; }
  :global(.studio .actions-row) { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  :global(.studio input[type='range']) { inline-size: 100%; accent-color: var(--caelestis-primary, oklch(0.68 0.15 244)); }
  @media (pointer: coarse) {
    :global(.studio :is(.caelestis-field, select.caelestis-select)) { block-size: 2.75rem; min-block-size: 2.75rem; }
  }
</style>
