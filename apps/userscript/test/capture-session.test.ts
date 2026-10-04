import type { CaptureAction } from '@caelestis/ui/elements'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  claimModeModel,
  handleClaimModeIntent,
  installClaimEditor,
  isClaimModeActive,
  startCaptureMode,
  stopClaimMode,
} from '../src/claim-editor.js'

vi.mock('../src/main.js', () => ({
  canvasPixelAt: (x: number, y: number) => ({ x, y }),
  isMapInteractionTarget: (target: EventTarget | null) => target instanceof HTMLCanvasElement,
  screenProjection: () => null,
}))
vi.mock('../src/map-handle.js', () => ({ getMap: () => null }))
vi.mock('../src/ui/theme.js', () => ({ applyWplaceTheme: () => {} }))
vi.mock('../src/wplace-pixel-card.js', () => ({ dismissWplacePixelCard: () => {} }))

afterEach(() => {
  stopClaimMode()
  document.body.replaceChildren()
})

/** Drag a rectangle across the map, starting at screen x. */
const draw = (x: number) => {
  const canvas = document.body.appendChild(document.createElement('canvas'))
  for (const [type, px] of [
    ['pointerdown', x],
    ['pointermove', x + 10],
    ['pointerup', x + 10],
  ] as const) {
    canvas.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        button: 0,
        clientX: px,
        clientY: 10,
      }),
    )
  }
}

beforeEach(() => {
  installClaimEditor({
    myRegions: () => [],
    templateFor: () => null,
    changed: () => {},
    save: async () => ({ ids: [], error: null }),
  })
})

it('owns touch drawing without swallowing the next toolbar action or Hand gesture', () => {
  const canvas = document.body.appendChild(document.createElement('canvas'))
  const mapTouch = vi.fn()
  canvas.addEventListener('touchstart', mapTouch)
  canvas.addEventListener('touchmove', mapTouch)
  canvas.addEventListener('touchend', mapTouch)
  startCaptureMode({ purpose: 'capture', capture: async () => null })
  const gesture = () => {
    for (const [pointer, touch, x, down] of [
      ['pointerdown', 'touchstart', 10, true],
      ['pointermove', 'touchmove', 30, true],
      ['pointerup', 'touchend', 30, false],
    ] as const) {
      canvas.dispatchEvent(
        new PointerEvent(pointer, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'touch',
          button: 0,
          clientX: x,
          clientY: x,
        }),
      )
      canvas.dispatchEvent(
        new TouchEvent(touch, {
          bubbles: true,
          cancelable: true,
          touches: down
            ? [new Touch({ identifier: 1, target: canvas, clientX: x, clientY: x })]
            : [],
        }),
      )
    }
  }

  gesture()
  expect(claimModeModel().pixels).toBeGreaterThan(0)
  expect(mapTouch).not.toHaveBeenCalled()

  const hand = document.body.appendChild(document.createElement('button'))
  hand.addEventListener('click', () => handleClaimModeIntent({ type: 'set-tool', tool: 'hand' }))
  hand.click()
  expect(claimModeModel().tool).toBe('hand')
  gesture()
  expect(mapTouch).toHaveBeenCalledTimes(3)
})

it('runs the update on Enter and leaves keys inside its confirmation dialog alone', () => {
  const actions: CaptureAction[] = []
  startCaptureMode({
    purpose: 'update',
    capture: (_selection, action) => {
      actions.push(action)
      return new Promise(() => {})
    },
  })
  draw(10)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
  expect(actions).toEqual(['update'])
  expect(claimModeModel().pending).toBe(true)

  const dialog = document.body.appendChild(document.createElement('dialog'))
  dialog.setAttribute('open', '')
  const leave = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  dialog.appendChild(document.createElement('button')).dispatchEvent(leave)

  expect(leave.defaultPrevented).toBe(false)
  expect(isClaimModeActive()).toBe(true)
})

it('aborts a closed capture and leaves a newer selection intact when its result arrives', async () => {
  let finish!: (result: string | null) => void
  const result = new Promise<string | null>((resolve) => {
    finish = resolve
  })
  let signal: AbortSignal | undefined
  startCaptureMode({
    purpose: 'capture',
    capture: (_selection, _action, cancellation) => {
      signal = cancellation
      return result
    },
  })
  draw(10)
  expect(claimModeModel().pixels).toBeGreaterThan(0)
  handleClaimModeIntent({ type: 'capture', action: 'template' })
  expect(claimModeModel().pending).toBe(true)

  stopClaimMode()
  expect(signal?.aborted).toBe(true)
  startCaptureMode({ purpose: 'capture', capture: async () => null })
  draw(30)
  const newer = claimModeModel()
  finish(null)
  await result

  expect(isClaimModeActive()).toBe(true)
  expect(claimModeModel()).toEqual(newer)
})

it('keeps the selection a pending capture is using', () => {
  startCaptureMode({ purpose: 'capture', capture: () => new Promise(() => {}) })
  draw(10)
  const selection = claimModeModel()
  handleClaimModeIntent({ type: 'capture', action: 'template' })

  handleClaimModeIntent({ type: 'set-subtract', subtract: true })
  expect(claimModeModel()).toMatchObject({
    subtract: false,
    pixels: selection.pixels,
    pending: true,
  })
})
