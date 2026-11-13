// @vitest-environment happy-dom
import { TRANSPARENT_INDEX, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveAllianceSurface } from './alliance-surface.js'
import { installShiftPaint } from './shift-paint.js'

// Palette index 12 is both the selected swatch (`color-13`) and the template colour.
const harness = vi.hoisted(() => ({
  canvas: null as HTMLCanvasElement | null,
  /** Committed pixels keyed `x,y`; an absent key is an uncaptured tile. */
  pixels: new Map<string, number>(),
  /** Wplace's draft, painted in the selected colour. */
  draft: new Set<string>(),
  overlay: 12 as number | null,
  open: true,
  moving: false,
  simulate: false,
  alliance: null as ActiveAllianceSurface | null,
}))
vi.mock('./templates/move.js', () => ({ isMoving: () => harness.moving }))
vi.mock('./alliance-surface.js', () => ({ activeAllianceSurface: () => harness.alliance }))
vi.mock('./state.js', () => ({ getState: () => ({ simulateShiftPaint: harness.simulate }) }))
vi.mock('./map-handle.js', () => ({ getMap: () => ({ getCanvas: () => harness.canvas }) }))
vi.mock('./wplace-paint.js', () => ({
  isPaintOpen: () => harness.open,
  paintPaletteSwatches: () => [...document.querySelectorAll('button[id^="color-"]')],
  paintPaletteIndexOf: (button: Element) => Number(button.id.slice('color-'.length)) - 1,
}))
vi.mock('./wplace-picker.js', () => ({
  pickerPointAt: (target: Element, x: number, y: number) =>
    target.tagName === 'CANVAS'
      ? { surface: WORLD_TEMPLATE_SURFACE, x, y, alliance: harness.alliance }
      : null,
  overlayIndexAt: () => harness.overlay,
  paintIndexAt: ({ x, y }: { x: number; y: number }) => {
    const key = `${Math.floor(x)},${Math.floor(y)}`
    return harness.draft.has(key) ? 12 : (harness.pixels.get(key) ?? null)
  },
}))

type Cell = { x: number; y: number }
const keyOf = ({ x, y }: Cell): string => `${x},${y}`

/** `.` needs the selected colour, `#` already has it, `?` is an uncaptured tile. */
const grid = (...rows: string[]): void => {
  harness.pixels = new Map()
  rows.forEach((row, y) => {
    ;[...row].forEach((pixel, x) => {
      if (pixel !== '?') harness.pixels.set(`${x},${y}`, pixel === '#' ? 12 : TRANSPARENT_INDEX)
    })
  })
}
const painted = (): string[] => [...harness.draft].sort()

const HQ: ActiveAllianceSurface = {
  surface: { kind: 'alliance-headquarters', allianceId: 1 },
  stage: document.createElement('div'),
  frame: document.createElement('div'),
  draftId: null,
  bounds: null,
}

/** Wplace's paint lines, copied from its bundle: world `$e`, HQ artboard `qn`. */
const wplaceLine = (from: Cell, to: Cell, hq: boolean): Cell[] => {
  const dx = Math.abs(to.x - from.x)
  const dy = Math.abs(to.y - from.y)
  let error = dx - dy
  let { x, y } = from
  const cells = [{ x, y }]
  while (x !== to.x || y !== to.y) {
    const doubled = 2 * error
    if (hq ? doubled >= -dy : doubled > -dy) {
      error -= dy
      x += from.x < to.x ? 1 : -1
    }
    if (hq ? doubled <= dx : doubled < dx) {
      error += dx
      y += from.y < to.y ? 1 : -1
    }
    cells.push({ x, y })
  }
  return cells
}

let canvas: HTMLCanvasElement
let teardown: (() => void)[]
/** Events this test dispatched as the painter. Any other is one Caelestis simulated. */
let real: WeakSet<Event>
let simulated: Event[]
/** Fake Wplace: whether the paint hold is on, and the cell its next line starts from. */
let wplace: { held: boolean; at: Cell | null }

const fire = (target: EventTarget, event: Event): Event => {
  real.add(event)
  target.dispatchEvent(event)
  return event
}
const key = (
  type: 'keydown' | 'keyup',
  code: string,
  { shiftKey = false, repeat = false } = {},
): Event =>
  fire(
    document,
    new KeyboardEvent(type, {
      key: code === 'Space' ? ' ' : 'Shift',
      code,
      shiftKey,
      repeat,
      bubbles: true,
      cancelable: true,
    }),
  )
