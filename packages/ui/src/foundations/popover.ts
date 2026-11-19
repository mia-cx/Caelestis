/** Space a floating surface keeps from every viewport edge. */
const VIEWPORT_MARGIN = 8

/** A trigger's rect, or a point (left = right, top = bottom). */
export interface Anchor {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

export const pointAnchor = (x: number, y: number): Anchor => ({
  left: x,
  right: x,
  top: y,
  bottom: y,
})

export interface PopoverPlacement {
  /** Read again on every placement, so the popover follows a trigger that moves. */
  readonly anchor: () => Anchor
  /** `below` hangs it under the anchor, flipping above where the viewport ends first; `beside` sets it past the anchor's end, flipping to its start. */
  readonly side?: 'below' | 'beside'
  /** The anchor edge the popover lines up with along the other axis. */
  readonly align?: 'start' | 'end'
  /** Space between the anchor and the popover. */
  readonly gap?: number
}

const clamp = (value: number, max: number): number =>
  Math.max(VIEWPORT_MARGIN, Math.min(value, max))

const place = (popover: HTMLElement, placement: PopoverPlacement): void => {
  const { side = 'below', align = 'start', gap = 0 } = placement
  const anchor = placement.anchor()
  const width = popover.offsetWidth
  const height = popover.offsetHeight
  const maxLeft = window.innerWidth - VIEWPORT_MARGIN - width
  const maxTop = window.innerHeight - VIEWPORT_MARGIN - height
  let left: number
  let top: number
  if (side === 'below') {
    const below = anchor.bottom + gap
    top = below > maxTop ? anchor.top - gap - height : below
    left = align === 'start' ? anchor.left : anchor.right - width
  } else {
    const after = anchor.right + gap
    left = after > maxLeft ? anchor.left - gap - width : after
    top = align === 'start' ? anchor.top : anchor.bottom - height
  }
  left = clamp(left, maxLeft)
  top = clamp(top, maxTop)
  popover.style.left = `${left}px`
  popover.style.top = `${top}px`
  // Grow out of the anchor, even where the viewport pushed the popover off it.
  const originX = Math.min(Math.max((anchor.left + anchor.right) / 2 - left, 0), width)
  const originY = Math.min(Math.max((anchor.top + anchor.bottom) / 2 - top, 0), height)
  popover.style.transformOrigin = `${originX}px ${originY}px`
}

/**
 * Keep a shown popover (position: fixed, in the top layer) against its anchor and inside the
 * viewport: placed now, and again whenever the window resizes, anything scrolls, or the popover
 * changes size. It stops when the popover closes or when the returned `stop` runs. `place`
 * re-reads the anchor, for an anchor that moved without any of those events.
 */
export const anchorPopover = (
  popover: HTMLElement,
  placement: PopoverPlacement,
): { readonly place: () => void; readonly stop: () => void } => {
  const update = (): void => place(popover, placement)
  const observer = new ResizeObserver(update)
  observer.observe(popover)
  const root = popover.getRootNode()
  // Scroll events inside a shadow root do not reach window.
  const scrollTargets: EventTarget[] = root instanceof ShadowRoot ? [window, root] : [window]
  for (const target of scrollTargets) target.addEventListener('scroll', update, true)
  window.addEventListener('resize', update)
  const closed = (event: ToggleEvent): void => {
    if (event.newState === 'closed') stop()
  }
  popover.addEventListener('toggle', closed)
  const stop = (): void => {
    observer.disconnect()
    for (const target of scrollTargets) target.removeEventListener('scroll', update, true)
    window.removeEventListener('resize', update)
    popover.removeEventListener('toggle', closed)
  }
  update()
  return { place: update, stop }
}
