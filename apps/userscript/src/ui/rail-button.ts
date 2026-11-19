import type { CaelestisElement, RailControlModel } from '@caelestis/ui/elements'
import { applyWplaceTheme } from './theme.js'

export type RailControl = CaelestisElement<'caelestis-rail-control'>

interface RailButtonOptions {
  readonly model: RailControlModel
  /** Runs when the button is clicked. */
  readonly activate: () => void
  readonly id?: string
  /** The document the button lives in: an alliance editor's, or the page's. */
  readonly document?: Document
  /** Keep pointerdown from reaching an artboard underneath that captures the pointer. */
  readonly isolatePointerDown?: boolean
}

/** One Wplace-themed rail button: the model it shows and what pressing it does. */
export const mountRailButton = ({
  model,
  activate,
  id,
  document: owner = document,
  isolatePointerDown = false,
}: RailButtonOptions): RailControl => {
  const button = owner.createElement('caelestis-rail-control')
  if (id !== undefined) button.id = id
  button.model = model
  applyWplaceTheme(button)
  if (isolatePointerDown) button.addEventListener('pointerdown', (event) => event.stopPropagation())
  button.addEventListener('click', activate)
  return button
}
