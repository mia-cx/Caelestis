<script lang="ts">
  import { onMount, type Snippet } from 'svelte'
  import ModalStyles from './ModalStyles.svelte'
  import { cancelSurfaceClose, closeSurface } from './motion.js'

  /**
   * A native modal dialog with the shared frame and transition. It opens as soon as it mounts
   * unless `open` says otherwise; setting `open` to false closes it, runs the exit, then calls
   * `onClosed`.
   */
  let {
    open = true,
    labelledby,
    describedby,
    width = '28rem',
    lightDismiss = true,
    initialFocus,
    onClose,
    onClosed,
    children,
  }: {
    open?: boolean
    labelledby: string
    describedby?: string
    width?: string
    /** Whether a press on the backdrop asks to close, as Escape does. */
    lightDismiss?: boolean
    /** Focused each time the dialog opens; otherwise the browser focuses its first control. */
    initialFocus?: HTMLElement | undefined
    /** Escape, or a backdrop press under `lightDismiss`. Without it the dialog ignores both. */
    onClose?: () => void
    onClosed?: () => void
    children: Snippet
  } = $props()

  let dialog: HTMLDialogElement
  // A drag from a field inside the dialog to outside it fires `click` on the dialog itself, so
  // only a press that began on the backdrop counts as a backdrop click.
  let backdropPress = false

  $effect(() => {
    if (open) {
      cancelSurfaceClose(dialog)
      if (!dialog.open) dialog.showModal()
      initialFocus?.focus()
      return
    }
    if (!dialog.open) return
    dialog.close()
    return closeSurface(dialog, () => onClosed?.())
  })

  onMount(() => {
    const node = dialog
    return () => { if (node.open) node.close() }
  })
</script>

<ModalStyles />

<dialog
  bind:this={dialog}
  class="caelestis-modal caelestis-panel-surface"
  style:--modal-width={width}
  aria-labelledby={labelledby}
  aria-describedby={describedby}
  oncancel={(event) => { event.preventDefault(); onClose?.() }}
  onpointerdown={(event) => { backdropPress = event.target === dialog }}
  onclick={(event) => { if (lightDismiss && backdropPress && event.target === dialog) onClose?.(); backdropPress = false }}
>
  {@render children()}
</dialog>

<style>
  dialog {
    box-sizing: border-box;
    inline-size: min(var(--modal-width), calc(100vw - 2rem));
    max-inline-size: none;
    max-block-size: calc(100dvh - 2rem);
    padding: 0;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius);
    background: var(--caelestis-surface);
    color: var(--caelestis-text);
    box-shadow: var(--caelestis-shadow);
    font: 0.875rem/1.4 var(--caelestis-font);
  }
  @media (forced-colors: active) {
    dialog { border-color: CanvasText; }
  }
</style>
