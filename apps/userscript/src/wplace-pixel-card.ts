/**
 * Wplace's "selected pixel" card: the panel that opens on a click in explore mode, with the
 * painter, the coordinates, and a Paint button. Claim mode owns clicks on the map, so an open
 * card is stale the moment claim mode starts; this closes it the way the user would.
 *
 * The card is not a dialog. Its close control is a round `Close` button, which is what tells it
 * apart from the settings and other modals, whose close buttons live inside a `<dialog>`.
 */
import { findWplaceLabelled, wplaceLabel } from './wplace-messages.js'

const insidePaintDrawer = (button: Element): boolean => {
  for (let node = button.parentElement; node !== null; node = node.parentElement) {
    if (node === document.body) return false
    if (
      findWplaceLabelled(node, 'button', 'undo') !== null &&
      findWplaceLabelled(node, 'button', 'redo') !== null
    )
      return true
  }
  return false
}

export const dismissWplacePixelCard = (root: ParentNode = document): boolean => {
  const close = wplaceLabel('close')
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('button[aria-label]')].filter(
    (button) => button.getAttribute('aria-label') === close,
  )
  let closed = false
  for (const button of buttons) {
    if (button.closest('dialog,[role="dialog"]') !== null) continue
    if (button.closest('#caelestis-claim-mode,[id^="caelestis-"]') !== null) continue
    // The paint drawer's Close discards a draft. It is the panel with Undo and Redo beside it.
    if (insidePaintDrawer(button)) continue
    button.click()
    closed = true
  }
  return closed
}