/** A real pointer move: the browser sends `pointermove`, then its compatibility `mousemove`. */
const move = (x: number, y = 0): void => {
  const init = { clientX: x + 0.5, clientY: y + 0.5, bubbles: true, cancelable: true }
  fire(canvas, new PointerEvent('pointermove', init))
  fire(canvas, new PointerEvent('mousemove', init))
}
const paintAt = (cells: readonly Cell[]): void => {
  for (const cell of cells) harness.draft.add(keyOf(cell))
}

beforeEach(() => {
  grid('#.#.#')
  harness.draft = new Set()
  harness.overlay = 12
  harness.open = true
  harness.moving = false
  harness.simulate = false
  harness.alliance = null
  document.body.innerHTML = '<button id="color-13" class="ring-primary"></button>'
  canvas = document.createElement('canvas')
  harness.canvas = canvas
  document.body.prepend(canvas)
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(canvas)
  teardown = []
  for (const target of [window, document]) {
    const native = target.addEventListener.bind(target)
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      native(type, listener, options)
      teardown.push(() => target.removeEventListener(type, listener, options))
    })
  }
  real = new WeakSet()
  simulated = []
  for (const type of ['keydown', 'keyup', 'mousemove', 'pointermove', 'pointerdown', 'click'])
    window.addEventListener(type, (event) => real.has(event) || simulated.push(event), true)
  installShiftPaint()

  // Wplace's world map: a hold paints its last position, and accepts auto-repeat; held moves paint
  // a line from the last move.
  wplace = { held: false, at: null }
  const cellOf = (event: MouseEvent): Cell => ({
    x: Math.floor(event.clientX),
    y: Math.floor(event.clientY),
  })
  window.addEventListener('mousemove', (event) => {
    if (harness.alliance !== null) return
    const cell = cellOf(event)
    if (wplace.held) paintAt(wplaceLine(wplace.at ?? cell, cell, false))
    wplace.at = cell
  })
  document.addEventListener('keydown', (event) => {
    if (harness.alliance !== null || event.code !== 'Space') return
    if (!wplace.held && wplace.at !== null) paintAt([wplace.at])
    wplace.held = true
  })
  // HQ's artboard: pointer moves, a window hold listener that ignores auto-repeat, and a held line
  // that starts at the hovered cell.
  let hover: Cell | null = null
  window.addEventListener('pointermove', (event) => {
    if (harness.alliance === null) return
    const cell = cellOf(event)
    if (wplace.held) paintAt(wplaceLine(wplace.at ?? cell, cell, true))
    hover = cell
    if (wplace.held) wplace.at = cell
  })
  window.addEventListener('keydown', (event) => {
    if (harness.alliance === null || event.code !== 'Space' || event.repeat || wplace.held) return
    wplace.held = true
    wplace.at = hover
    if (hover !== null) paintAt([hover])
  })
  document.addEventListener('keyup', (event) => {
    if (event.code !== 'Space') return
    wplace.held = false
    if (harness.alliance !== null) wplace.at = null
  })
})

