import { afterEach, expect, it } from 'vitest'
import {
  keepRefusedDrafts,
  type TerritoryPaintResult,
  type TerritoryStore,
} from './territory-refusals.js'
import { useWplaceCatalog } from './wplace-messages.js'

afterEach(() => useWplaceCatalog(null))

/** A store shaped like Wplace's: `paint` lives on the prototype and answers what the server did. */
class FakeStore implements TerritoryStore {
  sent: unknown[] = []
  constructor(private readonly answer: () => Promise<TerritoryPaintResult>) {}
  paint(pixels: unknown): Promise<TerritoryPaintResult> {
    this.sent.push(pixels)
    return this.answer()
  }
}

const storeAnswering = (result: TerritoryPaintResult): FakeStore => {
  const store = new FakeStore(async () => result)
  keepRefusedDrafts(store)
  return store
}

it.each([
  { painted: 3, refused: 0 },
  { painted: 1, refused: 2, reason: 'own' },
])('resolves a paint Wplace would clear the draft after: %o', async (result) => {
  const store = storeAnswering(result)
  await expect(store.paint([{ x: 1, y: 2 }])).resolves.toEqual(result)
  expect(store.sent).toEqual([[{ x: 1, y: 2 }]])
})

it.each([
  ['not-adjacent', "You can only paint next to your team's territory."],
  ['no-charges', 'No more charges'],
  ['a-reason-wplace-adds-later', "You can only paint next to your team's territory."],
])('rejects a paint refused as %s, so Wplace keeps the draft', async (reason, message) => {
  const store = storeAnswering({ painted: 0, refused: 4, reason })
  await expect(store.paint([])).rejects.toThrow(message)
})

it('rejects a partly refused paint with Wplace message in the reader language', async () => {
  useWplaceCatalog(() => ({ territory_not_adjacent: 'Dipingi accanto al tuo territorio' }))
  const store = storeAnswering({ painted: 2, refused: 1, reason: 'not-adjacent' })
  await expect(store.paint([])).rejects.toThrow('Dipingi accanto al tuo territorio')
})

it('passes a failed paint through unchanged', async () => {
  const failure = new Error('disconnected')
  const store = new FakeStore(() => Promise.reject(failure))
  keepRefusedDrafts(store)
  await expect(store.paint([])).rejects.toBe(failure)
})
