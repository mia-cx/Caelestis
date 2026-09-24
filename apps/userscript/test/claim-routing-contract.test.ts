import type { RegionClaim, RegionDocument } from '@caelestis/shared'
import { expect, it, vi } from 'vitest'
import type { ConnectedServer } from '../src/state.js'

vi.mock('../src/presence-client.js', () => ({ presenceCanWriteClaims: () => true }))

import { ClaimRouter } from '../src/claim-routing.js'

it('retains delivery intent across reload, ignores unchanged snapshot churn, and retries terminal deletion', async () => {
  const server: ConnectedServer = {
    url: 'https://claims.test',
    token: 'report',
    status: 'connected',
    season: 3,
    isAdmin: false,
    info: { id: 'claims', name: 'Claims', auth: 'access_token', presence: 1 },
  }
  const actor = { wplaceUserId: 42, displayName: 'Painter' }
  const document: RegionDocument = {
    items: [{ id: 'shape', op: 'add', shape: { kind: 'rectangle', x: 0, y: 0, w: 2, h: 2 } }],
  }
  let saved: ConstructorParameters<typeof ClaimRouter>[1] = []
  let regions: RegionClaim[] = []
  let revision = 0
  let unavailable = true
  const writes: Array<{ method: string; id: string; withdraw?: boolean }> = []
  const host: ConstructorParameters<typeof ClaimRouter>[0] = {
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
    retired: () => false,
    retire: () => {},
    put: async (_server, region) => {
      writes.push({ method: 'PUT', id: region.id })
      if (unavailable) return 'offline'
      regions = [structuredClone(region)]
      return null
    },
    remove: async (_server, region, _signal, withdraw) => {
      writes.push({ method: 'DELETE', id: region.id, withdraw })
      if (unavailable) return 'offline'
      regions = []
      return null
    },
  }
  let router = new ClaimRouter(host)
  expect(await router.save(null, document)).toContain('offline')
  const id = router.mine()[0]?.id
  expect(id).toBeDefined()
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
  expect(router.mine()).toEqual([])
  router = new ClaimRouter(host, saved)
  unavailable = false
  await router.reconcile()
  expect(regions).toEqual([])
  expect(writes).toEqual([
    { method: 'DELETE', id, withdraw: false },
    { method: 'DELETE', id, withdraw: false },
  ])
})
