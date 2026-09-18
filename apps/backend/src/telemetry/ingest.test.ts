import {
  encodeIndexedPng,
  millis,
  seconds,
  sha256Hex,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { D1SqlStore } from '../adapters/cloudflare/d1-sql-store.js'
import { SqliteD1Database } from '../adapters/cloudflare/sqlite-d1.test-helper.js'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import type { CounterStore } from '../ports/index.js'
import { createBackendRuntime, makeBackendContext } from '../runtime/backend-runtime.js'
import { type TileMetadata, uploadTile } from './ingest.js'

/**
 * The SQLite-backed D1 helper cannot interleave two transactions the way CNPG or D1 do, so the
 * runtime under test sees a store that runs one call at a time. Blob calls stay concurrent,
 * which is where the upload overlap under test happens.
 */
const serialized = <Store extends object>(store: Store): Store => {
  let tail: Promise<unknown> = Promise.resolve()
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const run = () => value.apply(target, args)
        const result = tail.then(run, run)
        tail = result.then(
          () => undefined,
          () => undefined,
        )
        return result
      }
    },
  })
}

const TILE = { x: 0, y: 0 }
// Recent, so the raw-resolution history rows survive the fold that follows every upload.
const AT = Math.floor(Date.now() / 1_000) - 10

describe('live tile uploads', () => {
  let database: SqliteD1Database
  let sql: D1SqlStore
  let blobs: MemoryBlobStore
  let runtime: ReturnType<typeof createBackendRuntime>

  beforeEach(async () => {
    database = new SqliteD1Database()
    sql = new D1SqlStore(database as unknown as D1Database)
    blobs = new MemoryBlobStore()
    runtime = createBackendRuntime(makeBackendContext(blobs, serialized(sql), {} as CounterStore))
    const chunk = await encodeIndexedPng(2, 1, new Uint8Array([0, 0]))
    const chunkHash = await sha256Hex(chunk)
    await blobs.put('chunks', chunkHash, chunk)
    const templateId = uuidV7()
    await sql.insertTemplateVersion({
      templateId,
      versionId: uuidV7(),
      surface: WORLD_TEMPLATE_SURFACE,
      season: 0,
      nodeId: null,
      name: 'Upload dedupe',
      createdWithToken: 'a'.repeat(64),
      createdByUserId: null,
      createdAt: millis(AT * 1_000),
      bbox: { minX: 0, minY: 0, maxX: 2, maxY: 1 },
      totalPixels: 2,
      chunks: [{ tileX: 0, tileY: 0, hash: chunkHash }],
    })
    await sql.setTemplatePublishedAt(templateId, millis(AT * 1_000), millis(AT * 1_000))
  })

  afterEach(() => database.close())

  const canvas = async () => {
    const pixels = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TRANSPARENT_INDEX)
    pixels[0] = 0
    const bytes = await encodeIndexedPng(TILE_SIZE, TILE_SIZE, pixels)
    return { bytes, hash: await sha256Hex(bytes) }
  }

  const metadata = (hash: string, reporter: number, at: number): TileMetadata => ({
    wplaceUserId: reporter,
    displayName: `Reporter ${reporter}`,
    tokenHash: String(reporter).padStart(64, '0'),
    season: 0,
    tile: TILE,
    hash,
    observedAt: seconds(at),
    includeUnpublished: false,
  })

  it('stores the bytes of one hash once while recording every reporter’s observation', async () => {
    const { bytes, hash } = await canvas()
    const put = vi.spyOn(blobs, 'put')

    await runtime.run(uploadTile(metadata(hash, 42, AT + 1), bytes))
    await runtime.run(uploadTile(metadata(hash, 43, AT + 2), bytes))
    await runtime.run(uploadTile(metadata(hash, 44, AT + 3), bytes))

    const tilePuts = put.mock.calls.filter(([namespace]) => namespace === 'tiles')
    expect(tilePuts).toHaveLength(1)
    expect(await sql.readTileBlob(hash)).toMatchObject({ state: 'active' })
    expect(await sql.readLatestTile(0, TILE)).toMatchObject({ hash })
    const frames = await sql.readTileHistory({
      season: 0,
      tile: TILE,
      resolution: 0,
      fromSeconds: seconds(AT),
      toSeconds: seconds(AT + 10),
    })
    // Raw resolution keeps exact timestamps: one frame per reporter, all for the same bytes.
    expect(frames.map((frame) => ({ hash: frame.hash, reporters: frame.reporters }))).toEqual([
      { hash, reporters: 1 },
      { hash, reporters: 1 },
      { hash, reporters: 1 },
    ])
  })

  it('shares one PUT between reporters whose uploads overlap before either commits', async () => {
    const { bytes, hash } = await canvas()
    const originalPut = blobs.put.bind(blobs)
    let releaseFirstPut = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseFirstPut = resolve
    })
    const put = vi.spyOn(blobs, 'put').mockImplementation(async (namespace, key, value) => {
      if (namespace === 'tiles') await gate
      await originalPut(namespace, key, value)
    })

    const first = runtime.run(uploadTile(metadata(hash, 42, AT + 1), bytes))
    const second = runtime.run(uploadTile(metadata(hash, 43, AT + 2), bytes))
    // Let both uploads reserve the same uploading generation and reach the blob store.
    await vi.waitFor(() =>
      expect(put.mock.calls.filter(([namespace]) => namespace === 'tiles')).toHaveLength(1),
    )
    releaseFirstPut()
    await Promise.all([first, second])

    expect(put.mock.calls.filter(([namespace]) => namespace === 'tiles')).toHaveLength(1)
    expect(await sql.readTileBlob(hash)).toMatchObject({ state: 'active' })
    const frames = await sql.readTileHistory({
      season: 0,
      tile: TILE,
      resolution: 0,
      fromSeconds: seconds(AT),
      toSeconds: seconds(AT + 10),
    })
    expect(frames).toHaveLength(2)
  })

  it('still uploads bytes that no active generation holds yet', async () => {
    const { bytes, hash } = await canvas()
    const put = vi.spyOn(blobs, 'put')

    await runtime.run(uploadTile(metadata(hash, 42, AT + 1), bytes))

    expect(put.mock.calls.filter(([namespace]) => namespace === 'tiles')).toHaveLength(1)
    expect(await blobs.get('tiles', (await sql.readTileBlob(hash))?.blobKey ?? '')).toEqual(bytes)
  })
})
