import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { LIVE_CAPABILITIES } from '../../src/live/session.js'
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

  it("delivers a room's socket messages to its coordinator", async () => {
    const cloudflare = await open()
    const response = await cloudflare.dispatchFetch(
      `${cloudflare.api}/telemetry/presence?season=0&painterId=42&painterName=Mia&clientId=01890f3e-7b2c-7abc-8def-000000000005`,
      {
        headers: {
          upgrade: 'websocket',
          'sec-websocket-protocol': `caelestis.presence.v1, caelestis.auth.b64.${Buffer.from(ARCHIVE_ADMIN).toString('base64url')}`,
        },
      },
    )
    const socket = response.webSocket
    if (socket === null) throw new Error(`Expected a presence socket, got ${response.status}`)
    const ready = new Promise<string>((resolve) =>
      socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true }),
    )
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener('close', (event) => resolve(event.code)),
    )
    socket.accept()
    expect(JSON.parse(await ready)).toMatchObject({ type: 'presence-ready', online: 1 })
    socket.send(new Uint8Array([1]))
    expect(await closed).toBe(1003)
  })
})
