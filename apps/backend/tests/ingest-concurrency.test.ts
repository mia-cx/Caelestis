import {
  encodeIndexedPng,
  millis,
  seconds,
  sha256Hex,
  TRANSPARENT_INDEX,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { expect, it } from 'vitest'
import { MemoryBlobStore } from '../src/adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../src/adapters/memory/memory-counter-store.js'
import { RelationalSqlStore } from '../src/adapters/relational-sql-store.js'
import { createBackendRuntime, makeBackendContext } from '../src/runtime/backend-runtime.js'
import { offerTilesWithOutcome, type TileMetadata, uploadTile } from '../src/telemetry/ingest.js'
import { openRelationalStore } from './support/relational.js'

const seed = async (sql: RelationalSqlStore, blobs: MemoryBlobStore) => {
  const at = Math.floor(Date.now() / 1000) - 10
  const chunk = await encodeIndexedPng(2, 1, new Uint8Array([1, 1]))
  const chunkHash = await sha256Hex(chunk)
  await blobs.put('chunks', chunkHash, chunk)
  await sql.insertTemplateVersion({
    templateId: uuidV7(),
    versionId: uuidV7(),
    surface: WORLD_TEMPLATE_SURFACE,
    season: 3,
    nodeId: null,
    name: 'Concurrent ingest',
    createdWithToken: 'a'.repeat(64),
    createdByUserId: null,
    createdAt: millis(at * 1000),
    bbox: { minX: 0, minY: 0, maxX: 5002, maxY: 1 },
    totalPixels: 12,
    chunks: Array.from({ length: 6 }, (_, x) => ({ tileX: x, tileY: 0, hash: chunkHash })),
  })
  const pixels = new Uint8Array(1_000_000).fill(TRANSPARENT_INDEX)
  pixels.set([1, 2])
  const bytes = await encodeIndexedPng(1000, 1000, pixels)
  const hash = await sha256Hex(bytes)
  const metadata = (reporter: number, x = 0): TileMetadata => ({
    season: 3,
    tile: { x, y: 0 },
    hash,
    observedAt: seconds(at + reporter),
    includeUnpublished: true,
    tokenHash: String(reporter).padStart(64, '0'),
    wplaceUserId: reporter,
    displayName: `Reporter ${reporter}`,
  })
  const history = (x = 0) =>
    sql.readTileHistory({
      season: 3,
      tile: { x, y: 0 },
      resolution: 0,
      fromSeconds: seconds(at),
      toSeconds: seconds(at + 10),
    })
  return { bytes, hash, metadata, history }
}

it.each(['before-put', 'before-commit'])(
  'shares uploaded bytes between reporters overlapping %s',
  async (phase) => {
    const opened = await openRelationalStore()
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const reserved = Promise.withResolvers<void>()
    let reservations = 0
    let commits = 0
    let tilePuts = 0
    class DelayedStore extends RelationalSqlStore {
      override async reserveTileBlobUpload(
        ...args: Parameters<RelationalSqlStore['reserveTileBlobUpload']>
      ) {
        const value = await super.reserveTileBlobUpload(...args)
        if (++reservations === 2) reserved.resolve()
        return value
      }
      override async readTileBlob(...args: Parameters<RelationalSqlStore['readTileBlob']>) {
        if (phase === 'before-put') {
          entered.resolve()
          await gate.promise
        }
        return super.readTileBlob(...args)
      }
      override async commitTileBlobReservation(
        ...args: Parameters<RelationalSqlStore['commitTileBlobReservation']>
      ) {
        if (phase === 'before-commit' && ++commits === 1) {
          entered.resolve()
          await gate.promise
        }
        return super.commitTileBlobReservation(...args)
      }
    }
    class CountingObjects extends MemoryBlobStore {
      override async put(...args: Parameters<MemoryBlobStore['put']>) {
        if (args[0] === 'tiles') tilePuts++
        return super.put(...args)
      }
    }
    const pending: Promise<unknown>[] = []
    try {
      const sql = new DelayedStore(opened.connection)
      const blobs = new CountingObjects()
      const { bytes, metadata, history } = await seed(sql, blobs)
      const runtime = createBackendRuntime(
        makeBackendContext(blobs, sql, new MemoryCounterStore(sql)),
      )
      pending.push(runtime.run(uploadTile(metadata(1), bytes)))
      await entered.promise
      pending.push(runtime.run(uploadTile(metadata(2), bytes)))
      await reserved.promise
      if (phase === 'before-commit') await pending[1]
      gate.resolve()
      await Promise.all(pending)
      expect(tilePuts).toBe(1)
      expect(await history()).toHaveLength(2)
    } finally {
      gate.resolve()
      await Promise.allSettled(pending)
      await opened.close()
    }
  },
)

it('settles started offers before reporting batch failure and never starts queued offers', async () => {
  const opened = await openRelationalStore()
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const started = new Set<number>()
  let delaying = false
  class FailingTargets extends RelationalSqlStore {
    override async listTelemetryTargets(
      ...args: Parameters<RelationalSqlStore['listTelemetryTargets']>
    ) {
      if (delaying) {
        const x = args[1].x
        started.add(x)
        if (started.size === 4) entered.resolve()
        if (x === 0) throw new Error('targets unavailable')
        await gate.promise
      }
      return super.listTelemetryTargets(...args)
    }
  }
  let batch: Promise<unknown> | undefined
  try {
    const sql = new FailingTargets(opened.connection)
    const blobs = new MemoryBlobStore()
    const { bytes, metadata, history } = await seed(sql, blobs)
    const runtime = createBackendRuntime(
      makeBackendContext(blobs, sql, new MemoryCounterStore(sql)),
    )
    await runtime.run(uploadTile(metadata(1), bytes))
    // Keep the offered hash stored but no longer current, so tile 0 must enter ingestion.
    const newerPixels = new Uint8Array(1_000_000).fill(TRANSPARENT_INDEX)
    newerPixels.set([2, 2])
    const newer = await encodeIndexedPng(1000, 1000, newerPixels)
    await runtime.run(uploadTile({ ...metadata(2), hash: await sha256Hex(newer) }, newer))
    delaying = true
    let settled = false
    batch = runtime
      .run(
        offerTilesWithOutcome(
          Array.from({ length: 6 }, (_, x) => ({
            key: `${x}/0`,
            metadata: metadata(3, x),
          })),
        ),
      )
      .then(
        () => {
          throw new Error('Expected failed batch')
        },
        async (error: unknown) => {
          settled = true
          // The batch cannot return failure until every started observation has committed.
          for (const x of [1, 2, 3]) expect(await history(x)).toHaveLength(1)
          return error
        },
      )
    await entered.promise
    expect(settled).toBe(false)
    gate.resolve()
    expect(await batch).toMatchObject({ operation: 'offerTile' })
    expect([...started].sort()).toEqual([0, 1, 2, 3])
    for (const x of [4, 5]) expect(await history(x)).toEqual([])
  } finally {
    gate.resolve()
    await Promise.allSettled(batch ? [batch] : [])
    await opened.close()
  }
})
