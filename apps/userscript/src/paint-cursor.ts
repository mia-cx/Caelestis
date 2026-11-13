import { activeAllianceSurface } from './alliance-surface.js'
import type { MapLike } from './map-handle.js'
import { isPaintOpen } from './wplace-paint.js'

const forwardedMoves = new WeakSet<Event>()
const forwardedKeys = new WeakSet<Event>()

/** Whether a Space transition belongs to filtered painting rather than the physical keyboard. */
export const isForwardedPaintKey = (event: Event): boolean => forwardedKeys.has(event)

/** Pause or resume native Space painting without changing our physical-key tracking. */
export const forwardPaintKey = (type: 'keydown' | 'keyup'): void => {
  const event = new KeyboardEvent(type, { code: 'Space', key: ' ', bubbles: true })
  forwardedKeys.add(event)
  document.dispatchEvent(event)
}

/** Whether this is movement forwarded by Caelestis rather than a compatibility mouse event. */
export const isForwardedPaintMove = (event: Event): boolean => forwardedMoves.has(event)

/** Feed native movement with exact pointer coordinates without starting a gesture. */
export const forwardPaintMove = (
  target: Element,
  position: PointerEvent,
  type: 'mousemove' | 'pointermove' = 'mousemove',
  client: { clientX: number; clientY: number } = position,
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
  forwardedMoves.add(event)
  target.dispatchEvent(event)
}

/** Text fields, where Space types instead of painting. Wplace's paint hold skips the same ones. */
const TEXT_FIELD =
  'input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"]), textarea, select, [contenteditable]:not([contenteditable="false"])'

/** The camera moved since Wplace last received a mouse move, so its paint target is stale. */
let stale = false
/** Wplace received a Space press and no release since, so it paints along every move. */
let holding = false
/** Space was held while the camera moved, so moves wait until it is released. */
let movesBlocked = false
let observedMap: MapLike | null = null

/**
 * Mark Wplace's paint target stale after the camera moved under a still mouse: a flight, a keyboard
 * pan, or an HQ jump. Alliance navigation calls this directly; the world map reports its moves.
 */
export const markPaintTargetStale = (): void => {
  stale = true
  if (holding) movesBlocked = true
}

/**
 * Drags, wheel zooms, and touch gestures keep the same map point under the pointer, so Wplace's
 * target stays correct and a drag with Space held must keep panning.
 */
const worldCameraMoved = ({ originalEvent }: { readonly originalEvent?: Event }): void => {
  const pointerDriven =
    originalEvent instanceof MouseEvent ||
    originalEvent instanceof WheelEvent ||
    (typeof TouchEvent !== 'undefined' && originalEvent instanceof TouchEvent)
  if (!pointerDriven) markPaintTargetStale()
}

/** Follow the current map across SPA replacements without retaining old map listeners. */
export const syncPaintTargetMap = (map: MapLike | null): void => {
  if (map === observedMap) return
  observedMap?.off('move', worldCameraMoved)
  observedMap = map
  observedMap?.on('move', worldCameraMoved)
}

/**
 * Keep Space from painting where the mouse pointed before the camera moved.
 *
 * Wplace paints at the last mouse position it received, so a flight, jump, or pan under a still
 * mouse leaves that position behind. Until a move reaches Wplace again, Space presses are
 * swallowed. If Space is already held while the camera moves, moves are swallowed until it is
 * released, so Wplace never draws a line from the old position to the new one. The guard only
 * filters the painter's own input and dispatches none. Returns its teardown.
 */
export const installPaintTargetGuard = (): (() => void) => {
  const keydown = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' || !isPaintOpen()) return
    const typing = event
      .composedPath()
      .some((target) => target instanceof Element && target.matches(TEXT_FIELD))
    if (typing) return
    if (!stale) {
      holding = true
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const release = (): void => {
    holding = false
    movesBlocked = false
  }
  const keyup = (event: KeyboardEvent): void => {
    if (event.code === 'Space') release()
  }
  const visibility = (): void => {
    if (document.hidden) release()
  }
  const block = (event: Event): void => {
    if (movesBlocked) event.stopImmediatePropagation()
  }
  // Runs after the page's own listeners: a move that gets here was not stopped on its way to Wplace.
  // The world map takes its target from any mouse move, HQ's artboard from pointer moves over it.
  const delivered = (event: Event): void => {
    const alliance = activeAllianceSurface()
    const reached =
      alliance === null
        ? event.type === 'mousemove'
        : event.type === 'pointermove' && event.composedPath().includes(alliance.stage)
    if (reached) stale = false
  }
  const moves = ['mousemove', 'pointermove'] as const
  window.addEventListener('keydown', keydown, true)
  window.addEventListener('keyup', keyup, true)
  for (const type of moves) {
    window.addEventListener(type, block, true)
    window.addEventListener(type, delivered)
  }
  window.addEventListener('blur', release)
  document.addEventListener('visibilitychange', visibility)
  return () => {
    window.removeEventListener('keydown', keydown, true)
    window.removeEventListener('keyup', keyup, true)
    for (const type of moves) {
      window.removeEventListener(type, block, true)
      window.removeEventListener(type, delivered)
    }
    window.removeEventListener('blur', release)
    document.removeEventListener('visibilitychange', visibility)
    syncPaintTargetMap(null)
    stale = false
    release()
  }
}
