import { flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import CaptureRun from '../src/capture/CaptureRun.svelte'
import type { CaptureRunIntent, CaptureRunModel } from '../src/capture/model.js'

const counting = {
  phase: 'countdown',
  admin: false,
  painters: 2,
  maxPainters: 8,
  guards: 0,
  maxGuards: 2,
  anchor: null,
  members: [
    { id: 'a', name: 'Ada', colour: 'red', drafted: 40, length: 40, me: false, guard: false },
    { id: 'b', name: 'Bea', colour: 'blue', drafted: 12, length: 40, me: true, guard: false },
  ],
  joined: true,
  role: 'painter',
  canJoin: false,
  proposals: [],
  proposing: false,
  canStart: false,
  mySlotAt: null,
  myTurn: 2,
  startsAt: null,
} satisfies CaptureRunModel

const mounted: object[] = []
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((component) => unmount(component)))
  document.body.replaceChildren()
})

const render = (model: CaptureRunModel, intents: CaptureRunIntent[] = []) => {
  const target = document.body.appendChild(document.createElement('div'))
  mounted.push(
    mount(CaptureRun, { target, props: { model, onIntent: (intent) => intents.push(intent) } }),
  )
  flushSync()
  return target
}

describe('capture run countdown', () => {
  it('announces only the marked seconds and clamps the clock at the slot', () => {
    const spoken = (inMs: number) =>
      render({ ...counting, mySlotAt: performance.now() + inMs }).querySelector('[role="status"]')
        ?.textContent
    expect(spoken(30_000)).toContain('Capture run started')
    expect(spoken(7_400)).toContain('Paint in 10 seconds')
    expect(spoken(4_200)).toContain('Paint in 5 seconds')

    const slot = render({ ...counting, mySlotAt: performance.now() - 250 })
    expect(slot.querySelector('[role="status"]')?.textContent).toContain('Paint now')
    expect(slot.querySelector('.big')?.textContent).toBe('00:00.000')
  })
})

it('tells a guard whose anchor was cut to repaint, once their slot has passed', () => {
  const card = render({
    ...counting,
    guards: 1,
    anchor: 'cut',
    myTurn: null,
    mySlotAt: performance.now() - 1_000,
  })
  expect(card.textContent).toContain('Anchor cut')
  expect(card.textContent).toContain('Repaint your line.')
})
