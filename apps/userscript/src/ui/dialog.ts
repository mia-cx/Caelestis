import { closeSurface } from '@caelestis/ui/motion'

/** Release native modality now, retaining only the host's visual shell for the CSS exit. */
export const closeDialogHost = (host: HTMLElement): void => {
  if (host.dataset.state === 'closing') return
  host.dataset.state = 'closing'
  const dialog = host.shadowRoot?.querySelector('dialog')
  if (dialog === null || dialog === undefined) {
    host.remove()
    return
  }
  dialog.close()
  closeSurface(dialog, () => host.remove(), '--modal-close-dur')
}
