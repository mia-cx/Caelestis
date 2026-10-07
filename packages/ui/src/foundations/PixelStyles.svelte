<!--
  Wplace's pixel chrome for the shared roles, gated on the `data-caelestis-style` attribute the
  host paints. Every rule lives behind `:host([data-caelestis-style='pixel'])`, so classic
  surfaces and the frontend (which never sets the attribute) are untouched.
-->
<style>
  /* Notched frame: a 2px ink border drawn as four edge gradients, corners left open. */
  :global(:host([data-caelestis-style='pixel']) :is(.caelestis-surface, .caelestis-panel-surface, .caelestis-menu)),
  :global(:host([data-caelestis-style='pixel']) select.caelestis-select::picker(select)) {
    --pixel-edge: 2px;
    --pixel-inner: calc(100% - var(--pixel-edge) * 2);
    border: var(--pixel-edge) solid transparent;
    background:
      linear-gradient(var(--caelestis-pixel-ink), var(--caelestis-pixel-ink)) top center / var(--pixel-inner) var(--pixel-edge),
      linear-gradient(var(--caelestis-pixel-ink), var(--caelestis-pixel-ink)) bottom center / var(--pixel-inner) var(--pixel-edge),
      linear-gradient(var(--caelestis-pixel-ink), var(--caelestis-pixel-ink)) left center / var(--pixel-edge) var(--pixel-inner),
      linear-gradient(var(--caelestis-pixel-ink), var(--caelestis-pixel-ink)) right center / var(--pixel-edge) var(--pixel-inner),
      linear-gradient(var(--surface-fill, var(--caelestis-surface)), var(--surface-fill, var(--caelestis-surface))) center / var(--pixel-inner) 100%,
      linear-gradient(var(--surface-fill, var(--caelestis-surface)), var(--surface-fill, var(--caelestis-surface))) center / 100% var(--pixel-inner);
    background-repeat: no-repeat;
    background-origin: border-box;
    background-clip: border-box;
    border-radius: 0;
    box-shadow: var(--caelestis-popover-shadow);
    backdrop-filter: none;
  }
  /* Wplace's .modal-box: a deeper edge with an inner bottom-right shade. */
  :global(:host([data-caelestis-style='pixel']) .caelestis-panel-surface) {
    --pixel-edge: 3px;
    box-shadow: inset -3px -3px 0 var(--caelestis-border), var(--caelestis-shadow);
  }
  :global(:host([data-caelestis-style='pixel']) :is(.caelestis-field, select.caelestis-select)) {
    border: 2px solid var(--caelestis-pixel-ink);
    border-radius: 0;
    background-color: var(--caelestis-surface);
    box-shadow: inset 3px 3px 0 var(--caelestis-pixel-field-shade);
  }
  :global(:host([data-caelestis-style='pixel']) :is(.caelestis-field:focus-within, .caelestis-field:focus, select.caelestis-select:focus)) {
    border-color: var(--caelestis-primary);
    outline: 2px solid var(--caelestis-primary);
    outline-offset: 2px;
  }
  :global(:host([data-caelestis-style='pixel']) .caelestis-field)::placeholder,
  :global(:host([data-caelestis-style='pixel']) .caelestis-field ::placeholder) {
    color: var(--caelestis-muted-text);
  }
  :global(:host([data-caelestis-style='pixel']) .caelestis-badge) {
    border-color: var(--caelestis-pixel-ink);
    border-radius: 0;
    box-shadow: none;
  }

  /*
   * Wplace's .btn bevel: an ink frame plus light top/left and dark bottom/right faces, drawn
   * over --bevel-fill. States only change the --bevel-* inputs; the component then re-asserts
   * `background: var(--bevel-stack)` so the stack still beats its own classic `background:`.
   */
  :global(:host([data-caelestis-style='pixel']) .caelestis-bevel) {
    --bevel-size: 2rem;
    --bevel-frame-width: clamp(2px, calc(var(--bevel-size) / 8 - 3px), 3px);
    --bevel-depth: clamp(3px, calc(var(--bevel-size) / 8), 7px);
    --bevel-frame: var(--caelestis-pixel-ink);
    --bevel-color: var(--caelestis-pixel-button);
    --bevel-fill: var(--bevel-color);
    --bevel-light: var(--caelestis-pixel-button-light);
    --bevel-dark: var(--caelestis-pixel-button-shade);
    --bevel-top: var(--bevel-light);
    --bevel-bottom: var(--bevel-dark);
    --bevel-inner: calc(100% - var(--bevel-frame-width) * 2);
    --bevel-image: linear-gradient(var(--bevel-fill), var(--bevel-fill));
    /* no-repeat + border-box live inside each layer so `background: var(--bevel-stack)` alone
       re-asserts the full picture — a bare shorthand would reset them and the frame would tile. */
    --bevel-stack:
      linear-gradient(var(--bevel-frame), var(--bevel-frame)) top center / var(--bevel-inner) var(--bevel-frame-width) no-repeat border-box,
      linear-gradient(var(--bevel-frame), var(--bevel-frame)) bottom center / var(--bevel-inner) var(--bevel-frame-width) no-repeat border-box,
      linear-gradient(var(--bevel-frame), var(--bevel-frame)) left center / var(--bevel-frame-width) var(--bevel-inner) no-repeat border-box,
      linear-gradient(var(--bevel-frame), var(--bevel-frame)) right center / var(--bevel-frame-width) var(--bevel-inner) no-repeat border-box,
      linear-gradient(var(--bevel-top), var(--bevel-top)) left var(--bevel-frame-width) top var(--bevel-frame-width) / var(--bevel-inner) calc(var(--bevel-depth) - var(--bevel-frame-width)) no-repeat border-box,
      linear-gradient(var(--bevel-top), var(--bevel-top)) left var(--bevel-frame-width) top var(--bevel-frame-width) / calc(var(--bevel-depth) - var(--bevel-frame-width)) var(--bevel-inner) no-repeat border-box,
      linear-gradient(var(--bevel-bottom), var(--bevel-bottom)) right var(--bevel-frame-width) bottom var(--bevel-frame-width) / var(--bevel-inner) calc(var(--bevel-depth) - var(--bevel-frame-width)) no-repeat border-box,
      linear-gradient(var(--bevel-bottom), var(--bevel-bottom)) right var(--bevel-frame-width) bottom var(--bevel-frame-width) / calc(var(--bevel-depth) - var(--bevel-frame-width)) var(--bevel-inner) no-repeat border-box,
      var(--bevel-image) center / var(--bevel-inner) 100% no-repeat border-box,
      var(--bevel-image) center / 100% var(--bevel-inner) no-repeat border-box;
    border-color: transparent;
    border-radius: 0;
    background: var(--bevel-stack);
    box-shadow: none;
    text-shadow: none;
    transition-property: color, opacity;
  }
  :global(:host([data-caelestis-style='pixel']) .caelestis-bevel:hover:not(:disabled, [disabled], [aria-disabled='true'])) {
    --bevel-fill: color-mix(in srgb, var(--bevel-color) 90%, white);
    background: var(--bevel-stack);
  }
  :global(:host([data-caelestis-style='pixel']) .caelestis-bevel:is(:active, [aria-pressed='true']):not(:disabled, [disabled], [aria-disabled='true'])) {
    --bevel-top: var(--bevel-dark);
    --bevel-bottom: var(--bevel-light);
    background: var(--bevel-stack);
  }
  :global(:host([data-caelestis-style='pixel']) .caelestis-bevel:is(:disabled, [disabled], [aria-disabled='true'])) {
    --bevel-fill: var(--caelestis-raised-surface);
    --bevel-frame: color-mix(in srgb, var(--caelestis-text) 25%, var(--caelestis-raised-surface));
    --bevel-top: transparent;
    --bevel-bottom: transparent;
    background: var(--bevel-stack);
    color: color-mix(in srgb, var(--caelestis-text) 45%, var(--caelestis-raised-surface));
    filter: none;
  }
  :global(:host([data-caelestis-style='pixel']) .caelestis-bevel:focus-visible) {
    outline: 2px solid var(--caelestis-primary);
    outline-offset: 2px;
  }

  @media (forced-colors: active) {
    :global(:host([data-caelestis-style='pixel']) :is(.caelestis-surface, .caelestis-panel-surface, .caelestis-menu, .caelestis-field, .caelestis-badge)),
    :global(:host([data-caelestis-style='pixel']) select.caelestis-select),
    :global(:host([data-caelestis-style='pixel']) select.caelestis-select::picker(select)) {
      border-color: CanvasText;
      background: Canvas;
      color: CanvasText;
      box-shadow: none;
    }
    :global(:host([data-caelestis-style='pixel']) .caelestis-bevel) {
      border: 2px solid ButtonText;
      background: ButtonFace;
      color: ButtonText;
      box-shadow: none;
    }
    :global(:host([data-caelestis-style='pixel']) .caelestis-bevel:is(:active, [aria-pressed='true'])) {
      background: Highlight;
      color: HighlightText;
    }
  }
</style>
