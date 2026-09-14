// @vitest-environment happy-dom
import {
  REGION_CLAIM_TTL_MS,
  type RegionClaim,
  type RegionDocument,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerTemplate } from './server-cache.js'
import type { ConnectedServer } from './state.js'

vi.mock('./application/tree-server-state.js', () => ({
  onServerSnapshot: vi.fn(),
  rowsForSurface: vi.fn(),
}))
vi.mock('./presence-client.js', () => ({}))
vi.mock('./wplace-account.js', () => ({}))
vi.mock('./state.js', () => ({
  serverConnectionIdentity: (server: object) => server,
  activeServerToken: (server: ConnectedServer) =>
    server.tokenUsable === false ? null : server.token,
}))

import { ClaimRouter, claimRecipients } from './claim-routing.js'

const actor = { wplaceUserId: 7, displayName: 'Mia' }
const server = (name: string, season = 0): ConnectedServer => ({
  url: `https://${name}.test`,
  info: { id: name, name, auth: 'access_token', presence: 1 },
  token: name,
  status: 'connected',
  season,
  isAdmin: false,
})
const x = server('x'),
  y = server('y'),
  z = server('z')
const document = (at = 0): RegionDocument => ({
  items: [{ id: 'shape', op: 'add', shape: { kind: 'rectangle', x: at, y: 0, w: 10, h: 10 } }],
})
const claim = (id = 'claim'): RegionClaim => ({
  id,
  season: 0,
  surface: WORLD_TEMPLATE_SURFACE,
  templateId: null,
  claimant: actor,
  document: document(),
  rect: { x: 0, y: 0, w: 10, h: 10 },
  label: '',
  createdAt: Date.now(),
  expiresAt: Date.now() + REGION_CLAIM_TTL_MS,
})
const template = (id: string, at = 0): ServerTemplate => ({
  id,
  name: id,
  nodeId: null,
  version: 'version',
  published: true,
  updatedAt: 1,
  bbox: { minX: at, minY: 0, maxX: at + 10, maxY: 10 },
  chunks: [],
})

const setup = (initial: ConnectedServer[] = [x, y, z]) => {
  let servers = initial
  const catalogs = new Map(initial.map((server) => [server.url, [] as ServerTemplate[]]))
  const remote = new Map(initial.map((server) => [server.url, [] as RegionClaim[]]))
  const revisions = new Map(initial.map((server) => [server.url, 0]))
  const mutations: { method: string; server: string; region: RegionClaim }[] = []
  const persist = vi.fn()
  let fail: string | null = null
  const host = {
    servers: () => servers,
    actor: () => actor,
    templates: (server: ConnectedServer) => catalogs.get(server.url),
    claims: (server: ConnectedServer) => ({
      ready: true,
      regions: remote.get(server.url) ?? [],
      revision: revisions.get(server.url) ?? 0,
    }),
    persist,
    put: vi.fn(async (server: ConnectedServer, region: RegionClaim, _signal: AbortSignal) => {
      mutations.push({ method: 'PUT', server: server.url, region })
      return fail === server.url ? 'unreachable' : null
    }),
    remove: vi.fn(async (server: ConnectedServer, region: RegionClaim, _signal: AbortSignal) => {
      mutations.push({ method: 'DELETE', server: server.url, region })
      return fail === server.url ? 'unreachable' : null
    }),
  }
  return {
    router: new ClaimRouter(host),
    host,
    catalogs,
    remote,
    revisions,
    mutations,
    persist,
    servers: (next: ConnectedServer[]) => {
      servers = next
    },
    fail: (url: string | null) => {
      fail = url
    },
  }
}
afterEach(() => vi.useRealTimers())

describe('claim recipients', () => {
  it('uses actual claimed pixels, matching surface/season, and no-overlap fallback', () => {
    const region = claim()
    const otherSeason = server('old', 1)
    const catalogs = new Map([
      [x, [template('tx')]],
      [y, [template('ty')]],
      [z, [template('tz', 20)]],
    ])
    expect([
      ...(claimRecipients(region, [x, y, z, otherSeason], (server) =>
        catalogs.get(server),
      )?.keys() ?? []),
    ]).toEqual([x, y])
    const cut: RegionClaim = {
      ...region,
      document: {
        items: [
          ...region.document.items,
          { id: 'cut', op: 'subtract', shape: { kind: 'rectangle', x: 0, y: 0, w: 9, h: 10 } },
        ],
      },
    }
    catalogs.set(x, [{ ...template('cutout'), bbox: { minX: 0, maxX: 9, minY: 0, maxY: 10 } }])
    catalogs.set(y, [
      { ...template('alliance'), surface: { kind: 'alliance-headquarters', allianceId: 1 } },
    ])
    expect([
      ...(claimRecipients(cut, [x, y, z], (server) => catalogs.get(server))?.keys() ?? []),
    ]).toEqual([x, y, z])
    expect(claimRecipients(region, [x], () => undefined)).toBeNull()
  })
})

