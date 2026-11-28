import { afterEach, expect, it } from 'vitest'
import {
  keepRefusedDrafts,
  type TerritoryPaintResult,
  type TerritoryRequest,
  type TerritoryStore,
} from './territory-refusals.js'
import { useWplaceCatalog } from './wplace-messages.js'

afterEach(() => useWplaceCatalog(null))

type Pixel = { x: number; y: number }
type Cells = [number, number][]

/** Small batches, so a few pixels make a multi-batch paint; Wplace's are 64. */
const BATCH = 2

const NOT_ADJACENT = "You can only paint next to your team's territory."

/**
 * A store shaped like Wplace's: `paint` lives on the prototype and sends one `request` per batch of
 * `[x, y]` cells, summing the results and keeping the last reason, as Wplace's does. The server
 * answers each batch.
 */
class FakeStore implements TerritoryStore {
  sent: unknown[] = []
  constructor(private readonly server: (cells: Cells) => Promise<TerritoryPaintResult>) {}
  async paint(pixels: unknown): Promise<TerritoryPaintResult> {
    this.sent.push(pixels)
    const all = pixels as Pixel[]
    let painted = 0
    let refused = 0
    let reason: string | undefined
    for (let start = 0; start < all.length; start += BATCH) {
      const cells = all.slice(start, start + BATCH).map(({ x, y }) => [x, y])
      const { result } = await this.request({ t: 'paint', pixels: cells })
      painted += result.painted
      refused += result.refused
      reason = result.reason ?? reason
    }
    return reason === undefined ? { painted, refused } : { painted, refused, reason }
  }
  async request(message: TerritoryRequest): Promise<{ result: TerritoryPaintResult }> {
    return { result: await this.server(message.pixels as Cells) }
  }
}

const wrapped = (server: (cells: Cells) => Promise<TerritoryPaintResult>): FakeStore => {
  const store = new FakeStore(server)
  keepRefusedDrafts(store)
  return store
}

/** A store whose server answers its batches in order. */
const storeAnswering = (...batches: TerritoryPaintResult[]): FakeStore => {
  let next = 0
  return wrapped(async () => batches[next++] ?? { painted: 0, refused: 0 })
}

const pixels = (count: number, y = 0): Pixel[] =>
  Array.from({ length: count }, (_, x) => ({ x, y }))

it.each([
  { painted: 2, refused: 0 },
  { painted: 1, refused: 1, reason: 'own' },
])('resolves a paint whose every batch landed or was already owned: %o', async (first) => {
  const store = storeAnswering(first, { painted: 0, refused: 2, reason: 'own' })
  await expect(store.paint(pixels(4))).resolves.toMatchObject({ painted: first.painted })
  expect(store.sent).toEqual([pixels(4)])
})

it.each([
  ['not-adjacent', NOT_ADJACENT],
  ['no-charges', 'No more charges'],
  ['a-reason-wplace-adds-later', NOT_ADJACENT],
])('rejects a paint refused as %s, so Wplace keeps the draft', async (reason, message) => {
  const store = storeAnswering({ painted: 0, refused: 2, reason })
  await expect(store.paint(pixels(2))).rejects.toThrow(message)
})

it('rejects a partly refused paint with Wplace message in the reader language', async () => {
  useWplaceCatalog(() => ({ territory_not_adjacent: 'Dipingi accanto al tuo territorio' }))
  const store = storeAnswering({ painted: 1, refused: 1, reason: 'not-adjacent' })
  await expect(store.paint(pixels(2))).rejects.toThrow('Dipingi accanto al tuo territorio')
})

it('passes a failed paint through unchanged', async () => {
  const failure = new Error('disconnected')
  const store = wrapped(() => Promise.reject(failure))
  await expect(store.paint(pixels(1))).rejects.toBe(failure)
})

it('rejects a paint whose earlier batch was refused, though the last batch was already owned', async () => {
  const store = storeAnswering(
    { painted: 0, refused: 2, reason: 'not-adjacent' },
    { painted: 0, refused: 1, reason: 'own' },
  )
  await expect(store.paint(pixels(3))).rejects.toThrow(NOT_ADJACENT)
})

it("keeps a cancelled paint's late refusal off the draft submitted after it", async () => {
  // The painter cancels the first paint while it waits, then submits a second draft.
  // Both wait on the server; the first's refusal arrives while the second is still pending.
  let refuseFirst = () => {}
  let acceptSecond = () => {}
  const store = wrapped(
    (cells) =>
      new Promise((resolve) => {
        if (cells[0]?.[1] === 0)
          refuseFirst = () => resolve({ painted: 0, refused: 1, reason: 'not-adjacent' })
        else acceptSecond = () => resolve({ painted: 1, refused: 0 })
      }),
  )
  const first = store.paint(pixels(1, 0))
  const second = store.paint(pixels(1, 1))
  await Promise.resolve()
  refuseFirst()
  await expect(first).rejects.toThrow(NOT_ADJACENT)
  acceptSecond()
  await expect(second).resolves.toEqual({ painted: 1, refused: 0 })
})

it('keeps a late refusal off a later draft over the same cells', async () => {
  // The painter cancels the first paint while it waits, then redraws the same cell.
  const answers: ((result: TerritoryPaintResult) => void)[] = []
  const store = wrapped(() => new Promise((resolve) => answers.push(resolve)))
  const first = store.paint(pixels(1))
  const second = store.paint(pixels(1))
  await Promise.resolve()
  answers[0]?.({ painted: 0, refused: 1, reason: 'not-adjacent' })
  await expect(first).rejects.toThrow(NOT_ADJACENT)
  answers[1]?.({ painted: 1, refused: 0 })
  await expect(second).resolves.toEqual({ painted: 1, refused: 0 })
})
