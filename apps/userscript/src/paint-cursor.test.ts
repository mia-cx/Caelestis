// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ActiveAllianceSurface } from './alliance-surface.js'
import type { MapLike } from './map-handle.js'
import { installPaintTargetGuard, syncPaintTargetMap } from './paint-cursor.js'

const harness = vi.hoisted(() => ({
  open: true,
  alliance: null as ActiveAllianceSurface | null,
  surfaceListener: null as ((surface: ActiveAllianceSurface | null) => void) | null,
}))
vi.mock('./wplace-paint.js', () => ({ isPaintOpen: () => harness.open }))
vi.mock('./alliance-surface.js', () => ({
  activeAllianceSurface: () => harness.alliance,
  onActiveAllianceSurfaceChange: (listener: (surface: ActiveAllianceSurface | null) => void) => {
    harness.surfaceListener = listener
    return () => {
      harness.surfaceListener = null
    }
  },
}))

/** What Wplace's own handlers receive: Space presses on `document`, moves on `window`. */
let received: string[]
let cameraListeners: Set<() => void>
let teardown: (() => void)[]

const map = {
  on: (_type: 'move', listener: () => void) => cameraListeners.add(listener),
  off: (_type: 'move', listener: () => void) => cameraListeners.delete(listener),
} as unknown as MapLike
const moveCamera = (): void => {
  for (const listener of cameraListeners) listener()
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
  harness.alliance = null
  received = []
  cameraListeners = new Set()
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

it('leaves Space alone in text fields and while the paint drawer is closed', () => {
  const input = document.createElement('input')
  document.body.append(input)
  moveCamera()
  key('keydown', input)
  harness.open = false
  key('keydown')
  expect(received).toEqual(['keydown:Space', 'keydown:Space'])
})

it("guards HQ's artboard until a pointer move over it", async () => {
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  stage.append(frame)
  document.body.append(stage)
  harness.alliance = { stage, frame } as unknown as ActiveAllianceSurface
  harness.surfaceListener?.(harness.alliance)

  frame.style.transform = 'translate(10px, 0px)'
  await Promise.resolve()
  key('keydown')
  move('pointermove')
  move('mousemove', frame)
  key('keydown')
  expect(received).toEqual(['pointermove', 'mousemove'])

  move('pointermove', frame)
  key('keydown')
  expect(received).toEqual(['pointermove', 'mousemove', 'pointermove', 'keydown:Space'])
})
