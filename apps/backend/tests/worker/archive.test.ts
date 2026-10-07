import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { exportToFile, finishExport, importFromFile } from '../../src/archive/cli.js'
import {
  ARCHIVE_ADMIN,
  archiveClient,
  archiveData,
  backfillState,
  type Fetch,
  openPortableServer,
  paint,
  runningImport,
  seedServer,
} from '../support/archive.js'

const here = dirname(fileURLToPath(import.meta.url))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

let worker = ''
beforeAll(async () => {
  const bundled = await build({
    entryPoints: [join(here, '../../src/worker.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'import'],
    mainFields: ['module', 'main'],
    external: ['cloudflare:workers', 'node:*'],
    define: {
      __CAELESTIS_DEPLOYMENT_VERSION__: '"test"',
      __CAELESTIS_BACKEND_VERSION__: '"test"',
      __CAELESTIS_USERSCRIPT_VERSIONS__: '[]',
    },
    write: false,
  })
  worker = bundled.outputFiles[0]?.text ?? ''
}, 60_000)

const NO_BODY = new Set([101, 204, 205, 304])

/** The production Worker with real local D1, R2, and Durable Objects. */
const openCloudflare = async () => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: worker,
      compatibilityDate: '2026-08-03',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      r2Buckets: ['BLOBS'],
      durableObjects: {
        TELEMETRY: { className: 'TelemetryShard', useSQLite: true },
        ALARM_WATCHER: { className: 'AlarmWatcher', useSQLite: true },
        STATUS_READ_MODEL: { className: 'StatusReadModelObject', useSQLite: true },
        TEMPLATE_BACKFILL: { className: 'TemplateBackfillObject', useSQLite: true },
        PRESENCE: { className: 'PresenceObject', useSQLite: true },
      },
      bindings: {
        SHARD_STRATEGY: 'single',
        SERVER_ID: '01890f3e-7b2c-7abc-8def-0000000000aa',
        SERVER_NAME: 'Caelestis',
        SEASON: '0',
        ADMIN_TOKEN: ARCHIVE_ADMIN,
        ARCHIVE_SETTLE_SECONDS: '0',
      },
    }),
  )
  cleanups.push(() => runtime.dispose())
  const database = await runtime.getD1Database('DB')
  const migrations = join(here, '../../migrations')
  for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort())
    for (const statement of (await readFile(join(migrations, file), 'utf8')).split(
      '--> statement-breakpoint',
    ))
      if (statement.trim()) await database.prepare(statement).run()
  const fetch: Fetch = async (input, init) => {
    // Miniflare bundles its own undici, which cannot read Node's FormData. Serialize first.
    const request = new Request(input, init)
    const response = await runtime.dispatchFetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      ...(request.body === null ? {} : { body: new Uint8Array(await request.arrayBuffer()) }),
    })
    return new Response(NO_BODY.has(response.status) ? null : await response.arrayBuffer(), {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    })
  }
  return { fetch, api: 'https://cloudflare.test/v1' }
}

const portable = async () => {
  const server = await openPortableServer()
  cleanups.push(server.close)
  return server
}

describe('Cloudflare server archives', { timeout: 120_000 }, () => {
  it('moves a Cloudflare server to a portable one and back without losing or repeating data', async () => {
    const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'caelestis-cf-archive-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const file = (name: string) => join(directory, name)

    const cloudflare = await openCloudflare()
    const seeded = await seedServer(cloudflare.fetch, cloudflare.api)
    await exportToFile(archiveClient(cloudflare.fetch, cloudflare.api), file('cloudflare.ndjson'))
    const original = await readFile(file('cloudflare.ndjson'), 'utf8')
    for (const kind of ['row', 'link', 'counter', 'object'])
      expect(original, kind).toContain(`"kind":"${kind}"`)

    // Cloudflare → portable: D1, R2, and Durable Object state into SQLite and a filesystem.
    const node = await portable()
    await importFromFile(archiveClient(node.fetch, node.api), file('cloudflare.ndjson'))
    expect(await paint(node.fetch, node.api, seeded.reportToken, seeded.event)).toEqual({
      accepted: false,
      duplicate: true,
    })
    // A resumable import in progress, so the trip back exercises the import Durable Object.
    const imports = backfillState(node, seeded.templateId)
    await imports.put('job', runningImport(seeded.templateId))
    await imports.put('sample:v:1', { at: 1, correct: 2 })
    await exportToFile(archiveClient(node.fetch, node.api), file('portable.ndjson'))
    const moved = archiveData(await readFile(file('portable.ndjson'), 'utf8'))
    expect(moved.filter((line) => !line.startsWith('{"kind":"backfill'))).toEqual(
      archiveData(original),
    )
    expect(moved.filter((line) => line.startsWith('{"kind":"backfill'))).toHaveLength(2)

    // Portable → Cloudflare, into a newly provisioned deployment with no access to the source.
    await finishExport(archiveClient(cloudflare.fetch, cloudflare.api))
    const restored = await openCloudflare()
    await importFromFile(archiveClient(restored.fetch, restored.api), file('portable.ndjson'))
    expect(await paint(restored.fetch, restored.api, seeded.reportToken, seeded.event)).toEqual({
      accepted: false,
      duplicate: true,
    })
    await exportToFile(archiveClient(restored.fetch, restored.api), file('restored.ndjson'))
    expect(archiveData(await readFile(file('restored.ndjson'), 'utf8'))).toEqual(moved)
  })
})