afterEach(() => {
  for (const remove of teardown) remove()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('by default', () => {
  afterEach(() => {
    expect(simulated).toEqual([])
  })

  it('stops a fast stroke at the edge of skipped pixels and resumes on a clear line', () => {
    grid('..#..', '.....')
    move(0)
    key('keydown', 'Space', { shiftKey: true })
    move(4)
    expect(painted()).toEqual(['0,0'])
    move(1)
    move(1, 1)
    move(3, 1)
    move(4)
    expect(painted()).toEqual(['0,0', '1,0', '1,1', '2,1', '3,1', '4,0'])
  })

  it('holds back Space over a pixel it would skip, then starts on the next auto-repeat', () => {
    grid('?#.')
    move(0)
    expect(key('keydown', 'Space', { shiftKey: true }).defaultPrevented).toBe(true)
    move(1)
    key('keydown', 'Space', { shiftKey: true, repeat: true })
    move(2)
    expect(painted()).toEqual([])
    key('keydown', 'Space', { shiftKey: true, repeat: true })
    expect(painted()).toEqual(['2,0'])
  })

  it.each([
    ['world map', null, ['0,0']],
    ['HQ artboard', HQ, ['0,0', '1,1', '2,1']],
  ])('checks the line the %s paints', (_, alliance, expected) => {
    harness.alliance = alliance === null ? null : { ...alliance, stage: canvas, frame: canvas }
    grid('.#.', '...')
    move(0)
    key('keydown', 'Space', { shiftKey: true })
    move(2, 1)
    expect(painted()).toEqual(expected)
  })

  it('crosses pixels the same stroke already painted', () => {
    grid('...')
    move(0)
    key('keydown', 'Space', { shiftKey: true })
    move(2)
    move(0)
    expect(wplace.at).toEqual({ x: 0, y: 0 })
  })

  it('paints normally again once Shift is released mid-stroke', () => {
    grid('..#..')
    move(0)
    key('keydown', 'Space', { shiftKey: true })
    move(1)
    key('keyup', 'ShiftLeft')
    move(4)
    expect(painted()).toEqual(['0,0', '1,0', '2,0', '3,0', '4,0'])
  })

  it('leaves typing alone', () => {
    const input = document.createElement('input')
    document.body.append(input)
    const event = fire(
      input,
      new KeyboardEvent('keydown', {
        code: 'Space',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(event.defaultPrevented).toBe(false)
  })
})

it('filters Shift clicks while allowing wanted pixels and ordinary clicks', () => {
  const clicked: number[] = []
  canvas.addEventListener('click', (event) => clicked.push(event.clientX))
  for (const [clientX, shiftKey] of [
    [0, true],
    [1, true],
    [0, false],
  ] as const)
    fire(canvas, new MouseEvent('click', { clientX, shiftKey, bubbles: true, cancelable: true }))
  expect(clicked).toEqual([1, 0])
})

it('reads a changed native swatch before the next Shift click', () => {
  const clicked: number[] = []
  canvas.addEventListener('click', (event) => clicked.push(event.clientX))
  const click = () =>
    fire(
      canvas,
      new MouseEvent('click', { clientX: 0, shiftKey: true, bubbles: true, cancelable: true }),
    )
  harness.overlay = 4
  click()
  document.querySelector('button')?.setAttribute('id', 'color-5')
  click()
  expect(clicked).toEqual([0])
})

it('stops Shift presses on the HQ artboard, which paints a press on pointerup', () => {
  harness.alliance = { ...HQ, stage: canvas, frame: canvas }
  const pressed = new Map<number, number>()
  window.addEventListener(
    'pointerup',
    (event) => {
      const x = pressed.get(event.pointerId)
      if (pressed.delete(event.pointerId) && x !== undefined) paintAt([{ x, y: 0 }])
    },
    true,
  )
  canvas.addEventListener('pointerdown', (event) =>
    pressed.set(event.pointerId, Math.floor(event.clientX)),
  )
  for (const [pointerId, clientX, shiftKey] of [
    [1, 0, true],
    [2, 1, true],
    [3, 2, false],
  ] as const) {
    for (const type of ['pointerdown', 'pointerup'])
      fire(
        canvas,
        new PointerEvent(type, { pointerId, clientX, shiftKey, bubbles: true, cancelable: true }),
      )
  }
  expect(painted()).toEqual(['1,0', '2,0'])
  expect(simulated).toEqual([])
})

describe('with simulated input', () => {
  beforeEach(() => {
    harness.simulate = true
  })

  it('skips matching pixels throughout a fast stroke in either direction', () => {
    move(0)
    key('keydown', 'Space', { shiftKey: true })
    move(4)
    move(0)
    expect(painted()).toEqual(['1,0', '3,0'])
    expect(wplace.held).toBe(false)
  })

  it('skips matching pixels throughout a stroke on the HQ artboard', () => {
    harness.alliance = { ...HQ, stage: canvas, frame: canvas }
    move(0)
    key('keydown', 'Space', { shiftKey: true })
    move(4)
    move(0)
    expect(painted()).toEqual(['1,0', '3,0'])
  })

  it('takes over when Shift is pressed during an existing Space stroke', () => {
    move(0)
    key('keydown', 'Space')
    key('keydown', 'ShiftLeft', { shiftKey: true })
    move(4)
    expect(painted()).toEqual(['0,0', '1,0', '3,0'])
  })

  it('resumes held Space after Shift is released during template movement', () => {
    move(0)
    key('keydown', 'Space', { shiftKey: true })
    move(2)
    harness.moving = true
    key('keyup', 'ShiftLeft')
    move(3)
    expect(painted()).toEqual(['1,0'])
    harness.moving = false
    move(4)
    expect(painted()).toEqual(['1,0', '3,0', '4,0'])
    expect(wplace.held).toBe(true)
  })

  it.each(['release', 'blur', 'pointercancel'])(
    'cancels a deferred Space resume on %s',
    (cancel) => {
      move(0)
      key('keydown', 'Space', { shiftKey: true })
      harness.moving = true
      key('keyup', 'ShiftLeft')
      if (cancel === 'release') key('keyup', 'Space')
      else window.dispatchEvent(new Event(cancel))
      harness.moving = false
      move(4)
      expect(wplace.held).toBe(false)
      expect(painted()).toEqual([])
    },
  )

  it('does not paint a stale canvas position after the pointer moves over a control', () => {
    move(1)
    vi.mocked(document.elementFromPoint).mockReturnValue(document.querySelector('button'))
    move(4)
    key('keydown', 'Space', { shiftKey: true })
    expect(painted()).toEqual([])
  })
})
