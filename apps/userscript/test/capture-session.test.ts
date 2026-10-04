import { afterEach, expect, it, vi } from 'vitest'
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

it('owns touch drawing without swallowing the next toolbar action or Hand gesture', () => {
  const canvas = document.body.appendChild(document.createElement('canvas'))
  const mapTouch = vi.fn()
  canvas.addEventListener('touchstart', mapTouch)
  canvas.addEventListener('touchmove', mapTouch)
  canvas.addEventListener('touchend', mapTouch)
  installClaimEditor({
    myRegions: () => [],
    templateFor: () => null,
    changed: () => {},
    save: async () => ({ ids: [], error: null }),
  })
  startCaptureMode({ capture: async () => null })
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

it('aborts a closed capture and leaves a newer selection intact when its result arrives', async () => {
  const canvas = document.body.appendChild(document.createElement('canvas'))
  const draw = (x: number) => {
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
  installClaimEditor({
    myRegions: () => [],
    templateFor: () => null,
    changed: () => {},
    save: async () => ({ ids: [], error: null }),
  })
  let finish!: (result: string | null) => void
  const result = new Promise<string | null>((resolve) => {
    finish = resolve
  })
  let signal: AbortSignal | undefined
  startCaptureMode({
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
  startCaptureMode({ capture: async () => null })
  draw(30)
  const newer = claimModeModel()
  finish(null)
  await result

  expect(isClaimModeActive()).toBe(true)
  expect(claimModeModel()).toEqual(newer)
})