describe('claim replication', () => {
  it('replays a missing copy after a new authoritative server snapshot', async () => {
    const h = setup([x, y])
    await h.router.save(null, document())
    h.mutations.length = 0
    h.revisions.set(x.url, 1)
    await h.router.reconcile()
    expect(h.mutations.map((mutation) => [mutation.method, mutation.server])).toEqual([
      ['PUT', x.url],
    ])
    expect(h.router.mine()).toHaveLength(1)
  })

  it('routes claims only to compatible writable connections', async () => {
    const anonymous = { ...y, token: null, season: 1 }
    const rejected = { ...z, tokenUsable: false }
    const h = setup([x, anonymous, rejected])
    expect(await h.router.save(null, document())).toBeNull()
    expect(h.mutations.map((mutation) => mutation.server)).toEqual([x.url])
  })

  it('refreshes shared intent before an older tab can replay a stale edit or deletion', async () => {
    const h = setup([x])
    await h.router.save(null, document())
    const id = h.router.mine()[0]?.id ?? 'missing'
    const older = new ClaimRouter(h.host, structuredClone(h.persist.mock.calls.at(-1)?.[0]))
    await older.reconcile()
    await h.router.save(id, document(100))
    older.restore(structuredClone(h.persist.mock.calls.at(-1)?.[0]))
    h.mutations.length = 0
    await older.reconcile()
    expect(
      h.mutations.every(
        (mutation) =>
          mutation.region.document.items[0]?.shape.kind === 'rectangle' &&
          mutation.region.document.items[0].shape.x === 100,
      ),
    ).toBe(true)
    await h.router.remove(id)
    older.restore(structuredClone(h.persist.mock.calls.at(-1)?.[0]))
    h.mutations.length = 0
    await older.reconcile()
    expect(h.mutations.some((mutation) => mutation.method === 'PUT')).toBe(false)
    expect(older.mine()).toEqual([])
  })

  it('keeps one ID across overlap recipients, edits, fallback transitions and deletion', async () => {
    const h = setup()
    h.catalogs.set(x.url, [template('tx')])
    h.catalogs.set(y.url, [template('ty')])
    expect(await h.router.save(null, document())).toBeNull()
    expect(h.mutations.map((m) => m.server)).toEqual([x.url, y.url])
    const id = h.router.mine()[0]?.id ?? 'missing'
    expect(new Set(h.mutations.map((m) => m.region.id))).toEqual(new Set([id]))
    h.mutations.length = 0
    expect(await h.router.save(id, document(100))).toBeNull()
    expect(h.mutations.map((m) => m.server)).toEqual([x.url, y.url, z.url])
    h.catalogs.set(y.url, [template('new-y', 100)])
    h.mutations.length = 0
    await h.router.reconcile()
    expect(h.mutations.map((m) => [m.method, m.server])).toEqual([
      ['PUT', y.url],
      ['DELETE', x.url],
      ['DELETE', z.url],
    ])
    h.mutations.length = 0
    expect(await h.router.remove(id)).toBeNull()
    expect(h.mutations.map((m) => [m.method, m.server])).toEqual([['DELETE', y.url]])
    expect(h.router.mine()).toEqual([])
  })

  it('replays eligible claims to a newly added server without rewriting acknowledged copies', async () => {
    const h = setup([x])
    await h.router.save(null, document())
    h.servers([x, y])
    h.catalogs.set(y.url, [])
    h.mutations.length = 0
    await h.router.reconcile()
    expect(h.mutations.map((m) => m.server)).toEqual([y.url])
    const saved = h.persist.mock.calls.at(-1)?.[0]
    h.mutations.length = 0
    await new ClaimRouter(h.host, structuredClone(saved)).reconcile()
    expect(h.mutations.map((m) => m.server)).toEqual([x.url, y.url])
  })

  it('retains old copies during partial failure and retries the same new claim identity', async () => {
    const h = setup([x, y])
    h.fail(y.url)
    expect(await h.router.save(null, document())).toContain('unreachable')
    const id = h.router.mine()[0]?.id ?? 'missing'
    h.fail(null)
    expect(await h.router.save(null, document())).toBeNull()
    expect(h.router.mine().map((region) => region.id)).toEqual([id])
    expect(h.mutations.filter((m) => m.server === x.url)).toHaveLength(1)
    h.catalogs.set(y.url, [template('only-y')])
    h.fail(y.url)
    h.mutations.length = 0
    await h.router.reconcile()
    expect(h.mutations.some((m) => m.method === 'DELETE')).toBe(false)
  })

  it('adopts owned legacy copies once, preserves delete intent, and drops expired replay', async () => {
    const h = setup([x, y])
    const own = claim()
    h.remote.set(x.url, [
      own,
      { ...claim('someone-else'), claimant: { wplaceUserId: 9, displayName: 'Sam' } },
    ])
    h.remote.set(y.url, [own])
    await h.router.reconcile()
    expect(h.router.mine()).toHaveLength(1)
    h.fail(y.url)
    await h.router.remove(own.id)
    const saved = structuredClone(h.persist.mock.calls.at(-1)?.[0])
    const resumed = new ClaimRouter(h.host, saved)
    h.mutations.length = 0
    await resumed.reconcile()
    expect(resumed.mine()).toEqual([])
    expect(h.mutations.every((m) => m.method === 'DELETE' && m.region.id === own.id)).toBe(true)
    h.remote.clear()
    h.mutations.length = 0
    const expired = new ClaimRouter(h.host, [
      { region: { ...own, expiresAt: Date.now() - 1 }, deleted: false, copies: [] },
    ])
    await expired.reconcile()
    expect(h.mutations).toEqual([])
  })

  it('cleans only the current painter on disconnect and bounds an unreachable server', async () => {
    vi.useFakeTimers()
    const h = setup([x, y])
    await h.router.save(null, document())
    h.remote.set(x.url, [{ ...claim('other'), claimant: { wplaceUserId: 9, displayName: 'Sam' } }])
    h.mutations.length = 0
    h.host.remove.mockImplementation(async (_server, region, signal) => {
      expect(region.claimant.wplaceUserId).toBe(actor.wplaceUserId)
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      return 'unreachable'
    })
    const cleanup = h.router.disconnect(x)
    await vi.advanceTimersByTimeAsync(3_000)
    await cleanup
    expect(h.host.remove).toHaveBeenCalledTimes(1)
    h.servers([y])
    await h.router.reconcile()
    expect(h.router.mine()).toHaveLength(1)
  })
})
