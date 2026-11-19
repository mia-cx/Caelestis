<!--
  The native modal role: `dialog.caelestis-modal` scales and fades in on `[open]` and back out on
  close, with a dimmed backdrop. A dialog overrides the `--modal-*` properties to change its
  timing; `--modal-scale: none` drops the scale, so an open dialog is never a transformed
  ancestor of its fixed-position content.
-->
<style>
  :global(dialog.caelestis-modal) {
    --modal-open-dur: var(--caelestis-duration-fast);
    --modal-close-dur: var(--caelestis-duration-quick);
    --modal-scale: var(--caelestis-scale-large);
    --modal-ease: var(--caelestis-ease-smooth-out);
    --caelestis-surface-close-duration: var(--modal-close-dur);
    scale: var(--modal-scale);
    opacity: 0;
    pointer-events: none;
    transition:
      scale   var(--modal-close-dur) var(--modal-ease),
      opacity var(--modal-close-dur) var(--modal-ease),
      overlay var(--modal-close-dur) var(--modal-ease) allow-discrete,
      display var(--modal-close-dur) var(--modal-ease) allow-discrete;
  }
  :global(dialog.caelestis-modal[open]) {
    scale: none;
    opacity: 1;
    pointer-events: auto;
    transition:
      scale   var(--modal-open-dur) var(--modal-ease),
      opacity var(--modal-open-dur) var(--modal-ease),
      overlay var(--modal-open-dur) var(--modal-ease) allow-discrete,
      display var(--modal-open-dur) var(--modal-ease) allow-discrete;
    @starting-style { scale: var(--modal-scale); opacity: 0; }
  }
  :global(dialog.caelestis-modal::backdrop) {
    background: rgb(0 0 0 / 0.4);
    opacity: 0;
    transition:
      opacity var(--modal-close-dur) var(--modal-ease),
      overlay var(--modal-close-dur) var(--modal-ease) allow-discrete,
      display var(--modal-close-dur) var(--modal-ease) allow-discrete;
  }
  :global(dialog.caelestis-modal[open]::backdrop) {
    opacity: 1;
    transition-duration: var(--modal-open-dur);
    @starting-style { opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(dialog.caelestis-modal), :global(dialog.caelestis-modal::backdrop) { transition: none !important; }
  }
</style>
