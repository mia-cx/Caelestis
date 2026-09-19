// @vitest-environment happy-dom
import {
  REGION_CLAIM_TTL_MS,
  type RegionClaim,
  type RegionDocument,
  regionDocumentContainsPixel,
  regionDocumentPixels,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { afterEach, assert, describe, expect, it, vi } from 'vitest'
import type { ServerTemplate } from './server-cache.js'
import type { ConnectedServer } from './state.js'

vi.mock('./application/tree-server-state.js', () => ({
  onServerSnapshot: vi.fn(),
  rowsForSurface: vi.fn(),
}))
vi.mock('./presence-client.js', () => ({
  presenceCanWriteClaims: (server: ConnectedServer) =>
    server.token !== null && server.tokenUsable !== false && server.token !== 'read',
}))
vi.mock('./wplace-account.js', () => ({}))
vi.mock('./state.js', () => ({
  serverConnectionIdentity: (server: object) => server,
  activeServerToken: (server: ConnectedServer) =>
    server.tokenUsable === false ? null : server.token,
}))

import { claimDocuments } from './claim-document.js'
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
  const retired = new Set<string>()
  const ownership = new Map(initial.map((server) => [server.url, [] as string[]]))
  let fail: string | null = null
  const host = {
    servers: () => servers,
    actor: () => actor,
    templates: (server: ConnectedServer) => catalogs.get(server.url),
    claims: (server: ConnectedServer) => ({
      ready: true,
      regions: remote.get(server.url) ?? [],
      revision: revisions.get(server.url) ?? 0,
      ownedRegionIds: ownership.get(server.url) ?? [],
    }),
    persist,
    retired: (server: ConnectedServer) => retired.has(server.url),
    retire: (server: ConnectedServer) => {
      retired.add(server.url)
    },
    put: vi.fn(
      async (
        server: ConnectedServer,
        region: RegionClaim,
        _signal: AbortSignal,
      ): Promise<string | null | { deleted: true }> => {
        mutations.push({ method: 'PUT', server: server.url, region })
        return fail === server.url ? 'unreachable' : null
      },
    ),
    remove: vi.fn(
      async (
        server: ConnectedServer,
        region: RegionClaim,
        _signal: AbortSignal,
        _withdraw = false,
      ) => {
        mutations.push({ method: 'DELETE', server: server.url, region })
        return fail === server.url ? 'unreachable' : null
      },
    ),
  }
  return {
    router: new ClaimRouter(host),
    host,
    catalogs,
    remote,
    revisions,
    ownership,
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

describe('authoritative claim deletion', () => {
  it('retires stale saved intent and deletes its other server copies after a deleted response', async () => {
    const h = setup([x, y])
    const region = claim()
    const router = new ClaimRouter(h.host, [
      {
        region,
        deleted: false,
        copies: [
          { url: x.url, serverId: 'x' },
          { url: y.url, serverId: 'y' },
        ],
      },
    ])
    h.host.put.mockImplementation(async (server) => (server === x ? { deleted: true } : null))
    await router.reconcile()
    expect(router.mine()).toEqual([])
    expect(h.host.remove).toHaveBeenCalledWith(x, region, expect.any(AbortSignal), false)
    expect(h.host.remove).toHaveBeenCalledWith(y, region, expect.any(AbortSignal), false)
    const writes = h.host.put.mock.calls.length
    await router.reconcile()
    expect(h.host.put).toHaveBeenCalledTimes(writes)
    expect(h.persist.mock.lastCall?.[0]).toEqual([expect.objectContaining({ deleted: true })])
  })

  it('withdraws replicas on disconnect without declaring the logical claim deleted', async () => {
    const h = setup([x])
    const region = claim()
    const router = new ClaimRouter(h.host, [
      { region, deleted: false, copies: [{ url: x.url, serverId: 'x' }] },
    ])
    await router.disconnect(x)
    expect(h.host.remove).toHaveBeenCalledWith(x, region, expect.any(AbortSignal), true)
    expect(router.mine()).toEqual([region])
  })
})

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
  it.each([
    {
      name: 'only subtracts',
      document: {
        items: [
          {
            id: 'cut',
            op: 'subtract' as const,
            shape: { kind: 'rectangle' as const, x: 0, y: 0, w: 10, h: 10 },
          },
        ],
      },
      message: 'Add a shape before saving this claim.',
    },
    {
      name: 'spans more than the raster limit',
      document: {
        items: [
          {
            id: 'near',
            op: 'add' as const,
            shape: { kind: 'rectangle' as const, x: 0, y: 0, w: 1, h: 1 },
          },
          {
            id: 'far',
            op: 'add' as const,
            shape: { kind: 'rectangle' as const, x: 2_000, y: 2_000, w: 1, h: 1 },
          },
        ],
      },
      message: 'This claim spans too much of the canvas. Move its shapes closer or split it.',
    },
    {
      name: 'subtracts every added pixel',
      document: {
        items: [
          {
            id: 'area',
            op: 'add' as const,
            shape: { kind: 'rectangle' as const, x: 0, y: 0, w: 10, h: 10 },
          },
          {
            id: 'cut',
            op: 'subtract' as const,
            shape: { kind: 'rectangle' as const, x: 0, y: 0, w: 10, h: 10 },
          },
        ],
      },
      message: 'This claim contains no pixels. Adjust or remove its subtracting shapes.',
    },
  ])(
    'rejects a document that $name before persistence or routing',
    async ({ document, message }) => {
      const h = setup([x])
      expect(await h.router.save(null, document)).toBe(message)
      expect(h.persist).not.toHaveBeenCalled()
      expect(h.mutations).toEqual([])
    },
  )

  it('reserves the compatibility error for a valid pending claim with no writable server', async () => {
    const region = claim()
    const h = setup([])
    const router = new ClaimRouter(h.host, [{ region, deleted: false, copies: [] }])
    expect(await router.save(region.id, region.document)).toBe(
      'No compatible server is connected. The claim will retry.',
    )
  })

  it('still removes an invalid persisted claim after its deletion was requested', async () => {
    const region = {
      ...claim(),
      document: {
        items: [
          {
            id: 'cut',
            op: 'subtract' as const,
            shape: { kind: 'rectangle' as const, x: 0, y: 0, w: 10, h: 10 },
          },
        ],
      },
    }
    const h = setup([x])
    const router = new ClaimRouter(h.host, [
      { region, deleted: true, copies: [{ url: x.url, serverId: x.info?.id ?? '' }] },
    ])
    await router.reconcile()
    expect(h.mutations.map((mutation) => mutation.method)).toEqual(['DELETE'])
  })

  it('keeps the original expiry when editing without a renewing presence socket', async () => {
    vi.useFakeTimers()
    const h = setup([x])
    await h.router.save(null, document())
    const original = h.router.mine()[0]
    assert(original !== undefined && original.expiresAt !== undefined)
    vi.setSystemTime(Date.now() + REGION_CLAIM_TTL_MS - 1_000)
    await h.router.save(original.id, document(20))
    expect(h.router.mine()[0]?.expiresAt).toBe(original.expiresAt)
    vi.setSystemTime(original.expiresAt + 1)
    h.mutations.length = 0
    h.revisions.set(x.url, 1)
    await h.router.reconcile()
    expect(h.router.mine()).toEqual([])
    expect(h.mutations).toEqual([])
  })

  it('retains deletion retries across expiry and reload while a renewed copy survives', async () => {
    vi.useFakeTimers()
    const h = setup([x])
    await h.router.save(null, document())
    const original = h.router.mine()[0]
    assert(original !== undefined && original.expiresAt !== undefined)
    h.fail(x.url)
    await h.router.remove(original.id)
    const saved = structuredClone(h.persist.mock.calls.at(-1)?.[0])
    vi.setSystemTime(original.expiresAt + 1)
    h.remote.set(x.url, [{ ...original, expiresAt: Date.now() + REGION_CLAIM_TTL_MS }])
    h.ownership.set(x.url, [original.id])
    h.revisions.set(x.url, 1)
    const resumed = new ClaimRouter(h.host, saved)
    h.mutations.length = 0
    await resumed.reconcile()
    expect(resumed.mine()).toEqual([])
    expect(h.mutations.map((mutation) => mutation.method)).toEqual(['DELETE'])
    h.fail(null)
    h.mutations.length = 0
    await resumed.reconcile()
    expect(h.mutations.map((mutation) => mutation.method)).toEqual(['DELETE'])
    expect(h.persist.mock.calls.at(-1)?.[0][0].copies).toEqual([])
  })

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
    const read = { ...server('read'), token: 'read' }
    const h = setup([x, anonymous, rejected, read])
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
    h.ownership.set(x.url, [own.id])
    h.ownership.set(y.url, [own.id])
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

  it('never adopts a foreign credential claim naming the current painter', async () => {
    const h = setup([x, y])
    h.remote.set(x.url, [claim('spoofed')])
    await h.router.reconcile()
    expect(h.router.mine()).toEqual([])
    expect(h.mutations).toEqual([])
  })

  it('removes a late PUT from another tab and fences its subsequent writes after disconnect', async () => {
    const h = setup([x])
    let complete: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      complete = resolve
    })
    h.host.put.mockImplementation(async () => {
      await gate
      return null
    })
    const saving = h.router.save(null, document())
    await vi.waitFor(() => expect(h.host.put).toHaveBeenCalledOnce())
    const disconnecting = new ClaimRouter({
      ...h.host,
      saved: () => h.persist.mock.calls.at(-1)?.[0] ?? [],
    })
    await disconnecting.disconnect(x)
    expect(h.host.remove).toHaveBeenCalledOnce()
    complete?.()
    await saving
    expect(h.host.remove).toHaveBeenCalledTimes(2)
    await h.router.reconcile()
    expect(h.host.put).toHaveBeenCalledOnce()
  })
})

