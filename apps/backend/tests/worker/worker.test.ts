import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { LIVE_CAPABILITIES } from '../../src/server-info.js'
import { ARCHIVE_ADMIN } from '../support/archive.js'
import { bundleWorker, openCloudflare } from '../support/cloudflare.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

let worker = ''
beforeAll(async () => {
  worker = await bundleWorker()
}, 60_000)

const exampleVars = (): Record<string, string> => {
  const text = readFileSync(
    join(import.meta.dirname, '../../wrangler.self-hosted.example.toml'),
    'utf8',
  )
  const table = text.split(/^\[vars\]$/m)[1]?.split(/^\[/m)[0] ?? ''
  return Object.fromEntries(
    [...table.matchAll(/^([A-Z_]+) = "(.*)"$/gm)].map(([, name, value]) => [name, value]),
  )
}

const open = async (vars?: Record<string, string>) => {
  const cloudflare = await openCloudflare(worker, undefined, vars)
  cleanups.push(cloudflare.dispose)
  return cloudflare
}

const admin = { authorization: `Bearer ${ARCHIVE_ADMIN}` }

describe('Cloudflare Worker composition', { timeout: 120_000 }, () => {
  it('serves a deployment configured from the shipped self-hosted example', async () => {
    const cloudflare = await open({ ...exampleVars(), ADMIN_TOKEN: ARCHIVE_ADMIN })
    const api = 'https://cloudflare.test/backend/v1'
    const server = await cloudflare.fetch(`${api}/server`)
    expect(server.status).toBe(200)
    expect(await server.json()).toEqual({
      id: '00000000-0000-7000-8000-000000000001',
      name: 'My Caelestis server',
      auth: 'access_token',
      version: 'test',
      build: 'test',
      ...LIVE_CAPABILITIES,
    })
    const manifest = await cloudflare.fetch(`${api}/manifest?season=0`, { headers: admin })
    expect(manifest.status).toBe(200)
    expect((await cloudflare.fetch('https://cloudflare.test/v1/server')).status).toBe(404)
  })

  it('reaches presence rooms and status shards through the context ports', async () => {
    const cloudflare = await open()
    const online = await cloudflare.fetch(`${cloudflare.api}/telemetry/presence/online?season=0`, {
      headers: admin,
    })
    expect(await online.json()).toEqual({ online: 0 })
    const timings = await cloudflare.fetch(`${cloudflare.api}/admin/server/ingest-timings`, {
      headers: admin,
    })
    expect(timings.status).toBe(200)
    expect(await timings.json()).toMatchObject({
      presenceRoom: { season: 0, surface: { kind: 'world' } },
    })
  })
})
