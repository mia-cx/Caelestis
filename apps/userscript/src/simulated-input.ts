import {
  SIMULATED_INPUT,
  type SimulatedInput,
  simulatedInputOn,
  WORLD_PIXELS,
} from '@caelestis/shared'
import { activeAllianceEditorStage } from './alliance-editor-dom.js'
import { getState } from './settings.js'
import { typingInTextField, worldPaintMounted } from './wplace-dom.js'

/**
 * Input Caelestis simulates on Wplace's controls: whether a feature may, the events it dispatches,
 * and the painter's real keys those features read.
 *
 * Wplace flags untrusted input reaching its world paint handlers, so each feature has a Dangerous
 * settings switch (`SIMULATED_INPUT` in the shared package).
 */

/**
 * Whether Caelestis is acting on an alliance canvas. The one place that decides it: an open
 * alliance editor counts even before its surface resolves, since its controls are already there.
 */
const onAllianceCanvas = (): boolean => activeAllianceEditorStage() !== null

/**
 * Whether a simulated-input feature may run.
 *
 * Wplace flags simulated input only in its world paint panel. Its alliance canvases (HQ, avatar,
 * banner) check no input at all, so there a feature always runs, unless what it dispatches still
 * reaches the world panel's listeners. Elsewhere its Dangerous settings switch decides.
 */
export const simulatedInputAllowed = (id: SimulatedInput): boolean =>
  simulatedInputOn(getState().simulatedInput, id) ||
  (onAllianceCanvas() && !(SIMULATED_INPUT[id].dispatchesToDocument && worldPaintMounted()))

const forwarded = new WeakSet<Event>()

/** Whether Caelestis dispatched this event, rather than the painter or the browser. */
export const isForwardedEvent = (event: Event): boolean => forwarded.has(event)

/** Pause or resume native Space painting, as Wplace's paint hold hears it on `document`. */
export const forwardPaintKey = (type: 'keydown' | 'keyup'): void => {
  const event = new KeyboardEvent(type, { code: 'Space', key: ' ', bubbles: true })
  forwarded.add(event)
  document.dispatchEvent(event)
}

type ClientPosition = { readonly clientX: number; readonly clientY: number }

/** Feed native movement with exact pointer coordinates without starting a gesture. */
export const forwardPaintMove = (
  target: Element,
  position: PointerEvent,
  type: 'mousemove' | 'pointermove' = 'mousemove',
  client: ClientPosition = position,
): void => {
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: client.clientX,
    clientY: client.clientY,
    buttons: position.buttons,
    altKey: position.altKey,
    ctrlKey: position.ctrlKey,
    metaKey: position.metaKey,
    shiftKey: position.shiftKey,
    pointerId: position.pointerId,
    pointerType: position.pointerType,
    isPrimary: position.isPrimary,
    button: -1,
  }
  // MouseEvent truncates fractional coordinates in Chromium, moving a boundary pick into the
  // previous paint cell. PointerEvent extends MouseEvent and preserves coordinates for either type.
  const event = new PointerEvent(type, init)
  forwarded.add(event)
  target.dispatchEvent(event)
}

/**
 * Screen positions from just past `from` up to `to`, at most one logical pixel apart when `start`
 * and `end` are the cells under them. Wplace fills a held paint line between move events, so a
 * forwarded drag must sample every cell it crosses or the fill takes the previous run's colour.
 * Without a `start` cell the move is one step. The world wraps at the antimeridian; alliance
 * canvases do not.
 */
export const moveSamples = (
  from: ClientPosition,
  to: ClientPosition,
  start: { readonly x: number; readonly y: number } | null,
  end: { readonly x: number; readonly y: number; readonly alliance: object | null },
): ClientPosition[] => {
  const dx = start === null ? 0 : Math.abs(end.x - start.x)
  const width = end.alliance === null ? Math.min(dx, WORLD_PIXELS - dx) : dx
  const steps =
    start === null ? 1 : Math.max(1, Math.ceil(Math.max(width, Math.abs(end.y - start.y))))
  return Array.from({ length: steps }, (_, index) => ({
    clientX: from.clientX + ((to.clientX - from.clientX) * (index + 1)) / steps,
    clientY: from.clientY + ((to.clientY - from.clientY) * (index + 1)) / steps,
  }))
}

const held = { space: false, shift: false }

/**
 * The painter's own keys, never forwarded ones: Shift, and Space as Wplace's paint hold hears it,
 * so Space typed into a text field does not count.
 */
export const heldKeys = (): Readonly<typeof held> => held

const releaseHeldKeys = (): void => {
  held.space = false
  held.shift = false
}

let stopTracking: (() => void) | null = null

/**
 * Track the painter's keys, once. Every reader of `heldKeys` calls this before adding its own
 * listeners: window capture listeners run in registration order, so the tracker then sees each key
 * before the reader handles it. Returns the teardown.
 */
export const installHeldKeyTracker = (): (() => void) => {
  if (stopTracking !== null) return stopTracking
  const update = (event: KeyboardEvent): void => {
    if (isForwardedEvent(event)) return
    held.shift = event.shiftKey
    if (event.code === 'Space') held.space = event.type === 'keydown' && !typingInTextField(event)
  }
  const visibility = (): void => {
    if (document.hidden) releaseHeldKeys()
  }
  window.addEventListener('keydown', update, true)
  window.addEventListener('keyup', update, true)
  window.addEventListener('blur', releaseHeldKeys)
  document.addEventListener('visibilitychange', visibility)
  stopTracking = () => {
    window.removeEventListener('keydown', update, true)
    window.removeEventListener('keyup', update, true)
    window.removeEventListener('blur', releaseHeldKeys)
    document.removeEventListener('visibilitychange', visibility)
    releaseHeldKeys()
    stopTracking = null
  }
  return stopTracking
}
