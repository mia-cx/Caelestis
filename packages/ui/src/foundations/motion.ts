/**
 * Shared open/close orchestration for surfaces that are mounted and removed from the DOM rather
 * than toggled by the top layer (popover/dialog). The CSS side reads `data-state` ("open" |
 * "closing") and declares its own durations via `--caelestis-surface-close-duration`, so timing
 * lives next to the transition it drives.
 *
 * Close must outlive the decision that caused it: `closeSurface` keeps the element and flips it to
 * `data-state="closing"` for the declared close duration, then runs `finish` — usually `remove()`
 * or dropping a `{#if}` flag. The returned cancel function is what makes a reopen during a close
 * reverse from the current frame instead of snapping back to the closing scale.
 */

export const SURFACE_CLOSE_DURATION = '--caelestis-surface-close-duration'

const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const parseDurationMs = (value: string): number => {
  const trimmed = value.trim()
  if (trimmed.endsWith('ms')) return Number.parseFloat(trimmed) || 0
  if (trimmed.endsWith('s')) return (Number.parseFloat(trimmed) || 0) * 1000
  return Number.parseFloat(trimmed) || 0
}

/** The element's declared close duration in milliseconds; 0 means "close instantly". */
export const surfaceCloseDurationMs = (
  element: HTMLElement,
  property: string = SURFACE_CLOSE_DURATION,
): number =>
  parseDurationMs(getComputedStyle(element).getPropertyValue(property))

const pendingCloses = new WeakMap<HTMLElement, number>()

/** Cancel a pending close on `element`, if one is running. Returns whether there was one. */
export const cancelSurfaceClose = (element: HTMLElement): boolean => {
  const timer = pendingCloses.get(element)
  if (timer === undefined) return false
  clearTimeout(timer)
  pendingCloses.delete(element)
  element.removeAttribute('data-state')
  return true
}

/**
 * Mark a freshly mounted surface as open on the next frame so the entrance transition runs from
 * its resting (closed) style. Cancels an in-flight close first: reopening mid-close continues from
 * wherever the animation currently is.
 */
export const openSurface = (element: HTMLElement): void => {
  cancelSurfaceClose(element)
  element.removeAttribute('data-state')
  requestAnimationFrame(() => {
    element.dataset.state = 'open'
  })
}

/**
 * Close `element`: set `data-state="closing"`, wait out its declared close duration, then call
 * `finish`. Under reduced motion or a zero duration `finish` runs immediately.
 *
 * Returns a cancel function: clearing the timer and removing the closing state, so a reopen while
 * the exit is still running takes over from the current frame.
 */
export const closeSurface = (
  element: HTMLElement,
  finish: () => void,
  durationProperty?: string,
): (() => void) => {
  cancelSurfaceClose(element)
  const duration = surfaceCloseDurationMs(element, durationProperty)
  if (duration <= 0 || prefersReducedMotion()) {
    element.removeAttribute('data-state')
    finish()
    return () => {}
  }
  element.dataset.state = 'closing'
  const timer = window.setTimeout(() => {
    pendingCloses.delete(element)
    element.removeAttribute('data-state')
    finish()
  }, duration)
  pendingCloses.set(element, timer)
  return () => cancelSurfaceClose(element)
}
