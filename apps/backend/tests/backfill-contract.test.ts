import {
  type ArchiveSnapshot,
  decodeWplaceIndexedPng,
  encodeIndexedPng,
  millis,
  seconds,
  TILE_SIZE,
  type TileCoord,
  TRANSPARENT_INDEX,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../src/adapters/memory/memory-blob-store.js'
import { MemorySqlStore } from '../src/adapters/memory/memory-sql-store.js'
import { EralyonArchive, parseSnapshots } from '../src/backfill/eralyon.js'
import { TemplateBackfill } from '../src/backfill/import.js'
import type { ArchiveSource, BackfillStorage } from '../src/backfill/port.js'
import { archiveWeek } from './support/eralyon.js'

const templateId = '01890f3e-7b2c-7abc-8def-012345678901'
const versionId = '01890f3e-7b2c-7abc-8def-012345678902'
const chunkHash = 'a'.repeat(64)
const snapshot = { id: 1, at: 100 } satisfies ArchiveSnapshot

class MemoryBackfillStorage implements BackfillStorage {
  readonly alarms: number[] = []
  private readonly values = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }

  async list<T>(options: {
    prefix: string
    startAfter?: string
    limit?: number
  }): Promise<Map<string, T>> {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(options.prefix))
        .filter(([key]) => options.startAfter === undefined || key > options.startAfter)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .slice(0, options.limit)
        .map(([key, value]) => [key, value as T]),
    )
  }

  async delete(keys: string[]): Promise<number> {
    return keys.filter((key) => this.values.delete(key)).length
  }

  async getAlarm(): Promise<number | null> {
    return this.alarms.at(-1) ?? null
  }

  async setAlarm(at: number): Promise<void> {
    this.alarms.push(at)
  }

  async deleteAlarm(): Promise<void> {
    this.alarms.length = 0
  }
}

const createImporter = async (archive: ArchiveSource) => {
  const sql = new MemorySqlStore()
  const blobs = new MemoryBlobStore()
  await blobs.put('chunks', chunkHash, await encodeIndexedPng(1, 1, new Uint8Array([1])))
  await sql.insertTemplateVersion({
    templateId,
    versionId,
    surface: WORLD_TEMPLATE_SURFACE,
    season: 0,
    nodeId: null,
    name: 'Archive mural',
    createdWithToken: 'b'.repeat(64),
    createdByUserId: null,
    createdAt: millis(1),
    bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    totalPixels: 1,
    chunks: [{ tileX: 0, tileY: 0, hash: chunkHash }],
  })
  const storage = new MemoryBackfillStorage()
  return {
    importer: new TemplateBackfill(storage, sql, blobs, archive, () => 200_000),
    storage,
    sql,
    blobs,
  }
}

