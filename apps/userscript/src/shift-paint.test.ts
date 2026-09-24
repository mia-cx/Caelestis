// @vitest-environment happy-dom
import { TRANSPARENT_INDEX, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ActiveAllianceSurface } from './alliance-surface.js'
import { installShiftPaint } from './shift-paint.js'

const harness = vi.hoisted(() => ({
  pixels: new Map<number, number>(),
  overlay: null as number | null,
  open: true,
  moving: false,
  alliance: null as ActiveAllianceSurface | null,
}))
vi.mock('./templates/move.js', () => ({ isMoving: () => harness.moving }))
vi.mock('./alliance-surface.js', () => ({ activeAllianceSurface: () => harness.alliance }))
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
  worldPaintIndexAt: (x: number) => harness.pixels.get(Math.floor(x)) ?? null,
}))

let canvas: HTMLCanvasElement
let nativeHeld: boolean
let nativeX: number
let draft: Map<number, number>
let teardown: (() => void)[]

const key = (
  type: 'keydown' | 'keyup',
  code: string,
  shiftKey = false,
  target: EventTarget = document,
): void => {
  target.dispatchEvent(
    new KeyboardEvent(type, {
      key: code === 'Space' ? ' ' : 'Shift',
      code,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  )
}
const move = (x: number): void => {
  canvas.dispatchEvent(
    new PointerEvent('mousemove', { clientX: x, clientY: 0, bubbles: true, cancelable: true }),
  )
}

beforeEach(() => {
  harness.pixels = new Map([
    [0, 12],
    [1, 4],
    [2, 12],
    [3, TRANSPARENT_INDEX],
    [4, 12],
  ])
  harness.overlay = 12
  harness.open = true
  harness.moving = false
  harness.alliance = null
  document.body.innerHTML = '<canvas></canvas><button id="color-13" class="ring-primary"></button>'
  canvas = document.createElement('canvas')
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
  installShiftPaint()
  nativeHeld = false
  nativeX = 0
  draft = new Map()
  const paint = (from: number, to: number): void => {
    for (let x = Math.min(from, to); x <= Math.max(from, to); x++) draft.set(x, 12)
  }
  // Wplace paints inclusive lines on mousemove and one current pixel on Space keydown.
  window.addEventListener('mousemove', (event) => {
    const x = Math.floor(event.clientX)
    if (nativeHeld) paint(nativeX, x)
    nativeX = x
  })
  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space') return
    if (!nativeHeld) paint(nativeX, nativeX)
    nativeHeld = true
  })
  document.addEventListener('keyup', (event) => {
    if (event.code === 'Space') nativeHeld = false
  })
})

afterEach(() => {
  for (const remove of teardown) remove()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

it('skips matching pixels throughout a fast Shift+Space stroke in either direction', () => {
  move(0)
  key('keydown', 'Space', true)
  move(4)
  move(0)
  expect([...draft.keys()].sort()).toEqual([1, 3])
  expect(nativeHeld).toBe(false)
})

it('restores normal inclusive painting when Shift is released while Space remains held', () => {
  move(0)
  key('keydown', 'Space', true)
  move(2)
  expect([...draft.keys()]).toEqual([1])
  key('keyup', 'ShiftLeft')
  move(4)
  expect([...draft.keys()]).toEqual([1, 2, 3, 4])
})

it('takes over when Shift is pressed during an existing Space stroke', () => {
  move(0)
  key('keydown', 'Space')
  key('keydown', 'ShiftLeft', true)
  move(4)
  expect([...draft.keys()]).toEqual([0, 1, 3])
})

it('resumes held Space after Shift is released during template movement', () => {
  move(0)
  key('keydown', 'Space', true)
  move(2)
  harness.moving = true
  key('keyup', 'ShiftLeft')
  move(3)
  expect([...draft.keys()]).toEqual([1])
  expect(nativeHeld).toBe(false)
  harness.moving = false
  move(4)
  expect([...draft.keys()]).toEqual([1, 3, 4])
  expect(nativeHeld).toBe(true)
})

it.each(['release', 'blur', 'pointercancel'])('cancels a deferred Space resume on %s', (cancel) => {
  move(0)
  key('keydown', 'Space', true)
  harness.moving = true
  key('keyup', 'ShiftLeft')
  if (cancel === 'release') key('keyup', 'Space')
  else window.dispatchEvent(new Event(cancel))
  harness.moving = false
  move(4)
  expect(nativeHeld).toBe(false)
  expect(draft.size).toBe(0)
})

it('skips every pixel that needs a different colour from the selected swatch', () => {
  harness.overlay = 4
  move(0)
  key('keydown', 'Space', true)
  move(4)
  expect(draft.size).toBe(0)
})

it('reads a changed native swatch before the next Shift click', () => {
  const clicked: number[] = []
  canvas.addEventListener('click', (event) => clicked.push(event.clientX))
  const click = () =>
    canvas.dispatchEvent(
      new MouseEvent('click', {
        clientX: 0,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  harness.overlay = 4
  click()
  document.querySelector('button')?.setAttribute('id', 'color-5')
  click()
  expect(clicked).toEqual([0])
})

it('skips pixels outside visible template colours', () => {
  harness.overlay = null
  move(1)
  key('keydown', 'Space', true)
  move(4)
  expect(draft.size).toBe(0)
})

it('does not mistake an unknown tile for an unpainted pixel', () => {
  move(5)
  key('keydown', 'Space', true)
  expect(draft.size).toBe(0)
})

it('filters Shift clicks while allowing mismatches and ordinary clicks', () => {
  const clicked: number[] = []
  canvas.addEventListener('click', (event) => clicked.push(event.clientX))
  for (const [clientX, shiftKey] of [
    [0, true],
    [1, true],
    [0, false],
  ] as const) {
    canvas.dispatchEvent(
      new MouseEvent('click', { clientX, shiftKey, bubbles: true, cancelable: true }),
    )
  }
  expect(clicked).toEqual([1, 0])
})

it('resets physical key state on blur and leaves typing alone', () => {
  move(0)
  key('keydown', 'Space', true)
  window.dispatchEvent(new Event('blur'))
  move(4)
  expect(draft.size).toBe(0)
  const input = document.createElement('input')
  document.body.append(input)
  const event = new KeyboardEvent('keydown', {
    code: 'Space',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  })
  input.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
})

it('leaves alliance keyboard painting to Wplace', () => {
  harness.alliance = {
    surface: { kind: 'alliance-headquarters', allianceId: 1 },
    stage: canvas,
    frame: canvas,
    draftId: null,
    bounds: null,
  }
  key('keydown', 'Space', true)
  expect(nativeHeld).toBe(true)
})

it('does not paint a stale canvas position after the pointer moves over a control', () => {
  move(1)
  vi.mocked(document.elementFromPoint).mockReturnValue(document.querySelector('button'))
  move(4)
  key('keydown', 'Space', true)
  expect(draft.size).toBe(0)
})
