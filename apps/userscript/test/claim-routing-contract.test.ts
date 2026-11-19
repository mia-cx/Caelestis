import type { RegionClaim, RegionDocument } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { ClaimRouter } from '../src/claim-routing.js'
import type { ServerConnection } from '../src/settings.js'

type Entries = ConstructorParameters<typeof ClaimRouter>[1]
type Host = ConstructorParameters<typeof ClaimRouter>[0]

const server: ServerConnection = {
  url: 'https://claims.test',
  token: 'report',
  status: 'connected',
  season: 3,
  isAdmin: false,
  info: { id: 'claims', name: 'Claims', auth: 'access_token', presence: 1 },
}
const actor = { wplaceUserId: 42, displayName: 'Painter' }

/** The claims the journal holds as live: not deleted and not awaiting replacement. */
const live = (entries: Entries) =>
  (entries ?? [])
    .filter((entry) => !entry.deleted && entry.replaceAfter === undefined)
    .map((entry) => entry.region)

it('retains delivery intent across reload, ignores unchanged snapshot churn, and retries terminal deletion', async () => {
  const document: RegionDocument = {
    items: [{ id: 'shape', op: 'add', shape: { kind: 'rectangle', x: 0, y: 0, w: 2, h: 2 } }],
  }
  let saved: Entries = []
  let regions: RegionClaim[] = []
  let revision = 0
  let unavailable = true
  const writes: Array<{ method: string; id: string; withdraw?: boolean }> = []
  const host: Host = {
    servers: () => [server],
    actor: () => actor,
    templates: () => [],
    claims: () => ({
      ready: true,
      regions,
      revision,
      ownedRegionIds: regions.map((region) => region.id),
    }),
    persist: (entries) => {
      saved = structuredClone(entries)
    },
    saved: () => saved ?? [],
    retired: () => false,
    retire: () => {},
    put: async (_server, region) => {
      writes.push({ method: 'PUT', id: region.id })
      if (unavailable) return { kind: 'error', message: 'offline' }
      regions = [structuredClone(region)]
      return { kind: 'ok' }
    },
    remove: async (_server, region, _signal, withdraw) => {
      writes.push({ method: 'DELETE', id: region.id, withdraw })
      if (unavailable) return { kind: 'error', message: 'offline' }
      regions = []
      return { kind: 'ok' }
    },
  }
  let router = new ClaimRouter(host)
  const first = await router.saveAll([], [document])
  expect(first.error).toContain('offline')
  const [id] = first.ids
  expect(live(saved).map((region) => region.id)).toEqual([id])
  expect(regions).toEqual([])
  unavailable = false
  router = new ClaimRouter(host, saved)
  await router.reconcile()
  expect(regions.map((region) => region.id)).toEqual([id])
  writes.length = 0
  regions = structuredClone(regions)
  revision++
  await router.reconcile()
  expect(writes).toEqual([])
  unavailable = true
  expect(await router.remove(id ?? '')).toContain('offline')
  expect(live(saved)).toEqual([])
  router = new ClaimRouter(host, saved)
  unavailable = false
  await router.reconcile()
  expect(regions).toEqual([])
  expect(writes).toEqual([
    { method: 'DELETE', id, withdraw: false },
    { method: 'DELETE', id, withdraw: false },
  ])
})

it('keeps an unchanged claim document across reloads of the shared journal', async () => {
  let saved: Entries = []
  let persisted: Entries = []
  const router = new ClaimRouter({
    servers: () => [server],
    actor: () => actor,
    templates: () => [],
    claims: () => ({ ready: true, regions: [], revision: 0, ownedRegionIds: [] }),
    persist: (entries) => {
      persisted = entries
      saved = JSON.parse(JSON.stringify(entries))
    },
    saved: () => saved ?? [],
    retired: () => false,
    retire: () => {},
    put: async () => ({ kind: 'ok' }),
    remove: async () => ({ kind: 'ok' }),
  })
  const ellipse = { kind: 'ellipse', x: 0, y: 0, w: 40, h: 40 } as const
  await router.saveAll([], [{ items: [{ id: 'shape', op: 'add', shape: ellipse }] }])
  const document = live(persisted)[0]?.document
  router.restore(JSON.parse(JSON.stringify(saved)))
  await router.reconcile()
  expect(live(persisted)[0]?.document).toBe(document)
  const edited = JSON.parse(JSON.stringify(saved))
  edited[0].region.document.items[0].shape.w = 20
  router.restore(edited)
  await router.reconcile()
  expect(live(persisted)[0]?.document).toEqual({
    items: [{ id: 'shape', op: 'add', shape: { ...ellipse, w: 20 } }],
  })
})
