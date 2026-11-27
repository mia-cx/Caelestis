import { flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import CaptureRun from '../src/capture/CaptureRun.svelte'
import type { CaptureRunIntent, CaptureRunMember, CaptureRunModel } from '../src/capture/model.js'

const ada = {
  id: 'a',
  name: 'Ada',
  colour: 'red',
  drafted: 40,
  length: 40,
  me: false,
  guard: false,
  closes: false,
} satisfies CaptureRunMember
const bea = { ...ada, id: 'b', name: 'Bea', colour: 'blue', drafted: 12, me: true }

const counting = {
  phase: 'countdown',
  admin: false,
  painters: 2,
  maxPainters: 8,
  guards: 0,
  maxGuards: 2,
  staggerMs: 500,
  anchor: null,
  members: [ada, bea],
  joined: true,
  role: 'painter',
  canJoin: false,
  proposals: [],
  proposing: false,
  canStart: false,
  mySlotAt: null,
  myTurn: 2,
  turns: 2,
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

it('steps the stagger by 50 ms within its bounds before a run opens', () => {
  const intents: CaptureRunIntent[] = []
  const button = (card: HTMLElement, label: string) =>
    card.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  const card = render({ ...counting, phase: 'none', admin: true, staggerMs: 500 }, intents)
  expect(card.textContent).toContain('500 ms')
  button(card, 'Shorter stagger')?.click()
  button(card, 'Longer stagger')?.click()
  expect(intents).toEqual([
    { type: 'set-stagger', staggerMs: 450 },
    { type: 'set-stagger', staggerMs: 550 },
  ])
  const shortest = render({ ...counting, phase: 'none', admin: true, staggerMs: 200 })
  expect(button(shortest, 'Shorter stagger')?.disabled).toBe(true)
})

it('keeps the coordinator on the closing line while the administrator orders the rest', () => {
  const card = render({
    ...counting,
    phase: 'gathering',
    admin: true,
    members: [{ ...ada, id: 'c', name: 'Cy' }, ada, { ...bea, closes: true }],
  })
  const rows = [...card.querySelectorAll('.members li')]
  expect(rows[2]?.textContent).toContain('Closes wall')
  const disabled = (label: string) =>
    card.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.disabled
  expect(disabled('Move Bea up')).toBe(true)
  expect(disabled('Move Ada down')).toBe(true)
  expect(disabled('Move Cy down')).toBe(false)
})
