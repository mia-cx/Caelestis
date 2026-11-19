/** Pointer travel, in CSS pixels, past which a press on the plot or the brush becomes a drag. */
export const DRAG_THRESHOLD_PX = 4

/**
 * Follow one pointer on `window` until it lifts or the browser cancels it, so a drag keeps working
 * when the pointer leaves its surface or the page. Call it from the pointerdown handler: the next
 * pointer event can arrive before any microtask runs.
 */
export const followPointer = (
  pointerId: number,
  on: {
    readonly move: (event: PointerEvent) => void
    readonly end: (event: PointerEvent, cancelled: boolean) => void
  },
): void => {
  const move = (event: PointerEvent): void => {
    if (event.pointerId === pointerId) on.move(event)
  }
  const end = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    on.end(event, event.type === 'pointercancel')
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
}
