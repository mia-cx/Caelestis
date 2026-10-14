import {
  millis,
  seconds,
  type TemplateProgressHistoryResponse,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemorySqlStore } from '../src/adapters/memory/memory-sql-store.js'
import type { SqlStore, TemplateVersionRecord } from '../src/ports/sql-store.js'
import { authorized, createTestBackend } from './support/backend.js'
import { openRelationalStore } from './support/relational.js'

const templateId = '01890f3e-7b2c-7abc-8def-012345678901'
const originalId = '01890f3e-7b2c-7abc-8def-012345678902'
const updatedId = '01890f3e-7b2c-7abc-8def-012345678903'
const start = 1_780_000_000
const tokenHash = 'a'.repeat(64)
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(closers.splice(0).map((close) => close()))
})

const version = (
  id: string,
  at: number,
  total: number,
  tiles: readonly number[],
): TemplateVersionRecord => ({
  templateId,
  versionId: id,
  surface: WORLD_TEMPLATE_SURFACE,
  season: 3,
  nodeId: null,
  name: 'Artwork with history',
  createdWithToken: tokenHash,
  createdByUserId: null,
  createdAt: millis(at * 1_000),
  bbox: {
    minX: Math.min(...tiles) * 1_000,
    minY: 0,
    maxX: 1 + Math.max(...tiles) * 1_000,
    maxY: 1,
  },
  totalPixels: total,
  chunks: tiles.map((tileX) => ({ tileX, tileY: 0, hash: 'b'.repeat(64) })),
})

const observe = async (
  sql: SqlStore,
  versionId: string,
  tileX: number,
  at: number,
  correct: number,
  wrong: number,
) => {
  const hash = at.toString(16).padStart(62, '0') + tileX.toString(16).padStart(2, '0')
  await sql.recordTileObservation(
    {
      season: 3,
      tile: { x: tileX, y: 0 },
      hash,
      observedAt: millis(at * 1_000),
      reportedAt: seconds(at),
      reportedWithToken: tokenHash,
      reportedByUserId: 42,
    },
    [],
  )
  await sql.writeTileMeasurements(versionId, { x: tileX, y: 0 }, [
    { hash, correct, wrong, blank: 0 },
  ])
  return hash
}

describe.each(['memory', 'sqlite'] as const)('template lifetime progress through %s', (adapter) => {
  const fixture = async () => {
    vi.spyOn(Date, 'now').mockReturnValue((start + 600) * 1_000)
    const store = adapter === 'sqlite' ? await openRelationalStore() : null
    if (store !== null) closers.push(store.close)
    const backend = await createTestBackend({
      sql: store?.sql ?? new MemorySqlStore(),
      openAccess: true,
    })
    await backend.sql.insertTemplateVersion(version(originalId, start, 10, [0, 1]))
    await observe(backend.sql, originalId, 0, start + 30, 3, 2)
    const firstHash = await observe(backend.sql, originalId, 1, start + 30, 4, 1)
    await backend.sql.insertTemplateVersion({
      ...version(updatedId, start + 180, 20, [1, 2]),
      createdAt: millis((start + 180) * 1_000 + 123),
    })
    // Even a later reclassification must not rewrite the counts recorded before replacement.
    await backend.sql.writeTileMeasurements(updatedId, { x: 1, y: 0 }, [
      { hash: firstHash, correct: 0, wrong: 10, blank: 0 },
    ])
    await observe(backend.sql, updatedId, 1, start + 210, 8, 2)
    await observe(backend.sql, updatedId, 2, start + 240, 9, 1)
    return backend
  }

  it('keeps prior artwork counts and totals, resets coverage after replacement, and follows moved tiles', async () => {
    const backend = await fixture()
    const response = await backend.app.fetch(
      authorized(`/v1/telemetry/progress/${templateId}?from=${start}&to=${start + 600}`),
    )
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      templateId,
      resolution: 0,
      samples: expect.arrayContaining([
        { at: start + 30, correct: 7, mismatched: 3, total: 10, revision: originalId },
        {
          at: start + 180,
          correct: null,
          mismatched: null,
          total: 20,
          revision: updatedId,
          boundary: true,
        },
        { at: start + 210, correct: null, mismatched: null, total: 20, revision: updatedId },
        { at: start + 240, correct: 17, mismatched: 3, total: 20, revision: updatedId },
      ]),
    })
  })

  it('keeps explicit version reads independent of the template lifetime', async () => {
    const backend = await fixture()
    const response = await backend.app.fetch(
      authorized(
        `/telemetry/progress/${templateId}?version=${updatedId}&from=${start}&to=${start + 600}`,
      ),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      versionId: updatedId,
      samples: expect.arrayContaining([
        { at: start + 30, correct: null, mismatched: null, total: 20 },
      ]),
    })
  })

  it('preserves observations on each side of a replacement when daily history is selected and folded', async () => {
    const day = Math.floor(start / 86_400) * 86_400
    const now = day + 40 * 86_400
    vi.spyOn(Date, 'now').mockReturnValue(now * 1_000)
    const store = adapter === 'sqlite' ? await openRelationalStore() : null
    if (store !== null) closers.push(store.close)
    const backend = await createTestBackend({ sql: store?.sql ?? new MemorySqlStore() })
    await backend.sql.insertTemplateVersion(version(originalId, day, 10, [0]))
    const hash = await observe(backend.sql, originalId, 0, day + 600, 5, 5)
    await backend.sql.insertTemplateVersion(version(updatedId, day + 1800, 10, [0]))
    await backend.sql.writeTileMeasurements(updatedId, { x: 0, y: 0 }, [
      { hash, correct: 1, wrong: 9, blank: 0 },
    ])
    const read = async () => {
      const response = await backend.app.fetch(
        authorized(`/telemetry/progress/${templateId}?from=${day}&to=${now}`),
      )
      expect(response.status).toBe(200)
      return response.json() as Promise<TemplateProgressHistoryResponse>
    }
    const assertHistory = (history: Awaited<ReturnType<typeof read>>) => {
      expect(history.resolution).toBe(86_400)
      expect(history.samples).toContainEqual(
        expect.objectContaining({ revision: originalId, correct: 5 }),
      )
      expect(
        history.samples.filter(
          (sample) => sample.revision === updatedId && sample.correct !== null,
        ),
      ).toEqual([])
    }
    assertHistory(await read())
    await backend.sql.foldTileHistory(3, { x: 0, y: 0 }, seconds(now))
    assertHistory(await read())
  })

  it('preserves the publication boundary for the complete history', async () => {
    const backend = await fixture()
    const response = await backend.app.fetch(
      new Request(
        `https://backend.test/v1/telemetry/progress/${templateId}?from=${start}&to=${start + 600}`,
      ),
    )
    expect(response.status).toBe(404)
    await backend.sql.setTemplatePublishedAt(
      templateId,
      millis(start * 1_000),
      millis(start * 1_000),
    )
    const published = await backend.app.fetch(
      new Request(
        `https://backend.test/v1/telemetry/progress/${templateId}?from=${start}&to=${start + 600}`,
      ),
    )
    expect(published.status).toBe(200)
    expect(await published.json()).toMatchObject({
      samples: expect.arrayContaining([expect.objectContaining({ at: start + 30, correct: 7 })]),
    })
  })
})
