import type { CaelestisElement } from '@caelestis/ui/elements'
import { activeShortcutBindings } from '../shortcut-bindings.js'
import { currentShortcutPlatform, type ShortcutPlatform } from '../shortcuts.js'
import { getState } from '../state.js'
import { closeDialogHost } from './dialog.js'
import { applyWplaceTheme } from './theme.js'

type ShortcutHelp = CaelestisElement<'caelestis-shortcut-help'>

const restoreTargets = new WeakMap<ShortcutHelp, HTMLElement | null>()

const dismiss = (help: ShortcutHelp): void => {
  if (!restoreTargets.has(help)) return
  const restoreFocusTo = restoreTargets.get(help)
  restoreTargets.delete(help)
  closeDialogHost(help)
  if (restoreFocusTo?.isConnected === true) restoreFocusTo.focus()
}

/** Toggle the shared shortcut reference while the userscript retains document and focus ownership. */
export const toggleShortcutHelp = (
  platform: ShortcutPlatform = currentShortcutPlatform(),
): void => {
  const current = document.querySelector<ShortcutHelp>(
    'caelestis-shortcut-help:not([data-state="closing"])',
  )
  if (current !== null) {
    dismiss(current)
    return
  }

  const help = document.createElement('caelestis-shortcut-help')
  help.model = {
    platform,
    bindings: activeShortcutBindings(),
    simulatedInput: getState().simulatedInput,
  }
  help.setAttribute('data-caelestis-shortcut-help', '')
  applyWplaceTheme(help)
  restoreTargets.set(
    help,
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  help.addEventListener('caelestis-shortcut-help-intent', (event) => {
    if (event.detail.type === 'close') dismiss(help)
  })
  document.body.appendChild(help)
}