describe('template backfill contract', () => {
  it('reads the archive catalogue in chronological order without duplicate snapshots', () => {
    expect(
      parseSnapshots(
        "const WPLACE_VERSIONS = [{ version: '3' }, { version: '1' }, { version: '3' }]",
      ),
    ).toMatchObject([{ id: 1 }, { id: 3 }])
  })

  it('does not start archive work after cancellation', async () => {
    let reads = 0
    const { importer } = await createImporter({
      snapshots: async () => [snapshot],
      tile: async () => {
        reads++
        return new Uint8Array(1_000_000).fill(1)
      },
    })

    await importer.start(templateId, versionId, snapshot.id)
    await importer.cancel()
    await importer.step()

    expect(reads).toBe(0)
    expect(await importer.job()).toMatchObject({ status: 'cancelled', completed: 0 })
  })

  it('resumes persisted progress without fetching or crediting completed snapshots again', async () => {
    const reads: string[] = []
    const archive: ArchiveSource = {
      snapshots: async () => [snapshot, { id: 2, at: 150 }],
      tile: async (id, tile) => {
        reads.push(`${id}:${tile.x}/${tile.y}`)
        return new Uint8Array(1_000_000).fill(id)
      },
    }
    const { importer, storage, sql, blobs } = await createImporter(archive)
    const job = await importer.start(templateId, versionId, snapshot.id)
    await importer.step()
    expect(await importer.job()).toMatchObject({ status: 'running', completed: 1 })

    const resumed = new TemplateBackfill(storage, sql, blobs, archive, () => 200_000)
    for (let step = 1; step < job.total; step++) await resumed.step()
    await resumed.step()
    expect(reads).toHaveLength(job.total)
    expect(new Set(reads).size).toBe(job.total)
    expect(await resumed.job()).toMatchObject({
      status: 'completed',
      imported: job.total,
      failed: 0,
    })
    expect(await resumed.history(versionId)).toMatchObject({
      samples: [
        { snapshotId: 1, correct: 1, mismatched: 0, total: 1 },
        { snapshotId: 2, correct: 0, mismatched: 1, total: 1 },
      ],
    })
    const stored = await blobs.list('archives', { limit: 10 })
    expect(stored.keys).toHaveLength(2)
    const colours = await Promise.all(
      stored.keys.map(async (key) => {
        const bytes = await blobs.get('archives', key)
        if (bytes === null) throw new Error('archive bytes were lost')
        const decoded = await decodeWplaceIndexedPng(bytes)
        if (decoded === null) throw new Error('archive pixels could not be decoded')
        expect([decoded.width, decoded.height]).toEqual([1000, 1000])
        return decoded.indices[0]
      }),
    )
    expect(colours.sort()).toEqual([1, 2])
  })

  it('decodes each snapshot of a week from one download, forward and back', async () => {
    const UNCHANGED = 254
    const base = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(1)
    const diff = (index: number, colour: number) => {
      const pixels = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(UNCHANGED)
      pixels[index] = colour
      return pixels
    }
    const week = archiveWeek([
      [170, base],
      [172, diff(0, 5)],
      [175, diff(1, 0)],
    ])
    let downloads = 0
    const archive = new EralyonArchive(
      Object.assign(
        async () => {
          downloads++
          return new Response(week)
        },
        { preconnect: fetch.preconnect },
      ),
    )
    const tile = { x: 3, y: 4 }
    const read = async (id: number) => {
      const pixels = await archive.tile(id, tile)
      return pixels === null ? null : [pixels[0], pixels[1], pixels[2]]
    }
    // Archive colours are one above palette indices; zero is transparent.
    expect(await read(169)).toBeNull()
    expect(await read(170)).toEqual([0, 0, 0])
    expect(await read(173)).toEqual([4, 0, 0])
    expect(await read(175)).toEqual([4, TRANSPARENT_INDEX, 0])
    expect(await read(171)).toEqual([0, 0, 0])
    expect(await read(175)).toEqual([4, TRANSPARENT_INDEX, 0])
    expect(downloads).toBe(1)
  })

  it('downloads each tile of a week once, even for jobs larger than the decoded-week budget', async () => {
    const sql = new MemorySqlStore()
    // Over 50 tiles once the timelapse frame is added: more decoded weeks than the cache holds.
    await sql.insertTemplateVersion({
      templateId,
      versionId,
      surface: WORLD_TEMPLATE_SURFACE,
      season: 0,
      nodeId: null,
      name: 'Wide mural',
      createdWithToken: 'b'.repeat(64),
      createdByUserId: null,
      createdAt: millis(1),
      bbox: { minX: 100_000, minY: 100_000, maxX: 109_000, maxY: 104_000 },
      totalPixels: 36_000_000,
      chunks: [],
    })
    const week = archiveWeek([
      [170, new Uint8Array(TILE_SIZE * TILE_SIZE).fill(1)],
      [172, new Uint8Array(TILE_SIZE * TILE_SIZE).fill(254)],
    ])
    const downloads = new Map<string, number>()
    const archive = new EralyonArchive(
      Object.assign(
        async (input: string | URL | Request) => {
          const url = String(input)
          downloads.set(url, (downloads.get(url) ?? 0) + 1)
          return new Response(week)
        },
        { preconnect: fetch.preconnect },
      ),
    )
    const snapshots = [
      { id: 170, at: 1_000 },
      { id: 172, at: 2_000 },
    ]
    const importer = new TemplateBackfill(
      new MemoryBackfillStorage(),
      sql,
      new MemoryBlobStore(),
      { snapshots: async () => snapshots, tile: (id, tile) => archive.tile(id, tile) },
      () => 200_000_000,
    )
    const job = await importer.start(templateId, versionId, 170)
    expect(job.total / snapshots.length).toBeGreaterThan(50)
    for (let step = 0; step < job.total; step++) await importer.step()
    expect(await importer.job()).toMatchObject({ status: 'completed', imported: job.total })
    expect(downloads.size).toBe(job.total / snapshots.length)
    expect(Math.max(...downloads.values())).toBe(1)
  })

  it('keeps the samples of snapshots every tile has seen when a job stops part-way through a week', async () => {
    const archive: ArchiveSource = {
      snapshots: async () => [snapshot, { id: 2, at: 150 }],
      tile: async (id) => new Uint8Array(1_000_000).fill(id),
    }
    const { importer } = await createImporter(archive)
    const job = await importer.start(templateId, versionId, snapshot.id)
    // Both snapshots share a week, so the last step is the last tile's second snapshot.
    for (let step = 1; step < job.total; step++) await importer.step()
    await importer.cancel()
    expect((await importer.history(versionId)).samples).toMatchObject([
      { snapshotId: 1, correct: 1, mismatched: 0 },
    ])
  })

  it('finishes earlier snapshots on every tile when native history starts part-way through a week', async () => {
    const archive: ArchiveSource = {
      snapshots: async () => [snapshot, { id: 2, at: 150 }],
      tile: async (id) => new Uint8Array(1_000_000).fill(id),
    }
    const { importer, sql } = await createImporter(archive)
    const job = await importer.start(templateId, versionId, snapshot.id)
    await importer.step()
    // A reporter's delayed upload lands between the two snapshots.
    await sql.recordTileObservation(
      {
        season: 0,
        tile: { x: 0, y: 0 },
        hash: 'c'.repeat(64),
        observedAt: millis(150_000),
        reportedAt: seconds(150),
        reportedWithToken: 'd'.repeat(64),
        reportedByUserId: 42,
      },
      [],
      true,
    )
    for (let step = 1; step < job.total; step++) await importer.step()
    const done = await importer.job()
    expect(done).toMatchObject({ status: 'completed', to: snapshot.at })
    // Every step counted is imported, skipped or failed, skipped snapshots included.
    expect((done?.imported ?? 0) + (done?.skipped ?? 0) + (done?.failed ?? 0)).toBe(done?.total)
    expect((await importer.history(versionId)).samples).toMatchObject([
      { snapshotId: 1, correct: 1, mismatched: 0 },
    ])
  })

  it('finishes a job persisted with its plan inline, as before plans had their own key', async () => {
    const archive: ArchiveSource = {
      snapshots: async () => [snapshot, { id: 2, at: 150 }],
      tile: async (id) => new Uint8Array(1_000_000).fill(id),
    }
    const { importer, storage, sql, blobs } = await createImporter(archive)
    const job = await importer.start(templateId, versionId, snapshot.id)
    const plan = await storage.get<{ snapshots: unknown; tiles: unknown }>('plan')
    const progress = await storage.get<Record<string, unknown>>('job')
    await storage.delete(['plan'])
    await storage.put('job', { ...progress, snapshots: plan?.snapshots, tiles: plan?.tiles })

    const resumed = new TemplateBackfill(storage, sql, blobs, archive, () => 200_000)
    for (let step = 0; step < job.total; step++) await resumed.step()
    expect(await resumed.job()).toMatchObject({ status: 'completed', imported: job.total })
    expect((await resumed.history(versionId)).samples).toHaveLength(2)
    expect(await storage.get('job')).not.toHaveProperty('snapshots')
  })

  it('records an unavailable archive tile as incomplete instead of inventing progress', async () => {
    const { importer } = await createImporter({
      snapshots: async () => [snapshot],
      tile: async (_snapshotId: number, _tile: TileCoord) => null,
    })

    const job = await importer.start(templateId, versionId, snapshot.id)
    for (let step = 0; step < job.total; step += 1) await importer.step()

    expect(await importer.job()).toMatchObject({
      status: 'completed',
      skipped: job.total,
      failed: 0,
    })
    expect(await importer.history(versionId)).toMatchObject({
      samples: [{ snapshotId: snapshot.id, correct: null, mismatched: null }],
    })
  })
})

