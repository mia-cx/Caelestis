import { afterEach, expect, it } from 'vitest'
import {
  keepRefusedDrafts,
  type TerritoryPaintResult,
  type TerritoryStore,
} from './territory-refusals.js'
import { useWplaceCatalog } from './wplace-messages.js'

afterEach(() => useWplaceCatalog(null))

type Batch = TerritoryPaintResult

/**
 * A store shaped like Wplace's: `paint` lives on the prototype and sends one `request` per batch,
 * summing the results and keeping the last reason, as Wplace's does.
 */
class FakeStore implements TerritoryStore {
  sent: unknown[] = []
  constructor(private readonly answers: () => Promise<Batch[]>) {}
  async paint(pixels: unknown): Promise<TerritoryPaintResult> {
    this.sent.push(pixels)
    const total: { painted: number; refused: number; reason?: string | undefined } = { painted: 0, refused: 0 }
    for (const batch of await this.answers()) {
      const { result } = await this.request({ t: 'paint', batch })
      total.painted += result.painted
      total.refused += result.refused
      total.reason = result.reason ?? total.reason
    }
    return total
  }
  async request(message: { t?: unknown; batch?: Batch }): Promise<{ result: Batch }> {
    return { result: message.batch ?? { painted: 0, refused: 0 } }
  }
}

const storeAnswering = (...batches: Batch[]): FakeStore => {
  const store = new FakeStore(async () => batches)
  keepRefusedDrafts(store)
  return store
}

it.each([
  { painted: 3, refused: 0 },
  { painted: 1, refused: 2, reason: 'own' },
])('resolves a paint whose every batch landed or was already owned: %o', async (result) => {
  const store = storeAnswering(result, { painted: 0, refused: 2, reason: 'own' })
  await expect(store.paint([{ x: 1, y: 2 }])).resolves.toMatchObject({ painted: result.painted })
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

it('rejects a paint whose earlier batch was refused, though the last batch was already owned', async () => {
  const store = storeAnswering(
    { painted: 0, refused: 64, reason: 'not-adjacent' },
    { painted: 0, refused: 1, reason: 'own' },
  )
  await expect(store.paint([])).rejects.toThrow("You can only paint next to your team's territory.")
})
