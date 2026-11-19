<!-- Shared by native selects and custom menus, including inside userscript shadow roots. -->
<style>
  :global(.caelestis-select), :global(.caelestis-menu) {
    --menu-radius: var(--caelestis-radius);
    --menu-item-radius: var(--caelestis-radius);
    --menu-padding: 0.25rem;
    --menu-surface: var(--caelestis-surface);
    --menu-text: var(--caelestis-text);
    --menu-border: var(--caelestis-border);
    --menu-hover: color-mix(in oklab, var(--menu-text) 10%, transparent);
    box-sizing: border-box;
    color: var(--menu-text);
    /* A host on its own type sets --menu-font; the userscript keeps the system face over Wplace. */
    font: var(--menu-font, 400 0.875rem/1.35 var(--caelestis-font));
  }
  :global(select.caelestis-select) {
    appearance: none;
    min-inline-size: 0;
    max-inline-size: 100%;
    block-size: 2rem;
    padding-inline: 0.75rem 1.75rem;
    border: 1px solid var(--menu-border);
    border-radius: var(--menu-radius);
    background-color: var(--menu-surface);
    background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
    background-position: calc(100% - 20px) calc(1px + 50%), calc(100% - 16.1px) calc(1px + 50%);
    background-repeat: no-repeat;
    background-size: 4px 4px;
    box-shadow: 0 1px color-mix(in oklab, var(--menu-text) 10%, transparent) inset;
    cursor: pointer;
    touch-action: manipulation;
  }
  @supports (appearance: base-select) {
    :global(select.caelestis-select), :global(select.caelestis-select::picker(select)) { appearance: base-select; }
  }
  :global(select.caelestis-select::picker-icon) { display: none; }
  /* The face `selectFace` adds: the chosen option, cut short with an ellipsis before the caret. */
  :global(.caelestis-select-face) {
    display: flex;
    align-items: center;
    inline-size: 100%;
    min-inline-size: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
  }
  :global(.caelestis-select-face selectedcontent) { display: block; min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  :global(.caelestis-menu) {
    box-sizing: border-box;
    padding: var(--menu-padding);
    border: 1px solid var(--menu-border);
    border-radius: var(--menu-radius);
    background: var(--menu-surface);
    color: var(--menu-text);
    box-shadow: var(--menu-shadow, 0 8px 24px #0002);
  }
  /* Keep picker selectors separate so unsupported browsers retain custom-menu styles. */
  :global(select.caelestis-select::picker(select)) {
    box-sizing: border-box;
    padding: var(--menu-padding);
    border: 1px solid var(--menu-border);
    border-radius: var(--menu-radius);
    background: var(--menu-surface);
    color: var(--menu-text);
    box-shadow: 0 8px 24px #0002;
  }
  :global(select.caelestis-select::picker(select)) { margin-block: 0.5rem; max-block-size: min(24rem, 70dvh); }
  :global(.caelestis-menu-item), :global(select.caelestis-select option) {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-block-size: 2rem;
    padding: 0.375rem 0.625rem;
    border: 0;
    border-radius: var(--menu-item-radius);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    white-space: normal;
    cursor: pointer;
  }
  :global(.caelestis-menu-separator) { flex: 0 0 auto; block-size: 1px; margin: var(--menu-padding) 0.375rem; border: 0; background: var(--menu-border); }
  :global(.caelestis-menu-item:is(:hover, :focus-visible, [data-selected])),
  :global(select.caelestis-select option:is(:hover, :focus-visible)) { background: var(--menu-hover); }
  :global(.caelestis-menu-item:focus-visible) { outline: 2px solid var(--caelestis-focus); outline-offset: -2px; }
  :global(select.caelestis-select:focus-visible) { outline: 2px solid var(--caelestis-focus); outline-offset: 2px; }
  :global(select.caelestis-select:disabled), :global(.caelestis-menu-item:is(:disabled, [data-disabled])) { opacity: 0.5; cursor: not-allowed; }

  /*
   * A floating menu or popover placed by `anchorPopover`: it scales and fades out of its anchor.
   * A popover opens with `:popover-open`. A surface mounted and removed through
   * `openSurface`/`closeSurface` carries `data-surface`, and its `data-state` drives the motion.
   */
  :global(.caelestis-dropdown) {
    --dropdown-open-dur: var(--caelestis-duration-fast);
    --dropdown-close-dur: var(--caelestis-duration-quick);
    --dropdown-pre-scale: var(--caelestis-scale-medium);
    --dropdown-closing-scale: var(--caelestis-scale-tiny);
    --dropdown-ease: var(--caelestis-ease-smooth-out);
    --caelestis-surface-close-duration: var(--dropdown-close-dur);
    position: fixed;
    inset: auto;
    margin: 0;
    z-index: 60;
    flex-direction: column;
    max-inline-size: calc(100vw - 1rem);
    max-block-size: calc(100vh - 1rem);
    overflow: auto;
    transform: scale(var(--dropdown-pre-scale));
    opacity: 0;
    pointer-events: none;
    transition:
      transform var(--dropdown-close-dur) var(--dropdown-ease),
      opacity var(--dropdown-close-dur) var(--dropdown-ease),
      overlay var(--dropdown-close-dur) var(--dropdown-ease) allow-discrete,
      display var(--dropdown-close-dur) var(--dropdown-ease) allow-discrete;
    will-change: transform, opacity;
  }
  :global(.caelestis-dropdown:is(:popover-open:not([data-surface]), [data-surface][data-state='open'])) {
    display: flex;
    transform: scale(1);
    opacity: 1;
    pointer-events: auto;
    transition:
      transform var(--dropdown-open-dur) var(--dropdown-ease),
      opacity var(--dropdown-open-dur) var(--dropdown-ease),
      overlay var(--dropdown-open-dur) var(--dropdown-ease) allow-discrete,
      display var(--dropdown-open-dur) var(--dropdown-ease) allow-discrete;
  }
  :global(.caelestis-dropdown:popover-open:not([data-surface])) {
    @starting-style { transform: scale(var(--dropdown-pre-scale)); opacity: 0; }
  }
  :global(.caelestis-dropdown[data-surface]:popover-open) { display: flex; }
  :global(.caelestis-dropdown[data-surface][data-state='closing']) { transform: scale(var(--dropdown-closing-scale)); }
  @media (prefers-reduced-motion: reduce) {
    :global(.caelestis-dropdown) { transition: none !important; }
  }

  /* The field look: a search box and the square triggers that sit beside it. */
  :global(.caelestis-field-look) {
    border: 1px solid color-mix(in oklab, var(--caelestis-text) 20%, transparent);
    border-radius: var(--caelestis-radius);
    background: var(--caelestis-surface);
    box-shadow: 0 1px color-mix(in oklab, var(--caelestis-text) 10%, transparent) inset;
  }
</style>
