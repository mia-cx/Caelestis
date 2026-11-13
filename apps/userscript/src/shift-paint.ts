import { WORLD_PIXELS } from '@caelestis/shared'
import { activeAllianceSurface } from './alliance-surface.js'
import { getMap } from './map-handle.js'
import { forwardPaintKey, forwardPaintMove, isForwardedPaintKey } from './paint-cursor.js'
import { getState } from './state.js'
import { isMoving } from './templates/move.js'
import { hasWplaceLabel } from './wplace-messages.js'
import { isPaintOpen, paintPaletteIndexOf, paintPaletteSwatches } from './wplace-paint.js'
import { overlayIndexAt, paintIndexAt, pickerPointAt } from './wplace-picker.js'

/**
 * Shift-paint: while Shift and Space are held, Wplace's brush paints only template cells that
 * need the selected colour.
 *
 * By default the painter's real events are filtered, never simulated: Wplace flags simulated
 * input on the account. Wplace paints a Bresenham line from the last position it saw to each new
 * one, so a move reaches it only when every cell on that line needs painting. The brush waits at
 * the edge of skipped cells until the pointer has a clear line from there, and Wplace's hover
 * square shows where it waits. A hold keydown paints the last position Wplace saw, so it is
 * blocked while that cell is skipped. The world map starts on the next auto-repeat; HQ needs a
 * fresh press.
 *
 * `simulateShiftPaint` opts into lifting the brush over skipped cells with synthetic keys and moves.
 */

type Position = { readonly clientX: number; readonly clientY: number }
/** One logical paint cell, or a fractional point inside one. */
type Cell = NonNullable<ReturnType<typeof pickerPointAt>>
type Keys = { shift: boolean; space: boolean }

/** How one shift-paint mode answers the painter's input. */
interface Mode {
  readonly keydown: (event: KeyboardEvent) => void
  readonly keyup: (event: KeyboardEvent) => void
  readonly move: (event: MouseEvent) => void
  readonly leave: (event: PointerEvent) => void
  /** Forget what Wplace last saw, as Wplace does on blur and cancel. */
  readonly reset: () => void
}

const brushActive = (): boolean =>
  isPaintOpen() &&
  !isMoving() &&
  ![...document.querySelectorAll('button[aria-pressed="true"], button.btn-primary')].some(
    (button) => hasWplaceLabel(button, 'eraser') || hasWplaceLabel(button, 'color_picker'),
  )

/** Read the swatch synchronously: continuous picking can change it twice within one frame. */
const selectedIndex = (): number | null => {
  const swatch = paintPaletteSwatches().find(
    (candidate) =>
      candidate.classList.contains('ring-primary') ||
      candidate.getAttribute('aria-pressed') === 'true',
  )
  return swatch === undefined ? null : paintPaletteIndexOf(swatch)
}

/** Whether painting the selected colour here moves a visible template towards done. */
const needsPaint = (cell: Cell, selected: number | null): boolean => {
  if (selected === null || overlayIndexAt(cell.surface, cell.x, cell.y) !== selected) return false
  const actual = paintIndexAt(cell)
  // An uncaptured tile is unknown, not unpainted. A world lookup starts the existing tile fetch.
  return actual !== null && actual !== selected
}

const shouldPaint = (target: Element, position: Position): boolean => {
  const point = pickerPointAt(target, position.clientX, position.clientY)
  return point !== null && needsPaint(point, selectedIndex())
}

const claim = (event: Event): void => {
  event.preventDefault()
  event.stopImmediatePropagation()
}

const typing = (event: Event): boolean =>
  event
    .composedPath()
    .some(
      (target) =>
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)),
    )

const cellOf = (point: Cell): Cell => ({ ...point, x: Math.floor(point.x), y: Math.floor(point.y) })
const cellKey = ({ x, y }: Cell): string => `${x},${y}`

/**
 * The cells Wplace paints for a move, start included. The world (`$e`) and HQ (`qn`) both use
 * Bresenham but break ties differently: the world steps on strict error comparisons, HQ on
 * inclusive ones.
 */
