import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { discardImport, exportToFile, finishExport, importFromFile } from '../../src/archive/cli.js'
import { hashToken } from '../../src/auth/tokens.js'
import {
  archiveClient,
  archiveData,
  backfillState,
  openPortableServer,
  replay,
  runningImport,
  seedServer,
} from '../support/archive.js'
import { bundleWorker, openCloudflare as openCloudflareWorker } from '../support/cloudflare.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

let worker = ''
beforeAll(async () => {
  worker = await bundleWorker()
}, 60_000)

const openCloudflare = async () => {
  const cloudflare = await openCloudflareWorker(worker)
  cleanups.push(cloudflare.dispose)
  return cloudflare
}

const portable = async () => {
  const server = await openPortableServer()
  cleanups.push(server.close)
  return server
}

describe('Cloudflare server archives', { timeout: 120_000 }, () => {
  it('releases a pre-upgrade restore that kept a full list of destination tokens', async () => {
    const cloudflare = await openCloudflare()
    const insertToken = async (secret: string, scope: 'read' | 'admin') =>
      await cloudflare.database
        .prepare(
          'INSERT INTO "access_tokens" ("token_hash", "label", "scope", "created_with_token", "created_at_ms") VALUES (?, ?, ?, ?, 0)',
        )
        .bind(await hashToken(secret), secret, scope, '0'.repeat(64))
        .run()
    // The older importer accepted up to 100 destination tokens, past D1's per-statement budget
    // once any fence parameter is added.
    const own = Array.from({ length: 100 }, (_, at) => `DESTINATION-OWN-${at}`)
    for (const secret of own) await insertToken(secret, 'read')
    await insertToken('REVOKED-ON-THE-SOURCE', 'admin')
    await cloudflare.database
      .prepare(
        'INSERT INTO "archive_operation" ("id", "kind", "operation_id", "started_at_ms", "position", "state_json") VALUES (1, \'import\', \'legacy\', 0, 2, ?)',
      )
      .bind(
        JSON.stringify({
          phase: 'releasing',
          ended: true,
          preservedTokens: await Promise.all(own.map(hashToken)),
        }),
      )
      .run()

    await discardImport(archiveClient(cloudflare.fetch, cloudflare.api))
    const status = async (token: string) =>
      (
        await cloudflare.fetch(`${cloudflare.api}/manifest`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status
    expect(await status('REVOKED-ON-THE-SOURCE')).toBe(401)
    expect(await status(own[99] as string)).toBe(200)
  })

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
    expect(await replay(node.fetch, node.api, seeded.event)).toEqual({
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
    expect(await replay(restored.fetch, restored.api, seeded.event)).toEqual({
      accepted: false,
      duplicate: true,
    })
    await exportToFile(archiveClient(restored.fetch, restored.api), file('restored.ndjson'))
    expect(archiveData(await readFile(file('restored.ndjson'), 'utf8'))).toEqual(moved)
  })
})
