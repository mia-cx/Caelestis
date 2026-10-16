import {
  encodeIndexedPng,
  millis,
  seconds,
  sha256Hex,
  type TemplateProgressHistoryResponse,
  TILE_SIZE,
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

  it('keeps known tile coverage when an artwork update reuses previously observed canvas tiles', async () => {
    vi.spyOn(Date, 'now').mockReturnValue((start + 600) * 1_000)
    const store = adapter === 'sqlite' ? await openRelationalStore() : null
    if (store !== null) closers.push(store.close)
    const backend = await createTestBackend({ sql: store?.sql ?? new MemorySqlStore() })
    await backend.sql.insertTemplateVersion(version(originalId, start, 10, [0, 1]))
    const left = await observe(backend.sql, originalId, 0, start + 30, 3, 2)
    const right = await observe(backend.sql, originalId, 1, start + 30, 4, 1)
    await backend.sql.insertTemplateVersion(version(updatedId, start + 180, 20, [0, 1]))
    await backend.sql.writeTileMeasurements(updatedId, { x: 0, y: 0 }, [
      { hash: left, correct: 8, wrong: 2, blank: 0 },
    ])
    await backend.sql.writeTileMeasurements(updatedId, { x: 1, y: 0 }, [
      { hash: right, correct: 9, wrong: 1, blank: 0 },
    ])
    await observe(backend.sql, updatedId, 0, start + 210, 9, 1)

    const response = await backend.app.fetch(
      authorized(`/v1/telemetry/progress/${templateId}?from=${start}&to=${start + 600}`),
    )
    expect(response.status).toBe(200)
    const result = (await response.json()) as TemplateProgressHistoryResponse
    expect(result.samples).toContainEqual({
      at: start + 30,
      correct: 7,
      mismatched: 3,
      total: 10,
      revision: originalId,
    })
    expect(result.samples).toContainEqual({
      at: start + 180,
      correct: 17,
      mismatched: 3,
      total: 20,
      revision: updatedId,
      boundary: true,
    })
  })

  it.each([true, false])(
    'classifies uncached history only when its tile image is retained (%s)',
    async (retained) => {
      vi.spyOn(Date, 'now').mockReturnValue((start + 600) * 1_000)
      const store = adapter === 'sqlite' ? await openRelationalStore() : null
      if (store !== null) closers.push(store.close)
      const backend = await createTestBackend({ sql: store?.sql ?? new MemorySqlStore() })
      const canvas = await encodeIndexedPng(
        TILE_SIZE,
        TILE_SIZE,
        new Uint8Array(TILE_SIZE * TILE_SIZE).fill(retained ? 1 : 3),
      )
      const canvasHash = await sha256Hex(canvas)
      const chunk = await encodeIndexedPng(1, 1, new Uint8Array([2]))
      const chunkHash = await sha256Hex(chunk)
      if (retained) await backend.blobs.put('tiles', canvasHash, canvas)
      await backend.blobs.put('chunks', chunkHash, chunk)
      await backend.sql.insertTemplateVersion(version(originalId, start, 1, [0]))
      await backend.sql.recordTileObservation(
        {
          season: 3,
          tile: { x: 0, y: 0 },
          hash: canvasHash,
          observedAt: millis((start + 30) * 1_000),
          reportedAt: seconds(start + 30),
          reportedWithToken: tokenHash,
          reportedByUserId: 42,
        },
        [],
      )
      await backend.sql.writeTileMeasurements(originalId, { x: 0, y: 0 }, [
        { hash: canvasHash, correct: 1, wrong: 0, blank: 0 },
      ])
      await backend.sql.insertTemplateVersion({
        ...version(updatedId, start + 180, 1, [0]),
        chunks: [{ tileX: 0, tileY: 0, hash: chunkHash }],
      })
      const latest = await backend.sql.readLatestTile(3, { x: 0, y: 0 })
      const response = await backend.app.fetch(
        authorized(`/v1/telemetry/progress/${templateId}?from=${start}&to=${start + 600}`),
      )
      expect(response.status).toBe(200)
      expect(((await response.json()) as TemplateProgressHistoryResponse).samples).toContainEqual({
        at: start + 180,
        correct: retained ? 0 : null,
        mismatched: retained ? 1 : null,
        total: 1,
        revision: updatedId,
        boundary: true,
      })
      expect(
        await backend.sql.readTileMeasurements(updatedId, { x: 0, y: 0 }, [canvasHash]),
      ).toEqual(retained ? [{ hash: canvasHash, correct: 0, wrong: 1, blank: 0 }] : [])
      expect(await backend.sql.readLatestTile(3, { x: 0, y: 0 })).toEqual(latest)
    },
  )

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
      ).toEqual([
        {
          at: day + 1800,
          correct: 1,
          mismatched: 9,
          total: 10,
          revision: updatedId,
          boundary: true,
        },
      ])
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
