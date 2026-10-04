import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTableName, is } from 'drizzle-orm'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ArchiveClient,
  discardImport,
  exportToFile,
  finishExport,
  importFromFile,
} from '../src/archive/cli.js'
import { ARCHIVE_TABLES, chainLine, UNARCHIVED_TABLES } from '../src/archive/format.js'
import {
  ARCHIVE_GATE_CACHE_MILLISECONDS,
  ArchiveOperationActiveError,
} from '../src/archive/gate.js'
import * as schema from '../src/db/schema.js'
import {
  ARCHIVE_ADMIN,
  archiveClient,
  archiveData,
  backfillState,
  type Fetch,
  MemoryObjectStorage,
  openPortableServer,
  paint,
  runningImport,
  seedServer,
} from './support/archive.js'

type Server = Awaited<ReturnType<typeof openPortableServer>>
const cleanups: Array<() => Promise<void>> = []
// Real time keeps passing; tests jump ahead only to expire cached gate reads.
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true }))
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Every store rereads the gate, as the settle delay guarantees in production. */
const expireGateReads = () => vi.setSystemTime(Date.now() + ARCHIVE_GATE_CACHE_MILLISECONDS + 1)

const server = async (...args: Parameters<typeof openPortableServer>) => {
  const opened = await openPortableServer(...args)
  cleanups.push(opened.close)
  return opened
}
const scratch = async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'caelestis-archive-file-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return (name: string) => join(directory, name)
}
const admin = (target: Server, path: string, init: RequestInit = {}) =>
  target.fetch(`${target.api}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${ARCHIVE_ADMIN}`, ...init.headers },
  })

const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error

/** Export `source` into a file; writes stay paused afterwards, as after a real migration. */
const exportServer = async (source: Server, file: string) => {
  await exportToFile(archiveClient(source.fetch, source.api), file)
  return readFile(file, 'utf8')
}

