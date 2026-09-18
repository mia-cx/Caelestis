import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FilesystemObjectStorage } from '@caelestis/storage/filesystem'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { PostgresConnection } from '../adapters/node/postgres-connection.js'
import { readNodeConfig } from './config.js'
import { openNodeRuntime } from './runtime.js'
import { type FrontendHandler, listenNodeServer } from './server.js'

type Listener = (
  ...args: Parameters<typeof listenNodeServer>
) => Promise<Pick<Awaited<ReturnType<typeof listenNodeServer>>, 'port' | 'close'>>
const listen: Listener = process.versions.bun
  ? (await import(new URL('../bun/server.ts', import.meta.url).href)).listenBunServer
  : listenNodeServer

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

const adapters = ['sqlite', ...(process.env.CAELESTIS_TEST_POSTGRES_URL ? ['postgres'] : [])]
it('bootstraps a separate frontend credential without restoring it after revocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caelestis-frontend-token-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  expect(() => readNodeConfig({ ADMIN_TOKEN: 'same', CAELESTIS_READ_TOKEN: 'same' })).toThrow(
    'different credentials',
  )
  const config = readNodeConfig({
    DATA_DIRECTORY: directory,
    ADMIN_TOKEN: 'admin-test',
    CAELESTIS_READ_TOKEN: 'frontend-test',
  })
  const storage = new FilesystemObjectStorage(join(directory, 'objects'))
  const runtime = await openNodeRuntime(config, storage, { onOwnershipLost() {} })
  expect(runtime.readToken).toBe('frontend-test')
  expect(await runtime.connection.prepare('SELECT scope FROM access_tokens').first()).toEqual({
    scope: 'read',
  })
  await runtime.connection.prepare('DELETE FROM access_tokens').run()
  await runtime.close()
  await expect(openNodeRuntime(config, storage, { onOwnershipLost() {} })).rejects.toThrow(
    'active read-only token',
  )
})

