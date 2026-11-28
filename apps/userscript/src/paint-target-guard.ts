import { onAllianceArtboardNavigated } from './alliance-navigation.js'
import { activeAllianceSurface, currentSurface } from './alliance-surface.js'
import { type MapLike, onMapAttached } from './map-handle.js'
import {
  forwardPaintMove,
  heldKeys,
  installHeldKeyTracker,
  isEraserPress,
  isForwardedEvent,
  simulatedInputAllowed,
} from './simulated-input.js'
import { typingInTextField } from './wplace-dom.js'
import { isPaintOpen } from './wplace-paint.js'

/** The camera moved since Wplace last received a mouse move, so its paint target is stale. */
let stale = false
/**
 * Wplace received a Space press and no release since, so it paints along every move. Shift-paint's
 * forwarded releases clear this while the key stays down, so the refresh reads `heldKeys` instead.
 */
let holding = false
/** Space was held while the camera moved, so moves wait until it is released. */
let movesBlocked = false
let observedMap: MapLike | null = null
/** The painter's last real mouse position over this window. */
let mouse: PointerEvent | null = null

/**
 * Mark Wplace's paint target stale after the camera moved under a still mouse: a flight, a keyboard
 * pan, or an HQ jump. Alliance navigation and the world map report their moves.
 */
export const markPaintTargetStale = (): void => {
  stale = true
  if (holding) movesBlocked = true
}

/**
 * Input that keeps the same map point under the pointer while the camera moves: a drag follows the
 * pointer and a wheel zoom pivots on it. Inertia after a release carries the release event
 * (`mouseup`, `touchend`) and moves the map under a still pointer, so it is not listed.
 */
const POINTER_ANCHORED = new Set(['mousemove', 'pointermove', 'touchmove', 'wheel'])

/** World camera moves; a drag with Space held must keep panning, so anchored moves are exempt. */
const worldCameraMoved = ({ originalEvent }: { readonly originalEvent?: Event }): void => {
  if (originalEvent === undefined || !POINTER_ANCHORED.has(originalEvent.type))
    markPaintTargetStale()
}

/**
 * Move Wplace's paint target to where the still mouse now points by forwarding a move. On the world
 * map Wplace flags it as UntrustedPointer, so it waits for the `cursor-refresh` switch there; on an
 * alliance canvas the move is a `pointermove` on its frame, which nothing checks. While Space is
 * held through the camera move nothing is forwarded, so a held gesture never paints where the
 * camera landed.
 */
export const refreshPaintTarget = (root: Element, type: 'mousemove' | 'pointermove'): void => {
  if (!simulatedInputAllowed('cursor-refresh') || heldKeys().space) return
  if (mouse === null || !isPaintOpen() || !root.isConnected) return
  const target = document.elementFromPoint(mouse.clientX, mouse.clientY)
  if (target === null || !root.contains(target)) return
  forwardPaintMove(target, mouse, type)
}

const worldCameraSettled = (): void => {
  if (observedMap !== null && currentSurface().kind === 'world')
    refreshPaintTarget(observedMap.getCanvas(), 'mousemove')
}

/** Follow the current map across SPA replacements without retaining old map listeners. */
export const syncPaintTargetMap = (map: MapLike | null): void => {
  if (map === observedMap) return
  observedMap?.off('move', worldCameraMoved)
  observedMap?.off('moveend', worldCameraSettled)
  observedMap = map
  observedMap?.on('move', worldCameraMoved)
  observedMap?.on('moveend', worldCameraSettled)
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
  installHeldKeyTracker()
  const keydown = (event: KeyboardEvent): void => {
    // Erase bound to Space switches the tool and paints nothing, so it always reaches Wplace.
    if (event.code !== 'Space' || !isPaintOpen() || isEraserPress(event)) return
    if (typingInTextField(event)) return
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
  const remember = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && !isForwardedEvent(event)) mouse = event
  }
  const leave = (event: PointerEvent): void => {
    if (event.relatedTarget === null) mouse = null
  }
  const keyup = (event: KeyboardEvent): void => {
    if (event.code === 'Space') release()
  }
  const blur = (): void => {
    release()
    mouse = null
  }
  const visibility = (): void => {
    if (document.hidden) blur()
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
  const pointers = ['pointerdown', 'pointermove', 'pointerup'] as const
  for (const type of pointers) window.addEventListener(type, remember, true)
  window.addEventListener('pointerout', leave, true)
  window.addEventListener('keydown', keydown, true)
  window.addEventListener('keyup', keyup, true)
  for (const type of moves) {
    window.addEventListener(type, block, true)
    window.addEventListener(type, delivered)
  }
  window.addEventListener('blur', blur)
  document.addEventListener('visibilitychange', visibility)
  const stopNavigation = onAllianceArtboardNavigated((active) => {
    markPaintTargetStale()
    requestAnimationFrame(() => refreshPaintTarget(active.frame, 'pointermove'))
  })
  const stopFollowingMap = onMapAttached(syncPaintTargetMap)
  return () => {
    stopNavigation()
    stopFollowingMap()
    for (const type of pointers) window.removeEventListener(type, remember, true)
    window.removeEventListener('pointerout', leave, true)
    window.removeEventListener('keydown', keydown, true)
    window.removeEventListener('keyup', keyup, true)
    for (const type of moves) {
      window.removeEventListener(type, block, true)
      window.removeEventListener(type, delivered)
    }
    window.removeEventListener('blur', blur)
    document.removeEventListener('visibilitychange', visibility)
    syncPaintTargetMap(null)
    stale = false
    blur()
  }
}