describe('claim document batches', () => {
  const box = (id: string, x: number, y: number, w = 1, h = 1): RegionDocument => ({
    items: [{ id, op: 'add', shape: { kind: 'rectangle', x, y, w, h } }],
  })
  const persistedDocuments = (h: ReturnType<typeof setup>, at = -1): RegionDocument[] =>
    (h.persist.mock.calls.at(at)?.[0] ?? []).map(
      (entry: { region: RegionClaim }) => entry.region.document,
    )

  it('persists touching owned claims as one while leaving another painter separate', async () => {
    const h = setup([x])
    const first = await h.router.saveAll([], [box('left', 0, 0), box('right', 1, 0)])
    const other: RegionClaim = {
      ...claim('other'),
      claimant: { wplaceUserId: 9, displayName: 'Sam' },
      document: box('other', 2, 0),
      rect: { x: 2, y: 0, w: 1, h: 1 },
    }
    h.remote.set(x.url, [...h.router.mine(), other])
    h.ownership.set(x.url, [...first.ids])
    await h.router.reconcile()
    const mine = h.router.mine()
    expect(mine.map((region) => region.id)).toEqual(first.ids)
    const documents = claimDocuments({ items: mine.flatMap((region) => region.document.items) })
    h.mutations.length = 0
    const merged = await h.router.saveAll(first.ids, documents)
    expect(merged).toEqual({ ids: [first.ids[0]], error: null })
    expect(h.mutations.map((mutation) => [mutation.method, mutation.region.id])).toEqual([
      ['PUT', first.ids[0]],
      ['DELETE', first.ids[1]],
    ])
    const resumed = new ClaimRouter(h.host, structuredClone(h.persist.mock.calls.at(-1)?.[0]))
    expect(resumed.mine()).toHaveLength(1)
    expect(regionDocumentPixels(resumed.mine()[0]?.document as RegionDocument)?.count).toBe(2)
    expect(h.remote.get(x.url)).toContainEqual(other)
  })

  it('persists every new document before the first write and returns independent ids', async () => {
    const h = setup([x])
    const near = box('near', 0, 0)
    const far = box('far', 2000, 2000)
    const result = await h.router.saveAll([], [near, far])
    expect(result).toMatchObject({ error: null })
    expect(new Set(result.ids).size).toBe(2)
    const mine = h.router.mine()
    expect(mine.map((region) => region.rect)).toEqual([
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 2000, y: 2000, w: 1, h: 1 },
    ])
    expect(mine.map((region) => regionDocumentPixels(region.document)?.count)).toEqual([1, 1])
    expect(h.mutations.map((m) => [m.method, m.server])).toEqual([
      ['PUT', x.url],
      ['PUT', x.url],
    ])
    expect(persistedDocuments(h, 0)).toEqual(expect.arrayContaining([near, far]))
    expect(h.persist.mock.invocationCallOrder[0]).toBeLessThan(
      h.host.put.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
  })

  it('routes each document only to the servers whose templates it overlaps', async () => {
    const h = setup([x, y])
    h.catalogs.set(x.url, [template('near-t')])
    h.catalogs.set(y.url, [
      { ...template('far-t'), bbox: { minX: 2000, minY: 2000, maxX: 2010, maxY: 2010 } },
    ])
    const result = await h.router.saveAll(
      [],
      [box('near', 0, 0, 10, 10), box('far', 2000, 2000, 10, 10)],
    )
    expect(result.error).toBeNull()
    expect(h.mutations.map((m) => [m.server, m.region.templateId])).toEqual([
      [x.url, 'near-t'],
      [y.url, 'far-t'],
    ])
  })

  it('keeps a surviving record id and deletes replaced records after writes succeed', async () => {
    const h = setup([x])
    const first = await h.router.saveAll(
      [],
      [box('near', 0, 0, 10, 10), box('far', 2000, 2000, 10, 10)],
    )
    const [nearId, farId] = first.ids
    h.mutations.length = 0
    const moved = box('far', 2000, 2000, 20, 20)
    const result = await h.router.saveAll(first.ids, [moved])
    expect(result).toEqual({ ids: [farId], error: null })
    expect(h.router.mine().map((region) => region.id)).toEqual([farId])
    expect(h.mutations.map((m) => [m.method, m.region.id])).toEqual([
      ['PUT', farId],
      ['DELETE', nearId],
    ])
  })

  it('reuses pending ids after failure, including across a reload', async () => {
    const h = setup([x])
    const docs = [box('near', 0, 0, 10, 10), box('far', 2000, 2000, 10, 10)]
    h.fail(x.url)
    const failed = await h.router.saveAll([], docs)
    expect(failed.error).toContain('unreachable')
    expect(failed.ids).toHaveLength(2)
    h.fail(null)
    const retried = await h.router.saveAll(failed.ids, docs)
    expect(retried).toEqual({ ids: failed.ids, error: null })
    expect(h.router.mine()).toHaveLength(2)
    const resumed = new ClaimRouter(h.host, structuredClone(h.persist.mock.calls.at(-1)?.[0]))
    const again = await resumed.saveAll(failed.ids, docs)
    expect(again).toEqual({ ids: failed.ids, error: null })
    expect(resumed.mine().map((region) => region.id)).toEqual([...failed.ids])
  })

  it('keeps a replaced record out of sight until every new write lands, then deletes it', async () => {
    const legacy: RegionClaim = {
      ...claim('old'),
      document: {
        items: [
          { id: 'old-shape', op: 'add', shape: { kind: 'rectangle', x: 0, y: 0, w: 10, h: 10 } },
        ],
      },
      rect: { x: 0, y: 0, w: 10, h: 10 },
    }
    const h = setup([x])
    const router = new ClaimRouter(h.host, [
      { region: legacy, deleted: false, copies: [{ url: x.url, serverId: x.info?.id ?? '' }] },
    ])
    const left = box('new-left', 0, 0, 4, 10)
    const right = box('new-right', 6, 0, 4, 10)
    const docs = [left, right]
    let failingItem = 'new-right'
    h.host.put.mockImplementation(async (server, region) => {
      h.mutations.push({ method: 'PUT', server: server.url, region })
      return region.document.items[0]?.id === failingItem ? 'unreachable' : null
    })
    const failed = await router.saveAll(['old'], docs)
    expect(failed.error).toContain('unreachable')
    expect(failed.ids).toHaveLength(3)
    expect(failed.ids[2]).toBe('old')
    expect(h.mutations.some((m) => m.method === 'DELETE')).toBe(false)
    expect(persistedDocuments(h)).toEqual(expect.arrayContaining([legacy.document, left, right]))
    expect(router.mine().map((region) => region.document)).toEqual([left, right])

    const resumed = new ClaimRouter(h.host, structuredClone(h.persist.mock.calls.at(-1)?.[0]))
    const loaded = resumed.mine()
    expect(loaded.map((region) => region.document)).toEqual([left, right])
    const flattened: RegionDocument = {
      items: loaded.flatMap((region) => region.document.items),
    }
    expect(regionDocumentContainsPixel(flattened, 2, 5)).toBe(true)
    expect(regionDocumentContainsPixel(flattened, 5, 5)).toBe(false)
    expect(regionDocumentContainsPixel(flattened, 8, 5)).toBe(true)

    failingItem = ''
    h.host.remove.mockImplementationOnce(async (server, region) => {
      h.mutations.push({ method: 'DELETE', server: server.url, region })
      return 'unreachable'
    })
    h.mutations.length = 0
    const second = await resumed.saveAll(failed.ids, docs)
    expect(second.error).toContain('unreachable')
    expect(second.ids).toEqual(failed.ids)
    expect(h.mutations.map((m) => [m.method, m.region.id])).toEqual([
      ['PUT', failed.ids[0]],
      ['PUT', failed.ids[1]],
      ['DELETE', 'old'],
    ])

    h.mutations.length = 0
    const third = await resumed.saveAll(
      loaded.map((region) => region.id),
      docs,
    )
    expect(third).toEqual({ ids: failed.ids.slice(0, 2), error: null })
    expect(h.mutations.map((m) => [m.method, m.region.id])).toEqual([['DELETE', 'old']])
    expect(resumed.mine().map((region) => region.id)).toEqual(failed.ids.slice(0, 2))
  })

  it('keeps a split source whole under its own id until every piece is accepted', async () => {
    const legacy: RegionClaim = {
      ...claim('old'),
      document: {
        items: [
          { id: 'left', op: 'add', shape: { kind: 'rectangle', x: 0, y: 0, w: 4, h: 10 } },
          { id: 'right', op: 'add', shape: { kind: 'rectangle', x: 6, y: 0, w: 4, h: 10 } },
        ],
      },
      rect: { x: 0, y: 0, w: 10, h: 10 },
    }
    const h = setup([x])
    const router = new ClaimRouter(h.host, [
      { region: legacy, deleted: false, copies: [{ url: x.url, serverId: x.info?.id ?? '' }] },
    ])
    // The editor keeps item ids, so each piece still names a shape of the source record.
    const docs = [box('left', 0, 0, 4, 10), box('right', 6, 0, 4, 10)]
    h.host.put.mockImplementation(async (server, region) => {
      h.mutations.push({ method: 'PUT', server: server.url, region })
      return region.document.items[0]?.id === 'right' ? 'unreachable' : null
    })
    const failed = await router.saveAll(['old'], docs)
    expect(failed.error).toContain('unreachable')
    expect(failed.ids).toHaveLength(3)
    expect(failed.ids.slice(0, 2)).not.toContain('old')
    expect(failed.ids[2]).toBe('old')
    expect(h.mutations.map((m) => m.region.id)).not.toContain('old')
    expect(persistedDocuments(h)).toEqual(expect.arrayContaining([legacy.document]))

    h.host.put.mockImplementation(async (server, region) => {
      h.mutations.push({ method: 'PUT', server: server.url, region })
      return null
    })
    h.mutations.length = 0
    const retried = await router.saveAll(failed.ids, docs)
    expect(retried).toEqual({ ids: failed.ids.slice(0, 2), error: null })
    // The first piece already landed; only the failed one is written before the source goes.
    expect(h.mutations.map((m) => [m.method, m.region.id])).toEqual([
      ['PUT', failed.ids[1]],
      ['DELETE', 'old'],
    ])
    expect(router.mine().map((region) => region.id)).toEqual(failed.ids.slice(0, 2))
  })

  it('waits for the latest replacement before cleaning superseded records', async () => {
    const h = setup([x])
    const router = new ClaimRouter(h.host, [
      {
        region: claim('old'),
        deleted: false,
        copies: [{ url: x.url, serverId: x.info?.id ?? '' }],
      },
    ])
    let failingItem = 'middle'
    h.host.put.mockImplementation(async (server, region) => {
      h.mutations.push({ method: 'PUT', server: server.url, region })
      return region.document.items[0]?.id === failingItem ? 'unreachable' : null
    })
    const first = await router.saveAll(['old'], [box('middle', 0, 0, 10, 10)])
    expect(first.error).toContain('unreachable')
    const middleId = first.ids[0] ?? 'missing'
    expect(router.mine().map((region) => region.id)).toEqual([middleId])

    failingItem = 'latest'
    const second = await router.saveAll(first.ids, [box('latest', 0, 0, 10, 10)])
    expect(second.error).toContain('unreachable')
    const latestId = second.ids[0] ?? 'missing'
    expect(latestId).not.toBe(middleId)
    expect(router.mine().map((region) => region.id)).toEqual([latestId])
    expect(h.mutations.some((m) => m.method === 'DELETE')).toBe(false)

    failingItem = ''
    h.mutations.length = 0
    const third = await router.saveAll(second.ids, [box('latest', 0, 0, 10, 10)])
    expect(third).toEqual({ ids: [latestId], error: null })
    expect(h.mutations.map((m) => [m.method, m.region.id])).toEqual([
      ['PUT', latestId],
      ['DELETE', 'old'],
      ['DELETE', middleId],
    ])
    expect(router.mine().map((region) => region.id)).toEqual([latestId])
  })

  it('restores every local entry unchanged when persistence fails', async () => {
    const h = setup([x])
    h.persist.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const docs = [box('near', 0, 0, 10, 10), box('far', 2000, 2000, 10, 10)]
    const result = await h.router.saveAll([], docs)
    expect(result.error).toBe('Could not save claims: Error: disk full')
    expect(result.ids).toEqual([])
    expect(h.router.mine()).toEqual([])
    expect(h.mutations).toEqual([])

    expect(await h.router.save(null, document())).toBeNull()
    const kept = h.router.mine()[0]?.id ?? 'missing'
    h.persist.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const batch = await h.router.saveAll([kept], [document(50)])
    expect(batch.error).toBe('Could not save claims: Error: disk full')
    expect(batch.ids).toEqual([kept])
    expect(h.router.mine().map((region) => region.document)).toEqual([document()])
  })

  it('keeps the replaced record visible when persisting its supersession fails', async () => {
    const h = setup([x])
    const router = new ClaimRouter(h.host, [
      {
        region: claim('old'),
        deleted: false,
        copies: [{ url: x.url, serverId: x.info?.id ?? '' }],
      },
    ])
    h.persist.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const result = await router.saveAll(
      ['old'],
      [box('new-a', 0, 0, 4, 10), box('new-b', 6, 0, 4, 10)],
    )
    expect(result.error).toBe('Could not save claims: Error: disk full')
    expect(result.ids).toEqual(['old'])
    expect(h.mutations).toEqual([])
    const mine = router.mine()
    expect(mine.map((region) => region.id)).toEqual(['old'])
    expect(mine[0]?.document.items[0]?.id).toBe('shape')
  })

  it('rejects the whole batch when any document is invalid', async () => {
    const h = setup([x])
    const emptied: RegionDocument = {
      items: [
        { id: 'add', op: 'add', shape: { kind: 'rectangle', x: 0, y: 0, w: 10, h: 10 } },
        { id: 'cut', op: 'subtract', shape: { kind: 'rectangle', x: 0, y: 0, w: 10, h: 10 } },
      ],
    }
    const result = await h.router.saveAll([], [box('near', 0, 0, 10, 10), emptied])
    expect(result).toEqual({
      ids: [],
      error: 'This claim contains no pixels. Adjust or remove its subtracting shapes.',
    })
    expect(h.persist).not.toHaveBeenCalled()
    expect(h.mutations).toEqual([])
  })

  it('removes only the listed claims when the batch is empty', async () => {
    const h = setup([x])
    const copy = { url: x.url, serverId: x.info?.id ?? '' }
    const router = new ClaimRouter(h.host, [
      { region: claim('a'), deleted: false, copies: [copy] },
      { region: claim('b'), deleted: false, copies: [copy] },
      { region: claim('c'), deleted: false, copies: [copy] },
    ])
    const result = await router.saveAll(['a', 'b'], [])
    expect(result).toEqual({ ids: [], error: null })
    expect(router.mine().map((region) => region.id)).toEqual(['c'])
    const deleted = h.mutations.filter((m) => m.method === 'DELETE').map((m) => m.region.id)
    expect(deleted).toEqual(expect.arrayContaining(['a', 'b']))
    expect(deleted).not.toContain('c')
  })
})