it.each(adapters)(
  '%s serves authenticated HTTP and real v2 WebSockets across a restart',
  async (adapter) => {
    const directory = await mkdtemp(join(tmpdir(), 'caelestis-server-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const schema = `runtime_${crypto.randomUUID().replaceAll('-', '')}`
    const configured = readNodeConfig({
      DB_ADAPTER: adapter,
      ...(adapter === 'postgres'
        ? { DATABASE_URL: process.env.CAELESTIS_TEST_POSTGRES_URL, PG_TLS_MODE: 'disable' }
        : {}),
      DATA_DIRECTORY: directory,
      PORT: '0',
      HOST: '127.0.0.1',
      ADMIN_TOKEN: 'test-admin',
    })
    const config = { ...configured, pg: { ...configured.pg, options: `-c search_path=${schema}` } }
    if (adapter === 'postgres') {
      const admin = new PostgresConnection(config.pg)
      await admin.pool.query(`CREATE SCHEMA ${schema}`)
      cleanup.push(async () => {
        await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`)
        await admin.close()
      })
    }
    let frontend: FrontendHandler | undefined
    if (process.env.CAELESTIS_TEST_FRONTEND_HANDLER && !process.versions.bun) {
      const loaded: { handler: FrontendHandler } = await import(
        pathToFileURL(process.env.CAELESTIS_TEST_FRONTEND_HANDLER).href
      )
      frontend = loaded.handler
    }
    const storage = new FilesystemObjectStorage(join(directory, 'objects'))
    const ownershipLost = vi.fn()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    let runtime = await openNodeRuntime(config, storage, { onOwnershipLost: ownershipLost })
    let server = await listen(runtime, config, frontend)
    cleanup.push(() => server.close())
    const id = runtime.serverId
    const token = runtime.readToken
    expect((await fetch(`http://127.0.0.1:${server.port}/health/ready`)).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${server.port}/backend/v1/manifest`)).status).toBe(401)
    const response = await fetch(`http://127.0.0.1:${server.port}/backend/v1/manifest`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(await response.json()).toMatchObject({ server: { id, liveSyncMax: 2 } })
    const issued = await fetch(`http://127.0.0.1:${server.port}/backend/v1/admin/tokens`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-admin', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Presence test', scope: 'report' }),
    })
    expect(issued.status).toBe(201)
    const credential = (await issued.json()) as { token: string; tokenHash: string }
    const presence = new WebSocket(
      `ws://127.0.0.1:${server.port}/backend/v1/telemetry/presence?season=0&painterId=42&painterName=Mia&clientId=01890f3e-7b2c-7abc-8def-000000000005`,
      [
        'caelestis.presence.v1',
        `caelestis.auth.b64.${Buffer.from(credential.token).toString('base64url')}`,
      ],
    )
    const ready = once(presence, 'message')
    await once(presence, 'open')
    expect(JSON.parse(String((await ready)[0]))).toMatchObject({
      type: 'presence-ready',
      online: 1,
      regions: [],
    })
    const revoked = once(presence, 'close')
    const removed = await fetch(
      `http://127.0.0.1:${server.port}/backend/v1/admin/tokens/${credential.tokenHash}`,
      {
        method: 'DELETE',
        headers: { authorization: 'Bearer test-admin' },
      },
    )
    expect(removed.status).toBe(204)
    expect((await revoked)[0]).toBe(1008)
    if (frontend) {
      const page = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(page.status).toBe(200)
      const html = await page.text()
      expect(html).toContain(id)
      expect(html).not.toContain(token)
      const manifest = await fetch(`http://127.0.0.1:${server.port}/api/v1/manifest`)
      expect(await manifest.json()).toMatchObject({ server: { id } })
    }
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/v1/telemetry/live?season=0&scope=public&stateVector=1`,
      ['caelestis.live.v2'],
    )
    await once(ws, 'open')
    expect(ws.protocol).toBe('caelestis.live.v2')
    let message = once(ws, 'message')
    ws.send('ping')
    expect(String((await message)[0])).toBe('pong')
    message = once(ws, 'message')
    ws.send(
      JSON.stringify({
        type: 'state-vector',
        requestId: '01890f3e-7b2c-7abc-8def-000000000003',
        revision: null,
        projections: [],
      }),
    )
    const first = (await message)[0]
    expect(JSON.parse(String(first))).toMatchObject({
      type: 'status-snapshot',
      status: { templates: [] },
    })
    const closed = once(ws, 'close')
    ws.close()
    await closed
    await server.close()
    runtime = await openNodeRuntime(config, storage, { onOwnershipLost: ownershipLost })
    server = await listen(runtime, config, frontend)
    expect(runtime.serverId).toBe(id)
    expect(runtime.readToken).toBe(token)
    expect(ownershipLost).not.toHaveBeenCalled()
    const reconnected = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/v1/telemetry/live?season=0&scope=public&stateVector=1`,
      ['caelestis.live.v2'],
    )
    await once(reconnected, 'open')
    const stopped = once(reconnected, 'close')
    await server.close()
    expect((await stopped)[0]).toBe(1001)
  },
)

it('reports per-pod users, slots, and admission outcomes on /metrics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caelestis-capacity-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const config = readNodeConfig({
    DATA_DIRECTORY: directory,
    PORT: '0',
    HOST: '127.0.0.1',
    ADMIN_TOKEN: 'test-admin',
  })
  const storage = new FilesystemObjectStorage(join(directory, 'objects'))
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const runtime = await openNodeRuntime(config, storage, { onOwnershipLost() {} })
  const server = await listen(runtime, config)
  cleanup.push(() => server.close())
  const base = `127.0.0.1:${server.port}`
  const metrics = async () => (await fetch(`http://${base}/metrics`)).text()
  const empty = await metrics()
  expect(empty).toContain('caelestis_connected_users 0\n')
  expect(empty).toContain('caelestis_live_sync_connections 0\n')
  expect(empty).toContain('caelestis_presence_connections 0\n')
  expect(empty).toContain('caelestis_admissions_total{channel="live-sync"} 0\n')
  expect(empty).toContain('caelestis_admission_rejections_total{channel="presence"} 0\n')
  expect(empty).toMatch(/caelestis_event_loop_lag_seconds\{stat="max"\} \d/)
  expect(empty).not.toContain('test-admin')

  const issued = await fetch(`http://${base}/backend/v1/admin/tokens`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Capacity test', scope: 'report' }),
  })
  const credential = (await issued.json()) as { token: string; tokenHash: string }
  const auth = `caelestis.auth.b64.${Buffer.from(credential.token).toString('base64url')}`
  const sockets: WebSocket[] = []
  const open = async (url: string, protocols: string[]) => {
    const socket = new WebSocket(`ws://${base}${url}`, protocols)
    sockets.push(socket)
    await once(socket, 'open')
    return socket
  }
  const liveUrl = '/backend/v1/telemetry/live?season=0&scope=public&stateVector=1'
  await open(
    '/backend/v1/telemetry/presence?season=0&painterId=42&painterName=Mia&clientId=01890f3e-7b2c-7abc-8def-000000000005',
    ['caelestis.presence.v1', auth],
  )
  await open(liveUrl, ['caelestis.live.v2', auth])
  await open(liveUrl, ['caelestis.live.v2', auth])
  await open(
    '/api/v1/telemetry/live?season=0&scope=public&stateVector=1&clientId=01890f3e-7b2c-7abc-8def-000000000006',
    ['caelestis.live.v2'],
  )
  const busy = await metrics()
  expect(busy).toContain('caelestis_connected_users 2\n')
  expect(busy).toContain('caelestis_live_sync_connections 3\n')
  expect(busy).toContain('caelestis_presence_connections 1\n')
  expect(busy).toContain('caelestis_coordinator_connections{kind="live-sync",coordinator="0"} 3\n')
  expect(busy).toMatch(
    /caelestis_coordinator_connections\{kind="presence",coordinator="0:[a-z]+"\} 1\n/,
  )
  expect(busy).toContain(
    'caelestis_coordinator_connection_limit{kind="live-sync",coordinator="0"} 256\n',
  )
  expect(busy).toContain('caelestis_admissions_total{channel="live-sync"} 3\n')
  expect(busy).toContain('caelestis_admissions_total{channel="presence"} 1\n')
  expect(busy).not.toContain(credential.tokenHash)

  // The per-client live limit is 16; the seventeenth upgrade for this credential is refused.
  for (let extra = 0; extra < 14; extra += 1) await open(liveUrl, ['caelestis.live.v2', auth])
  const refused = new WebSocket(`ws://${base}${liveUrl}`, ['caelestis.live.v2', auth])
  const [, response] = (await once(refused, 'unexpected-response')) as [
    unknown,
    { statusCode: number },
  ]
  expect(response.statusCode).toBe(503)
  const saturated = await metrics()
  expect(saturated).toContain('caelestis_live_sync_connections 17\n')
  expect(saturated).toContain('caelestis_admissions_total{channel="live-sync"} 17\n')
  expect(saturated).toContain('caelestis_admission_rejections_total{channel="live-sync"} 1\n')
  expect(saturated).toContain('caelestis_connected_users 2\n')

  for (const socket of sockets) socket.close()
  await vi.waitFor(async () => {
    const drained = await metrics()
    expect(drained).toContain('caelestis_connected_users 0\n')
    expect(drained).toContain('caelestis_live_sync_connections 0\n')
    expect(drained).toContain('caelestis_presence_connections 0\n')
  })
})