// Each case opens two or three complete servers.
describe('server archives', { timeout: 60_000 }, () => {
  it('lists every table either in restore order or as deliberately excluded', () => {
    const tables = Object.values(schema)
      .filter((value) => is(value, SQLiteTable))
      .map((table) => getTableName(table))
    const archived = ARCHIVE_TABLES.map((table) => table.name)
    expect([...archived, ...UNARCHIVED_TABLES].sort()).toEqual([...tables].sort())
    for (const [index, table] of ARCHIVE_TABLES.entries())
      for (const reference of getTableConfig(table.table).foreignKeys) {
        const { columns, foreignTable } = reference.reference()
        const target = archived.indexOf(getTableName(foreignTable))
        const deferred = columns.some((column) => table.deferred.includes(column.name))
        expect(target < index || deferred, `${table.name} → ${getTableName(foreignTable)}`).toBe(
          true,
        )
      }
  })

  it('restores a complete server into a new one with its revisions, counters, and imports', async () => {
    const file = await scratch()
    const source = await server()
    const seeded = await seedServer(source.fetch, source.api)
    await backfillState(source, seeded.templateId).put('job', runningImport(seeded.templateId))
    await backfillState(source, seeded.templateId).put('sample:v:1', { at: 1, correct: 2 })
    const manifest = await (await admin(source, '/manifest')).json()
    const pending = await source.runtime.counters.readPending([seeded.templateId])

    const archive = await exportServer(source, file('source.ndjson'))
    const destination = await server()
    await importFromFile(archiveClient(destination.fetch, destination.api), file('source.ndjson'))

    expect(await (await admin(destination, '/manifest')).json()).toEqual(manifest)
    expect(await destination.runtime.counters.readPending([seeded.templateId])).toEqual(pending)
    const restored = backfillState(destination, seeded.templateId)
    expect(await restored.get('job')).toEqual(runningImport(seeded.templateId))
    expect(await restored.get('sample:v:1')).toEqual({ at: 1, correct: 2 })
    // The running import wakes on the destination; it waits out the restore and then resumes.
    expect(await restored.getAlarm()).toBeLessThanOrEqual(Date.now() + 60_000)
    // The source's report credential still works, and the event it already reported stays applied.
    expect(
      await paint(destination.fetch, destination.api, seeded.reportToken, seeded.event),
    ).toEqual({ accepted: false, duplicate: true })

    await finishExport(archiveClient(source.fetch, source.api))
    const again = await exportServer(destination, file('destination.ndjson'))
    expect(archiveData(again)).toEqual(archiveData(archive))
    for (const kind of ['row', 'counter', 'backfill', 'object', 'link'])
      expect(archive, kind).toContain(`"kind":"${kind}"`)
  })

  it('freezes every writer during an export and hides a restore until it activates', async () => {
    const file = await scratch()
    const source = await server()
    const seeded = await seedServer(source.fetch, source.api)
    expect((await admin(source, '/admin/archive/export', { method: 'POST' })).status).toBe(201)
    expireGateReads()
    const late = { ...seeded.event, eventId: '01890f3e-7b2c-7abc-8def-0000000000ff' }
    const refused = await source.fetch(`${source.api}/telemetry/paints`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${seeded.reportToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(late),
    })
    expect(refused.status).toBe(503)
    expect(refused.headers.get('retry-after')).toBe('60')
    expect((await admin(source, '/manifest')).status).toBe(503)
    expect((await source.fetch(`${source.api}/server`)).status).toBe(200)
    // Writers outside HTTP, such as alarms and live sockets, meet the same fence in the store.
    await expect(
      source.runtime.sql.writeServerSettings({ name: 'Too late' }),
    ).rejects.toMatchObject({ cause: expect.any(ArchiveOperationActiveError) })

    const archive = await (async () => {
      let cursor: string | null = null
      let text = ''
      do {
        const page = await admin(
          source,
          `/admin/archive/export${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
        )
        text += await page.text()
        cursor = page.headers.get('caelestis-archive-next')
      } while (cursor !== null)
      return text
    })()
    await writeFile(file('frozen.ndjson'), archive)
    expect(archive).not.toContain(late.eventId)

    const destination = await server()
    const [header = ''] = archive.split('\n')
    expect(
      (await admin(destination, '/admin/archive/import', { method: 'POST', body: header })).status,
    ).toBe(201)
    expireGateReads()
    expect((await admin(destination, '/manifest')).status).toBe(503)
    await importFromFile(archiveClient(destination.fetch, destination.api), file('frozen.ndjson'))
    expireGateReads()
    expect((await admin(destination, '/manifest')).status).toBe(200)
    // The refused event was never accepted, so the destination accepts it exactly once.
    expect(await paint(destination.fetch, destination.api, seeded.reportToken, late)).toMatchObject(
      {
        accepted: true,
      },
    )
    expect(await paint(destination.fetch, destination.api, seeded.reportToken, late)).toMatchObject(
      {
        duplicate: true,
      },
    )
  })

  it('resumes an interrupted export and import without repeating or losing a record', async () => {
    const file = await scratch()
    const source = await server({ objects: new MemoryObjectStorage() })
    await seedServer(source.fetch, source.api)
    // More records than one export page or one restore request holds.
    for (let index = 0; index < 620; index += 1)
      await source.runtime.objects.put(
        `derived/${String(index).padStart(4, '0')}`,
        new Uint8Array([index % 256]),
      )

    // The connection drops for good after the first page.
    const dying: Fetch = async (input, init) => {
      if (input.includes('/admin/archive/export?cursor')) throw new Error('offline')
      return source.fetch(input, init)
    }
    await expect(exportToFile(archiveClient(dying, source.api), file('a.ndjson'))).rejects.toThrow(
      'offline',
    )
    const resumed = await exportServer(source, file('a.ndjson'))
    const pages: string[] = []
    let cursor: string | null = null
    do {
      const page = await admin(
        source,
        `/admin/archive/export${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
      )
      const text = await page.text()
      expect(text.split('\n').filter(Boolean).length).toBeLessThanOrEqual(500)
      pages.push(text)
      cursor = page.headers.get('caelestis-archive-next')
    } while (cursor !== null)
    expect(pages.length).toBeGreaterThan(1)
    expect(resumed).toBe(pages.join(''))

    const destination = await server({ objects: new MemoryObjectStorage() })
    let mode: 'crash' | 'lose-reply' = 'crash'
    let posts = 0
    const flaky: Fetch = async (input, init) => {
      if (!input.includes('/import/records')) return destination.fetch(input, init)
      posts += 1
      // The client stops for good after its first batch.
      if (mode === 'crash' && posts >= 2) throw new Error('crashed')
      const response = await destination.fetch(input, init)
      // On the rerun the next batch commits but its reply is lost; the retry must not repeat it.
      if (mode === 'lose-reply' && posts === 1) throw new Error('reply lost')
      return response
    }
    const client = archiveClient(flaky, destination.api)
    await expect(importFromFile(client, file('a.ndjson'))).rejects.toThrow('crashed')
    mode = 'lose-reply'
    posts = 0
    await importFromFile(client, file('a.ndjson'))
    await finishExport(archiveClient(source.fetch, source.api))
    expect(archiveData(await exportServer(destination, file('b.ndjson')))).toEqual(
      archiveData(resumed),
    )
  })

  it('refuses corrupt, incomplete, unsupported, and incompatible archives before activation', async () => {
    const file = await scratch()
    const source = await server()
    const seeded = await seedServer(source.fetch, source.api)
    const archive = await exportServer(source, file('source.ndjson'))
    const lines = archive.trimEnd().split('\n')
    const destination = await server()
    const begin = (header: string) =>
      admin(destination, '/admin/archive/import', { method: 'POST', body: header })
    const header = JSON.parse(lines[0] ?? '{}')

    const newer = await begin(JSON.stringify({ ...header, version: 2 }))
    expect(newer.status).toBe(422)
    expect(await errorOf(newer)).toContain('Upgrade the destination server')
    const unknownColumn = await begin(
      JSON.stringify({ ...header, tables: { ...header.tables, tags: ['id', 'name', 'colour'] } }),
    )
    expect(await errorOf(unknownColumn)).toContain('tags columns colour')
    const missingColumn = await begin(
      JSON.stringify({ ...header, tables: { ...header.tables, tags: ['id'] } }),
    )
    expect(await errorOf(missingColumn)).toContain('required tags columns name')

    // One edited character in a row: every record parses, but the chain breaks at the end.
    const edited = lines.map((line) => line.replace('"Archived mural"', '"Archived murals"'))
    await writeFile(file('edited.ndjson'), `${edited.join('\n')}\n`)
    await expect(
      importFromFile(archiveClient(destination.fetch, destination.api), file('edited.ndjson')),
    ).rejects.toThrow('checksum chain breaks')
    const incomplete = await admin(destination, '/admin/archive/import/activate', {
      method: 'POST',
    })
    expect(incomplete.status).toBe(409)
    expect(await errorOf(incomplete)).toContain('archive is incomplete')
    expireGateReads()
    expect((await admin(destination, '/manifest')).status).toBe(503)

    await discardImport(archiveClient(destination.fetch, destination.api))
    expect(await (await admin(destination, '/admin/archive')).json()).toEqual({ operation: null })
    expireGateReads()
    expect(await (await admin(destination, '/manifest')).json()).toMatchObject({ templates: [] })
    // The destination's own credentials survive the discard; the archive's do not.
    const manifestWith = async (token: string) =>
      (
        await destination.fetch(`${destination.api}/manifest`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status
    expect(await manifestWith(destination.runtime.readToken)).toBe(200)
    expect(await manifestWith(seeded.reportToken)).toBe(401)

    // A truncated archive never activates; a bit-flipped object is refused on arrival.
    await writeFile(file('truncated.ndjson'), `${lines.slice(0, -1).join('\n')}\n`)
    await expect(
      importFromFile(archiveClient(destination.fetch, destination.api), file('truncated.ndjson')),
    ).rejects.toThrow('no end record yet')
    await discardImport(archiveClient(destination.fetch, destination.api))
    const object = lines.findIndex((line) => line.startsWith('{"kind":"object"'))
    const flipped = lines.map((line, index) =>
      index === object
        ? line.replace(/"data":"(.)/, (_, first) => `"data":"${first === 'A' ? 'B' : 'A'}`)
        : line,
    )
    await writeFile(file('flipped.ndjson'), `${flipped.join('\n')}\n`)
    await expect(
      importFromFile(archiveClient(destination.fetch, destination.api), file('flipped.ndjson')),
    ).rejects.toThrow('does not match its SHA-256')
    await discardImport(archiveClient(destination.fetch, destination.api))
    expect(await chainLine('0'.repeat(64), 'x')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses to merge into a server that already has data', async () => {
    const file = await scratch()
    const source = await server()
    await seedServer(source.fetch, source.api)
    const archive = await exportServer(source, file('source.ndjson'))
    const destination = await server()
    await seedServer(destination.fetch, destination.api)
    const refused = await admin(destination, '/admin/archive/import', {
      method: 'POST',
      body: archive.split('\n')[0] ?? '',
    })
    expect(refused.status).toBe(409)
    expect(await errorOf(refused)).toMatch(
      /^Restore into a new server\. This one already has data in .*templates/,
    )
    // The refusal reopens the destination untouched.
    expect(await (await admin(destination, '/admin/archive')).json()).toEqual({ operation: null })
    const tag = await admin(destination, '/admin/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'still-writable' }),
    })
    expect(tag.status).toBe(201)
  })

  it('checks emptiness only after the gate closes, so no write slips in during a restore start', async () => {
    const file = await scratch()
    const source = await server()
    const archive = await exportServer(source, file('empty.ndjson'))
    const objects = new HeldProbe()
    const destination = await server({ objects })
    const begin = admin(destination, '/admin/archive/import', {
      method: 'POST',
      body: archive.split('\n')[0] ?? '',
    })
    await objects.probing
    const tag = await admin(destination, '/admin/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'raced' }),
    })
    expect(tag.status).toBe(503)
    objects.release()
    expect((await begin).status).toBe(201)
    await discardImport(archiveClient(destination.fetch, destination.api))
    expireGateReads()
    expect(await (await admin(destination, '/admin/tags')).json()).toMatchObject({ tags: [] })
  })

  it('refuses activation once a discard has started deleting the restore', async () => {
    const file = await scratch()
    const source = await server()
    await seedServer(source.fetch, source.api)
    const lines = (await exportServer(source, file('source.ndjson'))).trimEnd().split('\n')
    const destination = await server()
    await admin(destination, '/admin/archive/import', { method: 'POST', body: lines[0] ?? '' })
    const restored = await admin(destination, '/admin/archive/import/records?position=1', {
      method: 'POST',
      body: lines.slice(1).join('\n'),
    })
    expect(await restored.json()).toMatchObject({ ended: true })
    for (let step = 0; step < 4; step += 1)
      expect(
        await (await admin(destination, '/admin/archive/import', { method: 'DELETE' })).json(),
      ).toEqual({ done: false })
    const activate = await admin(destination, '/admin/archive/import/activate', { method: 'POST' })
    expect(activate.status).toBe(409)
    expect(await errorOf(activate)).toContain('being discarded')
    await discardImport(archiveClient(destination.fetch, destination.api))
    expireGateReads()
    expect(await (await admin(destination, '/manifest')).json()).toMatchObject({ templates: [] })
  })

  it('resumes a preparation a crash left behind, or cancels it without touching the destination', async () => {
    const file = await scratch()
    const source = await server()
    await seedServer(source.fetch, source.api)
    const archive = await exportServer(source, file('source.ndjson'))
    const [headerLine = ''] = archive.split('\n')
    const header = JSON.parse(headerLine)
    // The row a restore leaves when its process dies before the destination checks finish.
    const crashedPreparation = async (destination: Server) =>
      destination.runtime.connection
        .prepare(
          'INSERT INTO "archive_operation" ("id", "kind", "operation_id", "started_at_ms", "position", "state_json") VALUES (1, \'import\', \'crashed\', 0, 1, ?)',
        )
        .bind(
          JSON.stringify({
            archiveId: header.id,
            sourceServerId: header.source.serverId,
            tables: header.tables,
            chain: await chainLine('0'.repeat(64), headerLine),
            counts: {},
            ended: false,
            phase: 'preparing',
            preservedTokens: [],
          }),
        )
        .run()

    const resumed = await server()
    await crashedPreparation(resumed)
    expect(
      await importFromFile(archiveClient(resumed.fetch, resumed.api), file('source.ndjson')),
    ).toMatchObject({ sourceServerId: header.source.serverId })

    const cancelled = await server()
    await crashedPreparation(cancelled)
    await discardImport(archiveClient(cancelled.fetch, cancelled.api))
    expireGateReads()
    // Nothing was restored, so cancelling deletes nothing, the destination's own token included.
    const manifest = await cancelled.fetch(`${cancelled.api}/manifest`, {
      headers: { authorization: `Bearer ${cancelled.runtime.readToken}` },
    })
    expect(manifest.status).toBe(200)
  })

  it('refuses a cancellation racing preparation, then honours the retry', async () => {
    const file = await scratch()
    const source = await server()
    const archive = await exportServer(source, file('empty.ndjson'))
    const objects = new HeldProbe()
    const destination = await server({ objects })
    const begin = admin(destination, '/admin/archive/import', {
      method: 'POST',
      body: archive.split('\n')[0] ?? '',
    })
    await objects.probing
    const cancelled = await admin(destination, '/admin/archive/import', { method: 'DELETE' })
    expect(cancelled.status).toBe(409)
    expect(await errorOf(cancelled)).toContain('archive request is running')
    objects.release()
    expect((await begin).status).toBe(201)
    for (;;) {
      const cancelling = (await (
        await admin(destination, '/admin/archive/import', { method: 'DELETE' })
      ).json()) as { done?: boolean }
      if (cancelling.done === true) break
    }
    expect(await (await admin(destination, '/admin/archive')).json()).toEqual({ operation: null })
  })

  it('serializes overlapping preparations on the archive lease', async () => {
    const file = await scratch()
    const source = await server()
    const archive = await exportServer(source, file('empty.ndjson'))
    const objects = new HeldProbe()
    const destination = await server({ objects })
    const header = archive.split('\n')[0] ?? ''
    const first = admin(destination, '/admin/archive/import', { method: 'POST', body: header })
    await objects.probing
    // The retry arrives while the first still holds the lease, so it is refused, not run.
    const retry = await admin(destination, '/admin/archive/import', {
      method: 'POST',
      body: header,
    })
    expect(retry.status).toBe(409)
    expect(await errorOf(retry)).toContain('archive request is running')
    objects.release()
    expect((await first).status).toBe(201)
    // Once the lease frees, the same request takes over and reports the running import.
    const resumed = await admin(destination, '/admin/archive/import', {
      method: 'POST',
      body: header,
    })
    expect(resumed.status).toBe(200)
    expect(await (await admin(destination, '/admin/archive')).json()).toMatchObject({
      operation: { phase: 'ready' },
    })
  })

  it('keeps a credential both servers already share', async () => {
    const file = await scratch()
    const shared = { env: { CAELESTIS_READ_TOKEN: 'SHARED-FRONTEND-READ-TOKEN' } }
    const source = await server(shared)
    await seedServer(source.fetch, source.api)
    await exportServer(source, file('source.ndjson'))
    const destination = await server(shared)
    await importFromFile(archiveClient(destination.fetch, destination.api), file('source.ndjson'))
    const manifest = await destination.fetch(`${destination.api}/manifest`, {
      headers: { authorization: 'Bearer SHARED-FRONTEND-READ-TOKEN' },
    })
    expect(manifest.status).toBe(200)
  })
})

/** Holds the restore's object-store probe until released, so a test can race it. */
class HeldProbe extends MemoryObjectStorage {
  private entered: () => void = () => {}
  readonly probing = new Promise<void>((resolve) => {
    this.entered = resolve
  })
  release: () => void = () => {}
  private readonly held = new Promise<void>((resolve) => {
    this.release = resolve
  })
  override async put(...args: Parameters<MemoryObjectStorage['put']>) {
    if (args[0].startsWith('archive-probe/')) {
      this.entered()
      await this.held
    }
    return super.put(...args)
  }
}

describe('archive client retries', () => {
  const busy = () =>
    ({
      status: 409,
      clone: () => ({
        text: async () =>
          JSON.stringify({ error: 'Another archive request is running. Retry shortly.' }),
      }),
      text: async () =>
        JSON.stringify({ error: 'Another archive request is running. Retry shortly.' }),
    }) as unknown as Response
  const failure = () => ({ status: 503, text: async () => 'unavailable' }) as unknown as Response
  const done = () =>
    ({ status: 200, text: async () => JSON.stringify({ done: true }) }) as unknown as Response

  it('keeps the failure retry cap reachable after lease-busy replies', async () => {
    let sends = 0
    const client: ArchiveClient = {
      api: 'https://example.test/v1',
      token: 'token',
      wait: async () => {},
      fetch: async () => {
        sends += 1
        if (sends <= 5) return busy()
        if (sends <= 15) return failure()
        return done()
      },
    }
    await expect(discardImport(client)).rejects.toThrow('503')
    // Five lease-busy replies, then the five allowed gateway failures — never more.
    expect(sends).toBe(10)
  })
})