const paintLine = (from: Cell, to: Cell): Cell[] => {
  const world = to.alliance === null
  // Wplace's projection keeps a move across the antimeridian continuous; ours wraps.
  const span = to.x - from.x
  const endX =
    world && Math.abs(span) > WORLD_PIXELS / 2 ? to.x - Math.sign(span) * WORLD_PIXELS : to.x
  const dx = Math.abs(endX - from.x)
  const dy = Math.abs(to.y - from.y)
  const stepX = from.x < endX ? 1 : -1
  const stepY = from.y < to.y ? 1 : -1
  let error = dx - dy
  let { x, y } = from
  const cells = [from]
  while (x !== endX || y !== to.y) {
    const doubled = 2 * error
    if (world ? doubled > -dy : doubled >= -dy) {
      error -= dy
      x += stepX
    }
    if (world ? doubled < dx : doubled <= dx) {
      error += dx
      y += stepY
    }
    cells.push({ ...to, x: world ? (x + WORLD_PIXELS) % WORLD_PIXELS : x, y })
  }
  return cells
}

/** The default: Wplace receives only the painter's real events, and only those that paint wanted cells. */
const filterInput = (keys: Keys): Mode => {
  /** Whether Wplace's paint hold is on: a Space keydown reached it since the last keyup. */
  let holding = false
  /** Where Wplace's next move line starts: the world's last move, HQ's last painted cell. */
  let from: Cell | null = null
  /** What a hold keydown paints: Wplace's last move, HQ's hovered cell. */
  let hover: Cell | null = null
  /** Cells this hold already painted. Crossing them again changes nothing. */
  let stroke = new Set<string>()

  /**
   * The cell Wplace reads from this move: `undefined` when its paint handler never sees it, `null`
   * when it sees no cell. The world paints from `mousemove` anywhere on the page; HQ from
   * `pointermove` inside its artboard stage.
   */
  const cellAt = (event: MouseEvent): Cell | null | undefined => {
    const alliance = activeAllianceSurface()
    if (alliance === null) {
      const map = getMap()
      if (event.type !== 'mousemove' || map === null) return undefined
      const point = pickerPointAt(map.getCanvas(), event.clientX, event.clientY)
      return point === null ? undefined : cellOf(point)
    }
    if (event.type !== 'pointermove' || !(event.target instanceof Node)) return undefined
    if (!alliance.stage.contains(event.target)) return undefined
    const point = pickerPointAt(alliance.frame, event.clientX, event.clientY)
    return point === null ? null : cellOf(point)
  }

  return {
    keydown: (event) => {
      if (event.code !== 'Space' || holding) return
      if (keys.shift && brushActive() && hover !== null && !needsPaint(hover, selectedIndex())) {
        claim(event)
        return
      }
      if (event.repeat && activeAllianceSurface() !== null) return
      holding = true
      stroke = new Set(hover === null ? [] : [cellKey(hover)])
      from = hover
    },
    keyup: (event) => {
      if (event.code === 'Space') holding = false
    },
    move: (event) => {
      const cell = cellAt(event)
      if (cell === undefined) return
      if (cell === null) {
        hover = null
        return
      }
      if (holding && brushActive()) {
        const line = from === null ? [cell] : paintLine(from, cell).slice(1)
        if (keys.shift) {
          const selected = selectedIndex()
          if (!line.every((next) => stroke.has(cellKey(next)) || needsPaint(next, selected))) {
            claim(event)
            return
          }
        }
        for (const next of line) stroke.add(cellKey(next))
      }
      from = cell
      hover = cell
    },
    leave: (event) => {
      // HQ forgets its hovered cell, and a held stroke its line start, when the pointer leaves.
      if (event.target !== activeAllianceSurface()?.stage) return
      from = null
      hover = null
    },
    reset: () => {
      holding = false
      from = null
    },
  }
}

