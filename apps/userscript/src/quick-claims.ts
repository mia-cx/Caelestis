import {
  MAX_PRESENCE_REGION_PIXELS,
  MAX_QUICK_CLAIMS,
  type PainterIdentity,
  type PresenceRect,
  WORLD_PIXELS,
} from '@caelestis/shared'
import { log } from './debug.js'
import { claimsVisible } from './presence-claims.js'
import {
  type PresenceView,
  presenceQuickClaims,
  setPresenceQuickClaims,
} from './presence-client.js'
import { getState } from './state.js'
import { showToast } from './ui/notification-host.js'
import { isPaintOpen, onPaintSelectionChange } from './wplace-paint.js'
import { pickerPointAt } from './wplace-picker.js'

/**
 * Quick claims: while Wplace's paint drawer is open, Ctrl+drag on the map marks a rectangle as
 * yours for this paint session. Ctrl+click inside one of them, without dragging, removes it.
 *
 * They are presence state, not stored claims. Closing the drawer (painting or cancelling) clears
 * them here, and the server forgets them with the tab's presence session, so a lost message or a
 * crashed tab can never leave one behind.
 *
 * Ctrl is Ctrl on every platform. macOS turns Ctrl+click into a secondary click, so the context
 * menu is suppressed over the map while the drawer is open, and only there.
 */

type Point = { readonly x: number; readonly y: number }

/** CSS pixels the pointer must travel before a Ctrl+press counts as a drag, not a click. */
const DRAG_DISTANCE = 4

/**
 * The rectangle spanned by the canvas pixels under two points, both included, kept on the world
 * canvas. Points are fractional where the pointer falls inside a pixel; each snaps to the pixel it
 * is in, nearest-neighbour, so a claim always covers whole pixels.
 */
export const quickClaimRect = (from: Point, to: Point): PresenceRect => {
  const clamp = (value: number): number =>
    Math.min(WORLD_PIXELS - 1, Math.max(0, Math.floor(value)))
  const left = clamp(Math.min(from.x, to.x))
  const top = clamp(Math.min(from.y, to.y))
  const right = clamp(Math.max(from.x, to.x))
  const bottom = clamp(Math.max(from.y, to.y))
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }
}

/** The newest quick claim containing a canvas pixel, or -1. */
export const quickClaimAt = (rects: readonly PresenceRect[], point: Point): number => {
  for (let index = rects.length - 1; index >= 0; index--) {
    const rect = rects[index]
    if (
      rect !== undefined &&
      point.x >= rect.x &&
      point.y >= rect.y &&
      point.x < rect.x + rect.w &&
      point.y < rect.y + rect.h
    )
      return index
  }
  return -1
}

/** Add a rectangle, or say why it cannot be added. */
export const withQuickClaim = (
  rects: readonly PresenceRect[],
  rect: PresenceRect,
): readonly PresenceRect[] | 'limit' | 'area' => {
  if (rect.w * rect.h > MAX_PRESENCE_REGION_PIXELS) return 'area'
  if (rects.length >= MAX_QUICK_CLAIMS) return 'limit'
  return [...rects, rect]
}

export interface QuickClaimItem {
  readonly key: string
  readonly rect: PresenceRect
  readonly painter: PainterIdentity | null
  /** Yours: its fill steps aside under the pointer so you can see what you paint. */
  readonly mine: boolean
}

interface Drag {
  readonly pointerId: number
  readonly startClient: Point
  readonly start: Point
  current: Point
  dragging: boolean
  /** Escape ends the claim but not the gesture: the rest of it still stays away from Wplace. */
  cancelled: boolean
}

/** The key the rectangle being dragged is drawn under; it follows the pointer, so it never fades. */
export const QUICK_CLAIM_PREVIEW_KEY = 'quick:me:preview'

let drag: Drag | null = null
/** Set from a gesture's release until the click it produces, which Wplace must not see either. */
let swallowClick = false
const listeners: (() => void)[] = []

const changed = (): void => {
  for (const listener of listeners) listener()
}

/** Runs when the rectangle being dragged changes, so the map can redraw it. */
export const onQuickClaimPreviewChange = (listener: () => void): void => {
  listeners.push(listener)
}

/**
 * What to draw: your quick claims and the one being dragged, always while you paint, and other
 * painters' quick claims wherever their claims would show.
 */
