import type {
  CaelestisRailControl,
  RailControlIntent,
  RailControlModel,
} from '@caelestis/ui/elements'
import { applyWplaceTheme } from './theme.js'

interface RailButtonOptions {
  readonly model: RailControlModel
  /** Runs when the button's own control is activated. */
  readonly activate: () => void
  readonly id?: string
  /** The document the button lives in: an alliance editor's, or the page's. */
  readonly document?: Document
  /** Also activate on a click aimed at the host element itself, not only through its intent. */
  readonly hostClick?: boolean
  /** Keep pointerdown from reaching an artboard underneath that captures the pointer. */
  readonly isolatePointerDown?: boolean
}

/** One Wplace-themed rail button: the model it shows and what pressing it does. */
export const mountRailButton = ({
  model,
  activate,
  id,
  document: owner = document,
  hostClick = false,
  isolatePointerDown = false,
}: RailButtonOptions): CaelestisRailControl => {
  const button = owner.createElement('caelestis-rail-control')
  if (id !== undefined) button.id = id
  button.model = model
  applyWplaceTheme(button)
  if (isolatePointerDown) button.addEventListener('pointerdown', (event) => event.stopPropagation())
  button.addEventListener('caelestis-rail-intent', (event) => {
    if ((event as CustomEvent<RailControlIntent>).detail.id === model.id) activate()
  })
  if (hostClick) {
    button.addEventListener('click', (event) => {
      if (event.composedPath()[0] === button) activate()
    })
  }
  return button
}
