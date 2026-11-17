// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ActiveAllianceSurface } from './alliance-surface.js'
import type { MapLike } from './map-handle.js'
import {
  forwardPaintKey,
  installPaintTargetGuard,
  isForwardedPaintMove,
  markPaintTargetStale,
  refreshPaintTarget,
  syncPaintTargetMap,
} from './paint-cursor.js'

const harness = vi.hoisted(() => ({
  open: true,
  refresh: false,
  alliance: null as ActiveAllianceSurface | null,
}))
vi.mock('./wplace-paint.js', () => ({ isPaintOpen: () => harness.open }))
vi.mock('./alliance-surface.js', () => ({ activeAllianceSurface: () => harness.alliance }))
vi.mock('./state.js', () => ({
  getState: () => ({ simulatedInput: harness.refresh ? { 'cursor-refresh': true } : {} }),
}))

type CameraListener = (event: { readonly originalEvent?: Event }) => void

/** What Wplace's own handlers receive: Space presses on `document`, moves on `window`. */
let received: string[]
let cameraListeners: Set<CameraListener>
let settledListeners: Set<CameraListener>
let teardown: (() => void)[]

const canvas = document.createElement('canvas')
const map = {
  getCanvas: () => canvas,
  on: (type: 'move' | 'moveend', listener: CameraListener) =>
    (type === 'move' ? cameraListeners : settledListeners).add(listener),
  off: (type: 'move' | 'moveend', listener: CameraListener) =>
    (type === 'move' ? cameraListeners : settledListeners).delete(listener),
} as unknown as MapLike
/** A flight, jump, or pan coming to rest. */
const settleCamera = (): void => {
  for (const listener of settledListeners) listener({})
}
/** A world camera move; with an `originalEvent`, the pointer or wheel drove it. */
const moveCamera = (originalEvent?: Event): void => {
  for (const listener of cameraListeners)
    listener(originalEvent === undefined ? {} : { originalEvent })
}
const key = (type: 'keydown' | 'keyup', target: EventTarget = document): void => {
  target.dispatchEvent(
    new KeyboardEvent(type, { code: 'Space', key: ' ', bubbles: true, cancelable: true }),
  )
}
const move = (type: 'mousemove' | 'pointermove' = 'mousemove', target: Element = document.body) => {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: 1, clientY: 1 }))
}
const listen = (target: EventTarget, type: string): void => {
  const record = (event: Event): void => {
    received.push(type === 'keydown' ? `${type}:${(event as KeyboardEvent).code}` : type)
  }
  target.addEventListener(type, record)
  teardown.push(() => target.removeEventListener(type, record))
}

beforeEach(() => {
  harness.open = true
  harness.refresh = false
  harness.alliance = null
  received = []
  cameraListeners = new Set()
  settledListeners = new Set()
  document.body.append(canvas)
  document.elementFromPoint = () => canvas
  teardown = [installPaintTargetGuard()]
  syncPaintTargetMap(map)
  listen(document, 'keydown')
  listen(window, 'mousemove')
  listen(window, 'pointermove')
})

afterEach(() => {
  for (const undo of teardown.reverse()) undo()
  document.body.innerHTML = ''
})

it('ignores Space after a camera move until a mouse move reaches Wplace', () => {
  moveCamera()
  key('keydown')
  key('keyup')
  expect(received).toEqual([])

  move()
  key('keydown')
  expect(received).toEqual(['mousemove', 'keydown:Space'])
})

it('holds moves back while Space stays down through a camera move', () => {
  key('keydown')
  moveCamera()
  move()
  move()
  expect(received).toEqual(['keydown:Space'])

  key('keyup')
  key('keydown')
  move()
  key('keydown')
  expect(received).toEqual(['keydown:Space', 'mousemove', 'keydown:Space'])
})

it('keeps drags and wheel zooms flowing, since they keep the same map point under the pointer', () => {
  key('keydown')
  moveCamera(new MouseEvent('mousemove'))
  moveCamera(new WheelEvent('wheel'))
  move()
  key('keydown')
  expect(received).toEqual(['keydown:Space', 'mousemove', 'keydown:Space'])
})

it('ignores Space after drag inertia moves the map under a still pointer', () => {
  move()
  moveCamera(new MouseEvent('mousemove'))
  moveCamera(new MouseEvent('mouseup'))
  key('keydown')
  expect(received).toEqual(['mousemove'])
})

it('leaves Space alone in text fields and while the paint drawer is closed', () => {
  const input = document.createElement('input')
  document.body.append(input)
  moveCamera()
  key('keydown', input)
  harness.open = false
  key('keydown')
  expect(received).toEqual(['keydown:Space', 'keydown:Space'])
})

it("guards HQ's artboard after a jump until a pointer move over it", () => {
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  stage.append(frame)
  document.body.append(stage)
  harness.alliance = { stage, frame } as unknown as ActiveAllianceSurface

  markPaintTargetStale()
  key('keydown')
  move('pointermove')
  move('mousemove', frame)
  key('keydown')
  expect(received).toEqual(['pointermove', 'mousemove'])

  move('pointermove', frame)
  key('keydown')
  expect(received).toEqual(['pointermove', 'mousemove', 'pointermove', 'keydown:Space'])
})

it('puts the paint target under the still mouse after a flight only with its own switch on', () => {
  const real = (): void => {
    canvas.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'mouse',
        clientX: 5,
        clientY: 5,
      }),
    )
  }
  const forwarded: boolean[] = []
  const record = (event: Event): void => {
    forwarded.push(isForwardedPaintMove(event))
  }
  window.addEventListener('mousemove', record)
  teardown.push(() => window.removeEventListener('mousemove', record))

  real()
  moveCamera()
  settleCamera()
  key('keydown')
  key('keyup')
  expect(forwarded).toEqual([])
  expect(received).toEqual(['pointermove'])

  harness.refresh = true
  moveCamera()
  settleCamera()
  key('keydown')
  expect(forwarded).toEqual([true])
  expect(received).toEqual(['pointermove', 'mousemove', 'keydown:Space'])
})

it("never refreshes while Space is physically held, even after shift-paint's forwarded release", () => {
  harness.refresh = true
  canvas.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      pointerType: 'mouse',
      clientX: 5,
      clientY: 5,
    }),
  )
  key('keydown')
  // Shift-paint pauses Wplace's hold with a forwarded release while the key stays down.
  forwardPaintKey('keyup')
  moveCamera()
  settleCamera()
  expect(received).toEqual(['pointermove', 'keydown:Space'])

  key('keyup')
  moveCamera()
  settleCamera()
  expect(received).toEqual(['pointermove', 'keydown:Space', 'mousemove'])
})

it('refreshes the HQ artboard after a jump with its switch off, since HQ checks no input', () => {
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  stage.append(frame)
  document.body.append(stage)
  harness.alliance = { stage, frame } as unknown as ActiveAllianceSurface
  document.elementFromPoint = () => frame
  frame.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      pointerType: 'mouse',
      clientX: 5,
      clientY: 5,
    }),
  )
  received.length = 0
  markPaintTargetStale()
  refreshPaintTarget(frame, 'pointermove')
  key('keydown')
  expect(received).toEqual(['pointermove', 'keydown:Space'])
})