describe('folder backfill contract', () => {
  it('reads each archive tile once for a folder and stops each template at its own native history', async () => {
    const sql = new MemorySqlStore()
    const blobs = new MemoryBlobStore()
    const nodeId = '01890f3e-7b2c-7abc-8def-0123456789a0'
    await sql.insertNode({
      id: nodeId,
      surface: WORLD_TEMPLATE_SURFACE,
      season: 0,
      parentId: null,
      path: '/murals',
      name: 'Murals',
      description: null,
      createdAt: millis(1),
    })
    // Neighbouring one-pixel templates on adjacent tiles: archive colour 1 matches the first,
    // colour 2 the second.
    const templates = [
      { x: 0, colour: 1, suffix: '1' },
      { x: 1_000, colour: 2, suffix: '2' },
    ] as const
    for (const { x, colour, suffix } of templates) {
      const hash = suffix.repeat(64)
      await blobs.put('chunks', hash, await encodeIndexedPng(1, 1, new Uint8Array([colour])))
      await sql.insertTemplateVersion({
        templateId: `01890f3e-7b2c-7abc-8def-01234567890${suffix}`,
        versionId: `01890f3e-7b2c-7abc-8def-01234567891${suffix}`,
        surface: WORLD_TEMPLATE_SURFACE,
        season: 0,
        nodeId,
        name: `Mural ${suffix}`,
        createdWithToken: 'b'.repeat(64),
        createdByUserId: null,
        createdAt: millis(1),
        bbox: { minX: x, minY: 0, maxX: x + 1, maxY: 1 },
        totalPixels: 1,
        chunks: [{ tileX: x / TILE_SIZE, tileY: 0, hash }],
      })
    }
    // The first template's native history starts at the second snapshot.
    await sql.recordTileObservation(
      {
        season: 0,
        tile: { x: 0, y: 0 },
        hash: 'c'.repeat(64),
        observedAt: millis(150_000),
        reportedAt: seconds(150),
        reportedWithToken: 'd'.repeat(64),
        reportedByUserId: 42,
      },
      [],
      true,
    )
    const reads: string[] = []
    const archive: ArchiveSource = {
      snapshots: async () => [snapshot, { id: 2, at: 150 }],
      tile: async (id, tile) => {
        reads.push(`${id}:${tile.x}/${tile.y}`)
        return new Uint8Array(1_000_000).fill(id)
      },
    }
    // Every import object is real; a folder's reaches each template's through its sink.
    const objects = new Map<string, TemplateBackfill>()
    const object = (name: string): TemplateBackfill => {
      const existing = objects.get(name)
      if (existing !== undefined) return existing
      const created = new TemplateBackfill(
        new MemoryBackfillStorage(),
        sql,
        blobs,
        archive,
        () => 200_000,
        (id) => ({
          get: (key) => object(id).readState(key),
          put: (entries) => object(id).importState(entries),
        }),
      )
      objects.set(name, created)
      return created
    }
    const folder = object(`folder:${nodeId}`)

    const preview = await folder.previewFolder(nodeId)
    expect(preview.bases.map((basis) => basis.name).sort()).toEqual(['Mural 1', 'Mural 2'])
    const job = await folder.startFolder(
      nodeId,
      preview.bases.map((basis) => basis.versionId),
      snapshot.id,
    )
    for (let step = 0; step < job.total && (await folder.folderJob())?.status === 'running'; step++)
      await folder.step()

    const done = await folder.folderJob()
    expect(done).toMatchObject({ status: 'completed', failed: 0, to: 150 })
    expect((done?.imported ?? 0) + (done?.skipped ?? 0)).toBe(done?.total)
    expect(new Set(reads).size).toBe(reads.length)
    // The second snapshot reads only the tiles of the template still importing.
    expect(reads.filter((read) => read.startsWith('1:'))).toHaveLength(preview.tileCount)
    expect(reads.filter((read) => read.startsWith('2:')).length).toBeLessThan(preview.tileCount)
    const [first, second] = templates.map((template) =>
      object(`01890f3e-7b2c-7abc-8def-01234567890${template.suffix}`).history(
        `01890f3e-7b2c-7abc-8def-01234567891${template.suffix}`,
      ),
    )
    expect(await first).toMatchObject({
      basis: { name: 'Mural 1' },
      samples: [{ snapshotId: 1, correct: 1, mismatched: 0 }],
    })
    expect(await second).toMatchObject({
      basis: { name: 'Mural 2' },
      samples: [
        { snapshotId: 1, correct: 0, mismatched: 1 },
        { snapshotId: 2, correct: 1, mismatched: 0 },
      ],
    })
  })
})
