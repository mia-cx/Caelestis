import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreateBucketCommand, DeleteBucketCommand } from '@aws-sdk/client-s3'
import { S3ObjectStorage } from '@caelestis/storage/s3'
import { afterEach, describe, expect, it } from 'vitest'
import { MariaConnection } from '../../src/adapters/node/mariadb-connection.js'
import { PostgresConnection } from '../../src/adapters/node/postgres-connection.js'
import { exportToFile, finishExport, importFromFile } from '../../src/archive/cli.js'
import type { NodeConfig } from '../../src/node/config.js'
import {
  archiveClient,
  archiveData,
  openPortableServer,
  paint,
  seedServer,
} from '../support/archive.js'

const postgresUrl = process.env.CAELESTIS_TEST_POSTGRES_URL
const mariaUrl = process.env.CAELESTIS_TEST_MARIADB_URL
const s3Endpoint = process.env.CAELESTIS_TEST_S3_ENDPOINT
if ((postgresUrl === undefined) === (mariaUrl === undefined))
  throw new Error('Select exactly one disposable integration database URL.')

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A disposable schema or database in the selected server, for one destination. */
const externalDatabase = async (): Promise<(config: NodeConfig) => NodeConfig> => {
  const name = `caelestis_archive_${crypto.randomUUID().replaceAll('-', '')}`
  if (postgresUrl !== undefined) {
    const admin = new PostgresConnection({ connectionString: postgresUrl, ssl: false })
    await admin.pool.query(`CREATE SCHEMA ${name}`)
    cleanups.push(async () => {
      await admin.pool.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
      await admin.close()
    })
    return (config) => ({
      ...config,
      adapter: 'postgres',
      pg: { connectionString: postgresUrl, options: `-c search_path=${name}`, ssl: false },
    })
  }
  const url = new URL(mariaUrl ?? '')
  const maria = {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: url.username,
    password: url.password,
    ssl: false,
  }
  const admin = new MariaConnection({ ...maria, database: url.pathname.slice(1) })
  await admin.prepare(`CREATE DATABASE ${name}`).run()
  cleanups.push(async () => {
    await admin.prepare(`DROP DATABASE IF EXISTS ${name}`).run()
    await admin.close()
  })
  return (config) => ({ ...config, adapter: 'mariadb', maria: { ...maria, database: name } })
}

/** A fresh S3 bucket when the service is configured; the filesystem otherwise. */
const objectStore = async () => {
  if (s3Endpoint === undefined) return undefined
  const bucket = `caelestis-archive-${crypto.randomUUID()}`
  const storage = new S3ObjectStorage(bucket, {
    endpoint: s3Endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'caelestis-test', secretAccessKey: 'caelestis-test-password' },
  })
  await storage.client.send(new CreateBucketCommand({ Bucket: bucket }))
  cleanups.push(async () => {
    for (;;) {
      const { keys } = await storage.list('', { limit: 1000 })
      if (keys.length === 0) break
      await storage.delete(keys)
    }
    await storage.client.send(new DeleteBucketCommand({ Bucket: bucket }))
    storage.close()
  })
  return storage
}

describe('server archives across relational adapters', { timeout: 120_000 }, () => {
  it(`moves SQLite and filesystem data through ${postgresUrl ? 'PostgreSQL' : 'MariaDB'}${s3Endpoint ? ' and S3' : ''} and back`, async () => {
    const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'caelestis-archive-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const file = (name: string) => join(directory, name)

    const source = await openPortableServer()
    cleanups.push(source.close)
    const seeded = await seedServer(source.fetch, source.api)
    await exportToFile(archiveClient(source.fetch, source.api), file('sqlite.ndjson'))
    const original = archiveData(await readFile(file('sqlite.ndjson'), 'utf8'))
    await finishExport(archiveClient(source.fetch, source.api))

    const objects = await objectStore()
    const external = await openPortableServer({
      config: await externalDatabase(),
      ...(objects === undefined ? {} : { objects }),
    })
    cleanups.push(external.close)
    await importFromFile(archiveClient(external.fetch, external.api), file('sqlite.ndjson'))
    expect(await paint(external.fetch, external.api, seeded.reportToken, seeded.event)).toEqual({
      accepted: false,
      duplicate: true,
    })
    await exportToFile(archiveClient(external.fetch, external.api), file('external.ndjson'))
    expect(archiveData(await readFile(file('external.ndjson'), 'utf8'))).toEqual(original)

    const back = await openPortableServer()
    cleanups.push(back.close)
    await importFromFile(archiveClient(back.fetch, back.api), file('external.ndjson'))
    await exportToFile(archiveClient(back.fetch, back.api), file('back.ndjson'))
    expect(archiveData(await readFile(file('back.ndjson'), 'utf8'))).toEqual(original)
  })
})
