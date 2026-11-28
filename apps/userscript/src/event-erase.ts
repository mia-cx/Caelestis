import { onStateChange } from './settings.js'
import { forwardEraserKey, simulatedInputAllowed } from './simulated-input.js'
import { onWplaceLayoutChange } from './ui/wplace-rail.js'
import { arenaPaintActions, MAP_CANVAS, worldEraserActive } from './wplace-dom.js'
import { wplaceLabel } from './wplace-messages.js'
import { onPaintSelectionChange } from './wplace-paint.js'

/**
 * An Erase button for the territory event's Paint panel (#1001).
 *
 * Wplace's event panel has no eraser control on any device. Desktop painters toggle the eraser with
 * Wplace's `paint.eraser` key (E) or erase while holding the right mouse button; a phone has
 * neither, so it cannot remove drafted pixels, which the caterpillar approach to a capture leg
 * needs. This button presses that key. The painter's own taps on the map then erase through
 * Wplace's trusted click handler.
 *
 * The key is untrusted. Wplace records no Pawtect flag for it today, but could start, so the button
 * shows only while its Dangerous settings switch is on. It wears Wplace's own button classes and
 * eraser icon, and shows pressed while the map's cursor is Wplace's eraser.
 */

const BUTTON_ID = 'caelestis-event-erase'
const SVG = 'http://www.w3.org/2000/svg'
/** Wplace's eraser icon (Material Symbols ink_eraser): outlined while off, filled while on. */
const ICON = {
  off: 'M690-240h190v80H610l80-80Zm-500 80-85-85q-23-23-23.5-57t22.5-58l440-456q23-24 56.5-24t56.5 23l199 199q23 23 23 57t-23 57L520-160H190Zm296-80 314-322-198-198-442 456 64 64h262Zm-6-240Z',
  on: 'M690-240h190v80H610l80-80Zm-500 80-85-85q-23-23-23.5-57t22.5-58l440-456q23-24 56.5-24t56.5 23l199 199q23 23 23 57t-23 57L520-160H190Z',
}

let button: HTMLButtonElement | null = null
let icon: SVGPathElement | null = null
let watchedCanvas: Element | null = null
const cursorWatch = new MutationObserver(() => showPressed())

const showPressed = (): void => {
  const on = worldEraserActive()
  button?.classList.toggle('btn-primary', on)
  button?.setAttribute('aria-pressed', String(on))
  icon?.setAttribute('d', on ? ICON.on : ICON.off)
}

const createButton = (): HTMLButtonElement => {
  const created = document.createElement('button')
  created.id = BUTTON_ID
  created.type = 'button'
  created.className = 'btn btn-lg btn-square sm:btn-xl shadow-md'
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 -960 960 960')
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('class', 'size-5')
  svg.setAttribute('aria-hidden', 'true')
  icon = document.createElementNS(SVG, 'path')
  svg.append(icon)
  created.append(svg)
  created.addEventListener('click', () => {
    if (simulatedInputAllowed('event-erase')) forwardEraserKey()
  })
  return created
}

const watchCursor = (canvas: Element | null): void => {
  if (canvas === watchedCanvas) return
  cursorWatch.disconnect()
  watchedCanvas = canvas
  if (canvas !== null) cursorWatch.observe(canvas, { attributeFilter: ['style'] })
}

/** Put the button beside the open event panel's Cancel and Paint, or take it away. */
const sync = (): void => {
  const actions = simulatedInputAllowed('event-erase') ? arenaPaintActions() : null
  if (actions === null) {
    button?.remove()
    watchCursor(null)
    return
  }
  button ??= createButton()
  button.setAttribute('aria-label', wplaceLabel('eraser'))
  if (button.nextElementSibling !== actions) actions.before(button)
  watchCursor(document.querySelector(MAP_CANVAS))
  showPressed()
}

export const installEventErase = (): void => {
  onPaintSelectionChange(sync)
  onWplaceLayoutChange(sync)
  onStateChange(sync)
  sync()
}
