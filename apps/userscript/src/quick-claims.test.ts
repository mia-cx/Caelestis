// @vitest-environment happy-dom
import {
  MAX_QUICK_CLAIMS,
  type PresenceRect,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { PresenceView } from './presence-client.js'
import { installQuickClaims, quickClaimItems, quickClaimRect } from './quick-claims.js'

const harness = vi.hoisted(() => ({
  open: true,
  claims: [] as readonly PresenceRect[],
  drawer: [] as (() => void)[],
  toasts: [] as string[],
  showPresenceClaims: true,
  sharePresence: true,
  stateListeners: [] as ((state: { sharePresence: boolean }) => void)[],
}))
vi.mock('./state.js', () => ({
  getState: () => ({
    sharePresence: harness.sharePresence,
    showPresence: true,
    showPresenceClaims: harness.showPresenceClaims,
    showPresenceClaimsOnlyWhilePainting: false,
  }),
  onStateChange: (listener: (state: { sharePresence: boolean }) => void) =>
    harness.stateListeners.push(listener),
}))
vi.mock('./wplace-paint.js', () => ({
  isPaintOpen: () => harness.open,
  onPaintSelectionChange: (listener: () => void) => harness.drawer.push(listener),
}))
// One client pixel is one canvas pixel. Like the real map, the position is fractional: the pointer
// lands inside a pixel, never on its corner. Anything but the canvas is off the map.
vi.mock('./wplace-picker.js', () => ({
  pickerPointAt: (target: Element, x: number, y: number) =>
    target.tagName === 'CANVAS'
      ? { surface: WORLD_TEMPLATE_SURFACE, x: x + 0.75, y: y + 0.25, alliance: null }
      : null,
}))
vi.mock('./presence-client.js', () => ({
  presenceQuickClaims: () => harness.claims,
  setPresenceQuickClaims: (rects: readonly PresenceRect[]) => {
    harness.claims = rects
  },
}))
vi.mock('./ui/notification-host.js', () => ({
  showToast: (message: string) => harness.toasts.push(message),
}))

let canvas: HTMLCanvasElement
let reachedWplace: string[]

const pointer = (
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
  ctrlKey = true,
): PointerEvent => {
  const event = new PointerEvent(type, {
    pointerId: 1,
    button: 0,
    clientX: x,
    clientY: y,
    ctrlKey,
    bubbles: true,
    cancelable: true,
  })
  canvas.dispatchEvent(event)
  return event
}

/** The click a browser dispatches after a release, before its next task. */
const click = (type: 'click' | 'auxclick' = 'click'): void => {
  canvas.dispatchEvent(
    new MouseEvent(type, { button: type === 'click' ? 0 : 2, bubbles: true, cancelable: true }),
  )
}
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const drag = (from: [number, number], to: [number, number], ctrlKey = true): void => {
  pointer('pointerdown', ...from, ctrlKey)
  pointer('pointermove', ...to, ctrlKey)
  pointer('pointerup', ...to, ctrlKey)
}

beforeAll(() => installQuickClaims())

beforeEach(() => {
  harness.open = true
  harness.claims = []
  harness.toasts = []
  harness.showPresenceClaims = true
  harness.sharePresence = true
  document.body.innerHTML = ''
  canvas = document.createElement('canvas')
  document.body.append(canvas)
  reachedWplace = []
  for (const type of [
    'pointerdown',
    'pointermove',
    'pointerup',
    'click',
    'auxclick',
    'contextmenu',
  ])
    canvas.addEventListener(type, () => reachedWplace.push(type))
})

it('claims the dragged rectangle, both corners included, without Wplace seeing the drag', async () => {
  drag([120, 80], [100, 90])
  click()
  expect(harness.claims).toEqual([{ x: 100, y: 80, w: 21, h: 11 }])
  expect(reachedWplace).toEqual([])
  // Only the gesture's own click is kept from Wplace; the next one is an ordinary click.
  await nextTask()
  click()
  expect(reachedWplace).toEqual(['click'])
})

it('ends the claim where the pointer is released, even past its last move', () => {
  pointer('pointerdown', 0, 0)
  pointer('pointermove', 10, 10)
  pointer('pointerup', 30, 20)
  pointer('pointerdown', 100, 100)
  pointer('pointerup', 140, 110)
  expect(harness.claims).toEqual([
    { x: 0, y: 0, w: 31, h: 21 },
    { x: 100, y: 100, w: 41, h: 11 },
  ])
})

it("keeps a secondary-button Ctrl+click's auxclick from Wplace too", () => {
  drag([0, 0], [10, 10])
  pointer('pointerdown', 5, 5)
  pointer('pointerup', 5, 5)
  click('auxclick')
  expect(harness.claims).toEqual([])
  expect(reachedWplace).toEqual([])
})

it('leaves a plain drag, or a Ctrl+drag with the paint drawer closed, to Wplace', () => {
  drag([10, 10], [40, 40], false)
  harness.open = false
  drag([10, 10], [40, 40])
  expect(harness.claims).toEqual([])
  expect(reachedWplace).toContain('pointerdown')
})

it('removes the quick claim under a Ctrl+click and ignores one outside every claim', () => {
  drag([0, 0], [10, 10])
  drag([50, 50], [60, 60])
  pointer('pointerdown', 200, 200)
  pointer('pointerup', 200, 200)
  expect(harness.claims).toHaveLength(2)
  pointer('pointerdown', 5, 5)
  pointer('pointerup', 5, 5)
  expect(harness.claims).toEqual([{ x: 50, y: 50, w: 11, h: 11 }])
})

it('clears every quick claim when the paint drawer closes', () => {
  drag([0, 0], [10, 10])
  harness.open = false
  for (const listener of harness.drawer) listener()
  expect(harness.claims).toEqual([])
})

it('keeps a Ctrl+click on the map from opening the context menu only while painting', () => {
  const menu = (ctrlKey: boolean, target: Element): boolean => {
    const event = new MouseEvent('contextmenu', { ctrlKey, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event.defaultPrevented
  }
  expect(menu(true, canvas)).toBe(true)
  expect(menu(false, canvas)).toBe(false)
  expect(menu(true, document.body)).toBe(false)
  harness.open = false
  expect(menu(true, canvas)).toBe(false)
})

it('refuses a claim past the limit or over the area limit, and says why', () => {
  for (let index = 0; index < MAX_QUICK_CLAIMS; index++)
    drag([index * 20, 0], [index * 20 + 10, 10])
  drag([0, 100], [10, 110])
  drag([0, 0], [2_500, 2_500])
  expect(harness.claims).toHaveLength(MAX_QUICK_CLAIMS)
  expect(harness.toasts).toHaveLength(2)
})

it('cancels the drag on Escape and still keeps the rest of the gesture from Wplace', () => {
  pointer('pointerdown', 0, 0)
  pointer('pointermove', 30, 30)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
  pointer('pointermove', 40, 40)
  pointer('pointerup', 40, 40)
  click()
  expect(harness.claims).toEqual([])
  expect(reachedWplace).toEqual([])
})

it('snaps each corner to the whole pixel under it and keeps the rectangle on the canvas', () => {
  expect(
    quickClaimRect({ x: WORLD_PIXELS - 1.5, y: -0.4 }, { x: WORLD_PIXELS + 9.9, y: 3.9 }),
  ).toEqual({
    x: WORLD_PIXELS - 2,
    y: 0,
    w: 2,
    h: 4,
  })
})

it("draws your quick claims while painting and others' only where claims show", () => {
  const me = { wplaceUserId: 1, displayName: 'Mia' }
  const peer = { wplaceUserId: 2, displayName: 'Other painter' }
  const view: PresenceView = {
    peers: [
      {
        sessionId: 'peer',
        painter: peer,
        viewport: null,
        draft: null,
        quickClaims: [{ x: 5, y: 5, w: 5, h: 5 }],
      },
    ],
    regions: [],
    online: 1,
    connected: true,
    me,
  }
  drag([0, 0], [3, 3])
  expect(quickClaimItems(view).map(({ key, mine }) => [key, mine])).toEqual([
    ['quick:me:0', true],
    ['quick:peer:0', false],
  ])
  harness.showPresenceClaims = false
  expect(quickClaimItems(view).map(({ key }) => key)).toEqual(['quick:me:0'])
})

it('ends quick claims when sharing stops and claims nothing while it is off', () => {
  drag([0, 0], [10, 10])
  harness.sharePresence = false
  for (const listener of harness.stateListeners) listener({ sharePresence: false })
  expect(harness.claims).toEqual([])
  drag([20, 20], [30, 30])
  expect(harness.claims).toEqual([])
  expect(reachedWplace).toContain('pointerdown')
})

it('drops a drag still in progress when sharing stops', () => {
  pointer('pointerdown', 0, 0)
  pointer('pointermove', 20, 20)
  harness.sharePresence = false
  for (const listener of harness.stateListeners) listener({ sharePresence: false })
  pointer('pointerup', 30, 30)
  click()
  expect(harness.claims).toEqual([])
  expect(reachedWplace).toEqual([])
})
