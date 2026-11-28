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
  lobbies: [],
  painters: 2,
  maxPainters: 8,
  guards: 0,
  maxGuards: 2,
  staggerMs: 500,
  anchor: null,
  members: [ada, bea],
  role: 'painter',
  proposals: [],
  locked: true,
  needs: 0,
  canStart: false,
  mySlotAt: null,
  myTurn: 2,
  turns: 2,
  startsAt: null,
} satisfies CaptureRunModel

const gathering = { ...counting, phase: 'gathering', admin: true } satisfies CaptureRunModel

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

/** A button by its accessible name: its label, or its text for a text button. */
const button = (card: HTMLElement, label: string) =>
  [...card.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === label,
  ) ?? null

describe('capture lobby countdown', () => {
  it('announces only the marked seconds and clamps the clock at the slot', () => {
    const spoken = (inMs: number) =>
      render({ ...counting, mySlotAt: performance.now() + inMs }).querySelector('[role="status"]')
        ?.textContent
    expect(spoken(30_000)).toContain('Countdown started')
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

describe('the lobby list', () => {
  const listing = {
    ...counting,
    phase: 'list',
    members: [],
    role: null,
    lobbies: [
      { id: 'one', name: 'Ada', members: 3, canJoin: true },
      { id: 'two', name: 'Cy', members: 1, canJoin: false },
    ],
  } satisfies CaptureRunModel

  it('joins a lobby from its row, and only a runner opens a new one', () => {
    const intents: CaptureRunIntent[] = []
    const card = render(listing, intents)
    const rows = [...card.querySelectorAll('.lobbies li')]
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('3 painters'),
      expect.stringContaining('1 painter'),
    ])
    rows[0]?.querySelector('button')?.click()
    expect(intents).toEqual([{ type: 'join', id: 'one' }])
    expect(rows[1]?.querySelector('button')?.disabled).toBe(true)
    expect(button(card, 'New lobby')).toBeNull()

    const runner = render({ ...listing, admin: true }, intents)
    button(runner, 'New lobby')?.click()
    expect(intents.at(-1)).toEqual({ type: 'open' })
  })
})

describe('a runner inside a lobby', () => {
  it('steps the stagger by 50 ms within its bounds until the countdown', () => {
    const intents: CaptureRunIntent[] = []
    const card = render({ ...gathering, staggerMs: 500 }, intents)
    expect(card.textContent).toContain('500 ms')
    button(card, 'Shorter stagger')?.click()
    button(card, 'Longer stagger')?.click()
    expect(intents).toEqual([
      { type: 'set-stagger', staggerMs: 450 },
      { type: 'set-stagger', staggerMs: 550 },
    ])
    expect(button(render({ ...gathering, staggerMs: 100 }), 'Shorter stagger')?.disabled).toBe(true)
    // A painter sees no settings, and nobody does once the countdown runs.
    expect(button(render({ ...gathering, admin: false }), 'Longer stagger')).toBeNull()
    expect(button(render({ ...counting, admin: true }), 'Longer stagger')).toBeNull()
  })

  it('locks in a proposal that fits, and says how many painters one that does not needs', () => {
    const intents: CaptureRunIntent[] = []
    const proposal = { label: 'Into purple', gained: 900, pixels: 120, needs: 0 }
    const card = render(
      {
        ...gathering,
        locked: false,
        proposals: [
          { ...proposal, id: 'fits' },
          { ...proposal, id: 'long', label: 'Into blue', needs: 2 },
        ],
      },
      intents,
    )
    const [fits, long] = [...card.querySelectorAll<HTMLButtonElement>('.plans button')]
    expect(long?.disabled).toBe(true)
    expect(card.textContent).toContain('Needs 2 more painters')
    fits?.click()
    expect(intents).toEqual([{ type: 'lock', id: 'fits' }])
    // Nothing is locked in yet, so there is no countdown to start.
    expect(button(card, 'Start countdown')).toBeNull()
  })

  it('cancels the locked shape, and starts the countdown only once every leg is drafted', () => {
    const intents: CaptureRunIntent[] = []
    const waiting = render(gathering, intents)
    expect(button(waiting, 'Start countdown')?.disabled).toBe(true)
    button(waiting, 'Cancel proposed shape')?.click()
    const ready = render({ ...gathering, canStart: true }, intents)
    button(ready, 'Start countdown')?.click()
    expect(intents).toEqual([{ type: 'unlock' }, { type: 'go' }])
  })

  it('moves a painter and a guard past the coordinator, who stays on the closing leg', () => {
    const intents: CaptureRunIntent[] = []
    const card = render(
      {
        ...gathering,
        guards: 1,
        members: [ada, { ...bea, closes: true }, { ...ada, id: 'g', name: 'Gil', guard: true }],
      },
      intents,
    )
    const rows = [...card.querySelectorAll('.members li')]
    expect(rows[1]?.textContent).toContain('Closes wall')
    expect(button(card, 'Move Bea up')).toBeNull()
    expect(button(card, 'Move Ada up')?.disabled).toBe(true)
    button(card, 'Move Ada down')?.click()
    button(card, 'Move Gil up')?.click()
    expect(intents).toEqual([
      { type: 'move', id: 'a', by: 1 },
      { type: 'move', id: 'g', by: -1 },
    ])
    expect(button(card, 'Move Gil down')?.disabled).toBe(true)
  })
})
