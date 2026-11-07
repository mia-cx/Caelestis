import { WORLD_PIXELS } from '@caelestis/shared'
import { forwardPaintKey, forwardPaintMove, isForwardedPaintKey } from './paint-cursor.js'
import { isMoving } from './templates/move.js'
import { hasWplaceLabel } from './wplace-messages.js'
import { isPaintOpen, paintPaletteIndexOf, paintPaletteSwatches } from './wplace-paint.js'
import { overlayIndexAt, paintIndexAt, pickerPointAt } from './wplace-picker.js'

type Position = { clientX: number; clientY: number }

/** Draw only unfinished template cells needing the selected colour while Shift is held. */
export const installShiftPaint = (): void => {
  let spaceHeld = false
  let shiftHeld = false
  let nativePaused = false
  let forwarding = false
  let cursor: Position | null = null

  const brushActive = (): boolean =>
    isPaintOpen() &&
    !isMoving() &&
    ![...document.querySelectorAll('button[aria-pressed="true"], button.btn-primary')].some(
      (button) => hasWplaceLabel(button, 'eraser') || hasWplaceLabel(button, 'color_picker'),
    )

  const targetAt = (position: Position): Element | null =>
    document.elementFromPoint(position.clientX, position.clientY)

  const shouldPaint = (target: Element, position: Position): boolean => {
    const point = pickerPointAt(target, position.clientX, position.clientY)
    if (point === null) return false
    // Read the swatch synchronously: continuous picking can change it twice within one frame.
    const swatch = paintPaletteSwatches().find(
      (candidate) =>
        candidate.classList.contains('ring-primary') ||
        candidate.getAttribute('aria-pressed') === 'true',
    )
    const selected = swatch === undefined ? null : paintPaletteIndexOf(swatch)
    if (selected === null) return false
    const wanted = overlayIndexAt(point.surface, point.x, point.y)
    if (wanted !== selected) return false
    const actual = paintIndexAt(point)
    // An uncaptured tile is unknown, not unpainted. A world lookup starts the existing tile fetch.
    return actual !== null && actual !== wanted
  }

  const paintCurrent = (): void => {
    if (cursor === null) return
    const target = targetAt(cursor)
    if (target === null || !shouldPaint(target, cursor)) return
    forwardPaintKey('keydown')
    forwardPaintKey('keyup')
  }

  const claim = (event: Event): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  const resumeSpace = (): void => {
    if (!nativePaused || !spaceHeld || shiftHeld || !brushActive()) return
    nativePaused = false
    forwardPaintKey('keydown')
  }

  window.addEventListener(
    'keydown',
    (event) => {
      if (isForwardedPaintKey(event)) return
      if (
        event
          .composedPath()
          .some(
            (target) =>
              target instanceof HTMLElement &&
              (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)),
          )
      )
        return
      shiftHeld = event.shiftKey
      if (event.code === 'Space') spaceHeld = true
      if (!spaceHeld || !shiftHeld || !brushActive()) return
      if (event.code !== 'Space' && event.key !== 'Shift') return
      nativePaused = true
      forwardPaintKey('keyup')
      if (event.code === 'Space') claim(event)
      if (!event.repeat) paintCurrent()
    },
    true,
  )

  window.addEventListener(
    'keyup',
    (event) => {
      if (isForwardedPaintKey(event)) return
      if (event.code === 'Space') {
        spaceHeld = false
        nativePaused = false
      }
      shiftHeld = event.shiftKey
      resumeSpace()
    },
    true,
  )

  const reset = (): void => {
    spaceHeld = false
    shiftHeld = false
    nativePaused = false
    cursor = null
  }
  window.addEventListener('blur', reset)
  window.addEventListener('pointercancel', reset)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) reset()
  })

  window.addEventListener(
    'mousemove',
    (event) => {
      if (forwarding) return
      const target = targetAt(event)
      const point = target === null ? null : pickerPointAt(target, event.clientX, event.clientY)
      if (target === null || point === null) {
        cursor = null
        return
      }
      const from = cursor
      cursor = { clientX: event.clientX, clientY: event.clientY }
      // Shift can be released while a move session or another tool temporarily owns the brush.
      resumeSpace()
      if (!shiftHeld || !spaceHeld || !brushActive()) return
      claim(event)
      nativePaused = true
      forwardPaintKey('keyup')
      const start = from === null ? null : pickerPointAt(target, from.clientX, from.clientY)
      const dx = start === null ? 0 : Math.abs(point.x - start.x)
      const width = Math.min(dx, WORLD_PIXELS - dx)
      const steps =
        start === null ? 1 : Math.max(1, Math.ceil(Math.max(width, Math.abs(point.y - start.y))))
      forwarding = true
      try {
        for (let step = 1; step <= steps; step++) {
          const position =
            from === null
              ? cursor
              : {
                  clientX: from.clientX + ((event.clientX - from.clientX) * step) / steps,
                  clientY: from.clientY + ((event.clientY - from.clientY) * step) / steps,
                }
          // The world map paints from mouse movement, HQ's artboard from pointer movement.
          forwardPaintMove(
            target,
            new PointerEvent('mousemove', event),
            point.alliance === null ? 'mousemove' : 'pointermove',
            position,
          )
          if (!shouldPaint(target, position)) continue
          forwardPaintKey('keydown')
          forwardPaintKey('keyup')
        }
      } finally {
        forwarding = false
      }
    },
    true,
  )

  window.addEventListener(
    'click',
    (event) => {
      if (!event.shiftKey || event.button !== 0 || !brushActive()) return
      const target = event.target
      if (
        !(target instanceof Element) ||
        pickerPointAt(target, event.clientX, event.clientY) === null
      )
        return
      if (!shouldPaint(target, event)) claim(event)
    },
    true,
  )

  // HQ's artboard paints a click at its press position on pointerup, before any click event. A
  // filtered press is cancelled instead, which ends Wplace's pan the way a drag does: unpainted.
  let skippedPress: number | null = null
  window.addEventListener(
    'pointerdown',
    (event) => {
      skippedPress = null
      if (!event.shiftKey || event.button !== 0 || !brushActive()) return
      const target = event.target
      if (!(target instanceof Element)) return
      const point = pickerPointAt(target, event.clientX, event.clientY)
      if (point?.alliance != null && !shouldPaint(target, event)) skippedPress = event.pointerId
    },
    true,
  )
  window.addEventListener(
    'pointerup',
    (event) => {
      if (skippedPress !== event.pointerId) return
      skippedPress = null
      window.dispatchEvent(new PointerEvent('pointercancel', event))
    },
    true,
  )
}
