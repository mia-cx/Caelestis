import {
  MAX_PRESENCE_REGION_PIXELS,
  MAX_QUICK_CLAIMS,
  type Point,
  type PresenceRect,
  rectContains,
  worldPixel,
} from '@caelestis/shared'
import { log } from './debug.js'
import { CLICK_SLOP_PX, swallowNextClick } from './map-pointer.js'
import { pickerPointAt } from './paint-cell.js'
import { presenceQuickClaims, setPresenceQuickClaims } from './presence-client.js'
import { getState, onStateChange } from './settings.js'
import { showToast } from './ui/notification-host.js'
import { isPaintOpen, onPaintSelectionChange } from './wplace-paint.js'

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

/**
 * The rectangle spanned by the canvas pixels under two points, both included, kept on the world
 * canvas. Points are fractional where the pointer falls inside a pixel; each snaps to the pixel it
 * is in, nearest-neighbour, so a claim always covers whole pixels.
 */
export const quickClaimRect = (from: Point, to: Point): PresenceRect => {
  const left = worldPixel(Math.min(from.x, to.x))
  const top = worldPixel(Math.min(from.y, to.y))
  const right = worldPixel(Math.max(from.x, to.x))
  const bottom = worldPixel(Math.max(from.y, to.y))
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }
}

/** The newest quick claim containing a canvas pixel, or -1. */
export const quickClaimAt = (rects: readonly PresenceRect[], point: Point): number => {
  for (let index = rects.length - 1; index >= 0; index--)
    if (rectContains(rects[index] as PresenceRect, point)) return index
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

interface Drag {
  readonly pointerId: number
  readonly startClient: Point
  readonly start: Point
  current: Point
  dragging: boolean
  /** Escape ends the claim but not the gesture: the rest of it still stays away from Wplace. */
  cancelled: boolean
}

let drag: Drag | null = null
const listeners: (() => void)[] = []

const changed = (): void => {
  for (const listener of listeners) listener()
}

/** Runs when the rectangle being dragged changes, so the map can redraw it. */
export const onQuickClaimPreviewChange = (listener: () => void): void => {
  listeners.push(listener)
}

/** The rectangle being dragged out, or null. */
export const quickClaimPreview = (): PresenceRect | null =>
  drag?.dragging && !drag.cancelled ? quickClaimRect(drag.start, drag.current) : null

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
  if (!held.dragging && moved < CLICK_SLOP_PX) return
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
  swallowNextClick(() => true, 0)
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
      if (
        !event.ctrlKey ||
        (event.button !== 0 && event.button !== 2) ||
        !isPaintOpen() ||
        // A quick claim nobody else can see claims nothing; the gesture stays Wplace's.
        !getState().sharePresence
      )
        return
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
  // Stopping sharing ends them too, so they cannot come back for everyone when sharing resumes.
  onStateChange((state) => {
    if (state.sharePresence) return
    // A drag in progress ends like an Escape: no claim, and the rest of the gesture stays ours.
    if (drag !== null && !drag.cancelled) {
      drag.cancelled = true
      changed()
    }
    if (presenceQuickClaims().length > 0) setPresenceQuickClaims([])
  })
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