/** The opt-in: lift Wplace's brush over skipped cells with synthetic Space and replayed moves. */
const simulateInput = (keys: Keys): Mode => {
  let nativePaused = false
  let forwarding = false
  let cursor: Position | null = null

  const paintCurrent = (): void => {
    if (cursor === null) return
    const target = document.elementFromPoint(cursor.clientX, cursor.clientY)
    if (target === null || !shouldPaint(target, cursor)) return
    forwardPaintKey('keydown')
    forwardPaintKey('keyup')
  }

  const resumeSpace = (): void => {
    if (!nativePaused || !keys.space || keys.shift || !brushActive()) return
    nativePaused = false
    forwardPaintKey('keydown')
  }

  return {
    keydown: (event) => {
      if (!keys.space || !keys.shift || !brushActive()) return
      if (event.code !== 'Space' && event.key !== 'Shift') return
      nativePaused = true
      forwardPaintKey('keyup')
      if (event.code === 'Space') claim(event)
      if (!event.repeat) paintCurrent()
    },
    keyup: (event) => {
      if (event.code === 'Space') nativePaused = false
      resumeSpace()
    },
    move: (event) => {
      if (forwarding || event.type !== 'mousemove') return
      const target = document.elementFromPoint(event.clientX, event.clientY)
      const point = target === null ? null : pickerPointAt(target, event.clientX, event.clientY)
      if (target === null || point === null) {
        cursor = null
        return
      }
      const previous = cursor
      cursor = { clientX: event.clientX, clientY: event.clientY }
      // Shift can be released while a move session or another tool temporarily owns the brush.
      resumeSpace()
      if (!keys.shift || !keys.space || !brushActive()) return
      claim(event)
      nativePaused = true
      forwardPaintKey('keyup')
      const start =
        previous === null ? null : pickerPointAt(target, previous.clientX, previous.clientY)
      const dx = start === null ? 0 : Math.abs(point.x - start.x)
      const width = Math.min(dx, WORLD_PIXELS - dx)
      const steps =
        start === null ? 1 : Math.max(1, Math.ceil(Math.max(width, Math.abs(point.y - start.y))))
      forwarding = true
      try {
        for (let step = 1; step <= steps; step++) {
          const position =
            previous === null
              ? cursor
              : {
                  clientX: previous.clientX + ((event.clientX - previous.clientX) * step) / steps,
                  clientY: previous.clientY + ((event.clientY - previous.clientY) * step) / steps,
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
    leave: () => {},
    reset: () => {
      nativePaused = false
      cursor = null
    },
  }
}

/** Paint only unfinished template cells needing the selected colour while Shift is held. */
export const installShiftPaint = (): void => {
  const keys: Keys = { shift: false, space: false }
  const filter = filterInput(keys)
  const simulate = simulateInput(keys)
  let current = filter
  const mode = (): Mode => {
    const next = getState().simulateShiftPaint ? simulate : filter
    if (next !== current) {
      next.reset()
      current = next
    }
    return current
  }

  window.addEventListener(
    'keydown',
    (event) => {
      if (isForwardedPaintKey(event) || typing(event)) return
      keys.shift = event.shiftKey
      if (event.code === 'Space') keys.space = true
      mode().keydown(event)
    },
    true,
  )
  window.addEventListener(
    'keyup',
    (event) => {
      if (isForwardedPaintKey(event)) return
      if (event.code === 'Space') keys.space = false
      keys.shift = event.shiftKey
      mode().keyup(event)
    },
    true,
  )
  window.addEventListener('mousemove', (event) => mode().move(event), true)
  window.addEventListener('pointermove', (event) => mode().move(event), true)
  window.addEventListener('pointerleave', (event) => mode().leave(event), true)

  const reset = (): void => {
    keys.shift = false
    keys.space = false
    mode().reset()
  }
  window.addEventListener('blur', reset)
  window.addEventListener('pointercancel', reset)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) reset()
  })

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

  // HQ's artboard paints a click at its press position on pointerup, before any click event.
  // Stopping the press leaves Wplace nothing to paint.
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (!event.shiftKey || event.button !== 0 || !brushActive()) return
      const target = event.target
      if (!(target instanceof Element)) return
      const point = pickerPointAt(target, event.clientX, event.clientY)
      if (point?.alliance != null && !shouldPaint(target, event)) claim(event)
    },
    true,
  )
}