export const quickClaimItems = (view: PresenceView): QuickClaimItem[] => {
  const items: QuickClaimItem[] = presenceQuickClaims().map((rect, index) => ({
    key: `quick:me:${index}`,
    rect,
    painter: view.me,
    mine: true,
  }))
  if (drag?.dragging && !drag.cancelled) {
    items.push({
      key: QUICK_CLAIM_PREVIEW_KEY,
      rect: quickClaimRect(drag.start, drag.current),
      painter: view.me,
      mine: false,
    })
  }
  if (claimsVisible(getState(), isPaintOpen()))
    for (const peer of view.peers)
      for (const [index, rect] of (peer.quickClaims ?? []).entries())
        items.push({
          key: `quick:${peer.sessionId}:${index}`,
          rect,
          painter: peer.painter,
          mine: false,
        })
  return items
}

/**
 * The world-canvas pixel under the pointer, only when the map itself is under it. The map reports
 * a fractional position inside the pixel; the pixel is the one that contains it.
 */
const worldPointAt = (event: PointerEvent | MouseEvent): Point | null => {
  const target = event.target
  if (!(target instanceof Element)) return null
  const point = pickerPointAt(target, event.clientX, event.clientY)
  return point === null || point.alliance !== null
    ? null
    : { x: Math.floor(point.x), y: Math.floor(point.y) }
}

/** Keep one pointer sequence away from Wplace's paint, pan and rotate handlers. */
const swallow = (event: Event): void => {
  event.preventDefault()
  event.stopImmediatePropagation()
}

/** Follow the pointer once it has travelled far enough to count as a drag. */
const track = (held: Drag, event: PointerEvent): void => {
  const moved = Math.hypot(event.clientX - held.startClient.x, event.clientY - held.startClient.y)
  if (!held.dragging && moved < DRAG_DISTANCE) return
  held.dragging = true
  held.current = worldPointAt(event) ?? held.current
}

const finish = (event: PointerEvent): void => {
  const held = drag
  if (held === null || event.pointerId !== held.pointerId) return
  swallow(event)
  drag = null
  // The browser dispatches this release's click before its next task; after that, clicks are
  // ordinary again.
  swallowClick = true
  setTimeout(() => {
    swallowClick = false
  }, 0)
  if (held.cancelled) return
  // The release is the last position, and may be the only one the pointer reported out here.
  track(held, event)
  const rects = presenceQuickClaims()
  if (!held.dragging) {
    const index = quickClaimAt(rects, held.start)
    if (index >= 0) setPresenceQuickClaims(rects.filter((_, at) => at !== index))
    return
  }
  changed()
  const next = withQuickClaim(rects, quickClaimRect(held.start, held.current))
  if (next === 'limit')
    showToast(`You can hold ${MAX_QUICK_CLAIMS} quick claims while painting.`, 'warning')
  else if (next === 'area')
    showToast('That quick claim is too large. Draw a smaller one.', 'warning')
  else {
    setPresenceQuickClaims(next)
    log('install', 'quick claim added', { count: next.length })
  }
}

let installed = false

/** Install once. Clears quick claims whenever the paint drawer closes. */
export const installQuickClaims = (): void => {
  if (installed) return
  installed = true
  window.addEventListener(
    'pointerdown',
    (event) => {
      // macOS reports a Ctrl+click as the secondary button on some browsers.
      if (!event.ctrlKey || (event.button !== 0 && event.button !== 2) || !isPaintOpen()) return
      const point = worldPointAt(event)
      if (point === null) return
      swallow(event)
      drag = {
        pointerId: event.pointerId,
        startClient: { x: event.clientX, y: event.clientY },
        start: point,
        current: point,
        dragging: false,
        cancelled: false,
      }
    },
    { capture: true },
  )
  window.addEventListener(
    'pointermove',
    (event) => {
      if (drag === null || event.pointerId !== drag.pointerId) return
      swallow(event)
      if (drag.cancelled) return
      track(drag, event)
      if (drag.dragging) changed()
    },
    { capture: true },
  )
  window.addEventListener('pointerup', finish, { capture: true })
  for (const type of ['click', 'auxclick'])
    window.addEventListener(
      type,
      (event) => {
        if (!swallowClick) return
        swallowClick = false
        swallow(event)
      },
      { capture: true },
    )
  window.addEventListener(
    'pointercancel',
    (event) => {
      if (drag === null || event.pointerId !== drag.pointerId) return
      drag = null
      changed()
    },
    { capture: true },
  )
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || drag === null || drag.cancelled) return
      swallow(event)
      drag.cancelled = true
      changed()
    },
    { capture: true },
  )
  window.addEventListener(
    'contextmenu',
    (event) => {
      if (drag === null && !(event.ctrlKey && isPaintOpen() && worldPointAt(event) !== null)) return
      swallow(event)
    },
    { capture: true },
  )
  // Painting and cancelling both close the drawer; either way the paint session is over.
  onPaintSelectionChange(() => {
    if (isPaintOpen()) return
    if (drag !== null) {
      drag.cancelled = true
      changed()
    }
    setPresenceQuickClaims([])
  })
}
