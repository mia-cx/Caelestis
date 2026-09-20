import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_RASTER_BITS,
  MAX_REGION_ITEMS,
  millis,
  packBits,
  REGION_CLAIM_TTL_MS,
  type RegionClaim,
  type RegionDocument,
  type RegionShape,
  regionDocumentBounds,
  uuidV7,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { RegionClaim as RegionClaimSchema } from '@caelestis/wire-schema'
import { Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { D1SqlStore } from '../adapters/cloudflare/d1-sql-store.js'
import { SqliteD1Database } from '../adapters/cloudflare/sqlite-d1.test-helper.js'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { type SqlStoreHarness, sqlStoreAdapters } from '../adapters/sql-store.test-helper.js'
import { createApp } from '../app.js'
import { hashToken } from '../auth/tokens.js'
import { makeBackendContext } from '../runtime/backend-runtime.js'

const actor = { wplaceUserId: 1, displayName: 'Mia' }
const other = { wplaceUserId: 2, displayName: 'Dawn' }
const star: RegionShape = { kind: 'star', cx: 30, cy: 40, r: 20, inner: 8, points: 5, rotation: 90 }
const rectangle: RegionShape = { kind: 'rectangle', x: 0, y: 0, w: 8, h: 8 }
const documentOf = (shape: RegionShape): RegionDocument => ({
  items: [{ id: 'shape', shape, op: 'add' }],
})
const document: RegionDocument = {
  items: [
    { id: 'star', shape: star, op: 'add' },
    {
      id: 'cutout',
      shape: { kind: 'rectangle', x: 1_000, y: 1_000, w: 8, h: 8 },
      op: 'subtract',
    },
    {
      id: 'stroke',
      shape: {
        kind: 'path',
        nodes: [
          { x: 60.5, y: 70.25, out: { x: 90.75, y: 80 } },
          { x: 100, y: 110, in: { x: 95, y: 120.5 } },
        ],
        closed: false,
        width: 3.5,
      },
      op: 'add',
    },
  ],
}
let database: SqliteD1Database | undefined
let portable: SqlStoreHarness | undefined
afterEach(async () => {
  await portable?.close()
  portable = undefined
  database?.close()
  database = undefined
})

const setup = async (adapter: string) => {
  if (adapter === 'd1') database = new SqliteD1Database()
  if (adapter !== 'memory' && adapter !== 'd1') {
    const harness = sqlStoreAdapters.find((candidate) => candidate.name === adapter)
    if (!harness) throw new Error(`Unknown adapter ${adapter}`)
    portable = await harness.make()
  }
  const sql =
    portable?.store ??
    (database === undefined
      ? new MemorySqlStore()
      : new D1SqlStore(database as unknown as D1Database))
  const publishRegions = vi.fn(async () => {})
  const app = createApp(
    makeBackendContext(
      new MemoryBlobStore(),
      sql,
      new MemoryCounterStore(sql, () => millis(Date.now())),
      undefined,
      { publishRegions },
    ),
    { bootstrapAdminToken: 'admin' },
  )
  for (const scope of ['read', 'report'] as const)
    await sql.insertAccessToken({
      tokenHash: await hashToken(scope),
      label: scope,
      scope,
      createdWithToken: 'a'.repeat(64),
      createdAt: millis(Date.now()),
    })
  await sql.insertAccessToken({
    tokenHash: await hashToken('second-report'),
    label: 'second report',
    scope: 'report',
    createdWithToken: 'a'.repeat(64),
    createdAt: millis(Date.now()),
  })
  const templateId = uuidV7()
  await sql.insertTemplateVersion({
    templateId,
    versionId: uuidV7(),
    season: 0,
    surface: WORLD_TEMPLATE_SURFACE,
    nodeId: null,
    name: 'Box art',
    createdWithToken: 'a'.repeat(64),
    createdByUserId: null,
    createdAt: millis(Date.now()),
    bbox: { minX: 0, minY: 0, maxX: 8, maxY: 8 },
    totalPixels: 1,
    chunks: [{ tileX: 0, tileY: 0, hash: 'b'.repeat(64) }],
  })
  const body = {
    templateId,
    actor,
    document: documentOf(rectangle),
    label: '',
  }
  const call = (method: string, id: string, body: unknown, token = 'report', query = 'season=0') =>
    app.request(`/v1/work/regions/${id}?${query}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(
        method === 'DELETE' && typeof body === 'object' && body !== null
          ? { withdraw: false, ...body }
          : body,
      ),
    })
  return { app, sql, publishRegions, body, call }
}

it('replaces the production incident guard without allowing stale writes between steps', async () => {
  const h = await setup('d1')
  const id = '01a0b5c7-c8c4-7f3e-8185-1cc456d040ff'
  database?.sqlite.exec(`CREATE TRIGGER incident_20260919_retired_claims
    BEFORE INSERT ON work_regions WHEN NEW.id = '${id}' BEGIN SELECT RAISE(IGNORE); END;`)
  const sql = readFileSync(
    join(import.meta.dirname, '../../../../scripts/retire-20260919-claims.sql'),
    'utf8',
  )
  for (let retry = 0; retry < 2; retry++) {
    for (const statement of sql.split('--> statement-breakpoint')) {
      database?.sqlite.exec(statement)
      database?.sqlite.prepare('DELETE FROM work_regions WHERE expires_at <= ?').run(Date.now())
      database?.sqlite
        .prepare(`INSERT INTO work_regions
          (id, season, surface_kind, claimant_user_id, claimant_name, x, y, w, h, label, created_at, expires_at)
          VALUES (?, 0, 'world', 1, 'Mia', 0, 0, 8, 8, '', 0, ?) ON CONFLICT(id) DO NOTHING`)
        .run(id, Date.now() + REGION_CLAIM_TTL_MS)
      expect(
        database?.sqlite.prepare('SELECT id FROM work_regions WHERE id = ?').get(id),
      ).toBeUndefined()
      expect([409, 410]).toContain((await h.call('PUT', id, h.body)).status)
      expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([])
    }
  }
  expect((await h.call('PUT', id, h.body)).status).toBe(410)
  const reopened = new D1SqlStore(database as unknown as D1Database)
  expect(await reopened.regions.isRegionDeleted(id)).toBe(true)
  expect((await h.call('PUT', uuidV7(), h.body)).status).toBe(200)
})

it('keeps terminal deletion hidden and irreversible through preceding-binary SQL', async () => {
  const h = await setup('d1')
  const id = uuidV7()
  await h.call('PUT', id, h.body)
  const row = database?.sqlite.prepare('SELECT * FROM work_regions WHERE id = ?').get(id)
  expect(row).toBeDefined()
  await h.call('DELETE', id, { actor })
  // The preceding binary has no state predicate on reads, updates, or expiry deletion.
  expect(
    database?.sqlite.prepare('SELECT * FROM work_regions WHERE id = ?').get(id),
  ).toBeUndefined()
  database?.sqlite.prepare('UPDATE work_regions SET label = ? WHERE id = ?').run('stale', id)
  database?.sqlite
    .prepare('DELETE FROM work_regions WHERE expires_at <= ?')
    .run(Date.now() + REGION_CLAIM_TTL_MS)
  if (row === undefined) throw new Error('missing original claim')
  const columns = Object.keys(row).filter((column) => column !== 'state')
  database?.sqlite
    .prepare(
      `INSERT INTO work_regions (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT(id) DO NOTHING`,
    )
    .run(...columns.map((column) => row[column] ?? null))
  expect(
    database?.sqlite.prepare('SELECT * FROM work_regions WHERE id = ?').get(id),
  ).toBeUndefined()
  expect(await h.sql.regions.isRegionDeleted(id)).toBe(true)
  expect((await h.call('PUT', id, h.body)).status).toBe(410)
})

describe.each([
  'memory',
  'd1',
  ...sqlStoreAdapters
    .filter(({ name }) => name !== 'memory' && name !== 'D1')
    .map(({ name }) => name),
])('region routes on %s', (adapter) => {
  it('keeps unmarked legacy DELETE requests reversible for old replica routing', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    await h.call('PUT', id, h.body)
    const response = await h.app.request(`/v1/work/regions/${id}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer report', 'content-type': 'application/json' },
      body: JSON.stringify({ actor }),
    })
    expect(response.status).toBe(200)
    expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([])
    expect((await h.call('PUT', id, h.body)).status).toBe(200)
  })

  it('keeps deletion authoritative against stale client PUTs and concurrent retries', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    expect((await h.call('PUT', id, h.body)).status).toBe(200)
    expect((await h.call('DELETE', id, { actor })).status).toBe(200)
    const retries = await Promise.all(Array.from({ length: 4 }, () => h.call('PUT', id, h.body)))
    expect(retries.map((response) => response.status)).toEqual([410, 410, 410, 410])
    expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([])
    expect(h.publishRegions).toHaveBeenCalledTimes(2)
  })

  it('allows owned replica reconnection but never withdraws a terminal deletion', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    await h.call('PUT', id, h.body)
    expect((await h.call('DELETE', id, { actor, withdraw: true })).status).toBe(200)
    expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([])
    expect((await h.call('PUT', id, h.body, 'second-report')).status).toBe(403)
    expect((await h.call('PUT', id, h.body)).status).toBe(200)
    await h.call('DELETE', id, { actor, withdraw: true })
    // The owner can delete a claim even after another browser withdraws its replica.
    expect((await h.call('DELETE', id, { actor })).status).toBe(200)
    expect((await h.call('DELETE', id, { actor, withdraw: true })).status).toBe(404)
    expect((await h.call('PUT', id, h.body)).status).toBe(410)
  })

  it('does not let missing or unauthorized deletes retire an identity', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    expect((await h.call('DELETE', id, { actor })).status).toBe(404)
    expect((await h.call('PUT', id, h.body)).status).toBe(200)
    expect((await h.call('DELETE', id, { actor: other })).status).toBe(403)
    expect((await h.call('PUT', id, h.body)).status).toBe(200)
  })

  it('clears the same painter across tokens without authorizing edits or withdrawal', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    await h.call('PUT', id, h.body)
    expect((await h.call('PUT', id, h.body, 'second-report')).status).toBe(403)
    expect((await h.call('DELETE', id, { actor, withdraw: true }, 'second-report')).status).toBe(
      403,
    )
    expect((await h.call('DELETE', id, { actor }, 'read')).status).toBe(403)
    expect((await h.call('DELETE', id, { actor }, 'second-report')).status).toBe(200)
    expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([])
    expect((await h.call('PUT', id, h.body)).status).toBe(410)
  })

  it('allows a still-live claim to return after replica expiry but retains explicit deletions', async () => {
    const h = await setup(adapter)
    const expired = uuidV7(),
      deleted = uuidV7()
    await h.call('PUT', expired, h.body)
    await h.call('PUT', deleted, h.body)
    await h.call('DELETE', deleted, { actor })
    await h.sql.regions.expireRegions(Date.now() + REGION_CLAIM_TTL_MS + 1)
    expect((await h.call('PUT', expired, h.body)).status).toBe(200)
    expect((await h.call('PUT', deleted, h.body)).status).toBe(410)
  })

  it('rejects an in-flight update when deletion commits before its storage write', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    await h.call('PUT', id, h.body)
    let enter = () => {}
    let release = () => {}
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const resume = new Promise<void>((resolve) => {
      release = resolve
    })
    const update = h.sql.regions.updateRegion.bind(h.sql.regions)
    vi.spyOn(h.sql.regions, 'updateRegion').mockImplementationOnce(async (...args) => {
      enter()
      await resume
      return update(...args)
    })
    const stale = h.call('PUT', id, { ...h.body, label: 'Stale edit' })
    await entered
    expect((await h.call('DELETE', id, { actor })).status).toBe(200)
    release()
    expect((await stale).status).toBe(410)
    expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([])
  })

  it('reports ownership by credential and painter, with read-only mutation capability', async () => {
    const h = await setup(adapter)
    const owned = uuidV7(),
      foreign = uuidV7()
    await h.call('PUT', owned, h.body)
    await h.call('PUT', foreign, h.body, 'second-report')
    const response = await h.app.request(
      `/v1/work/regions?season=0&painterId=${actor.wplaceUserId}`,
      {
        headers: { authorization: 'Bearer report' },
      },
    )
    expect(await response.json()).toMatchObject({ ownedRegionIds: [owned], canWrite: true })
    const read = await h.app.request(`/v1/work/regions?season=0&painterId=${actor.wplaceUserId}`, {
      headers: { authorization: 'Bearer read' },
    })
    expect(await read.json()).toMatchObject({ ownedRegionIds: [], canWrite: false })
  })

  it('renews only the credential and painter owner and never revives expired claims', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    const response = await h.call('PUT', id, h.body)
    const region = (await response.json()) as RegionClaim
    const at = region.expiresAt as number
    const hash = await hashToken('report')
    await h.sql.regions.renewRegions(hash, other.wplaceUserId, at - 1000)
    await h.sql.regions.renewRegions(
      await hashToken('second-report'),
      actor.wplaceUserId,
      at - 1000,
    )
    expect((await h.sql.regions.readRegion(id))?.expiresAt).toBe(at)
    await h.sql.regions.renewRegions(hash, actor.wplaceUserId, at - 1000)
    const renewed = at - 1000 + REGION_CLAIM_TTL_MS
    expect((await h.sql.regions.readRegion(id))?.expiresAt).toBe(renewed)
    await h.sql.regions.renewRegions(hash, actor.wplaceUserId, renewed)
    expect(await h.sql.regions.readRegion(id)).toBeNull()
  })

  it('creates, lists, replays identical requests, rejects conflicts, and publishes mutations', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    const response = await h.call('PUT', id, h.body)
    expect(response.status).toBe(200)
    const region = (await response.json()) as RegionClaim
    expect(region).toMatchObject({
      id,
      season: 0,
      surface: WORLD_TEMPLATE_SURFACE,
      templateId: h.body.templateId,
      claimant: actor,
      document: h.body.document,
      rect: regionDocumentBounds(h.body.document),
      label: '',
    })
    const replay = await h.call('PUT', id, h.body)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(region)
    expect((await h.call('PUT', id, { ...h.body, actor: other })).status).toBe(403)
    const list = await h.app.request(`/work/regions?season=0&templateId=${h.body.templateId}`, {
      headers: { authorization: 'Bearer read' },
    })
    expect(await list.json()).toEqual({ regions: [region] })
    const absent = await h.app.request('/work/regions?season=1', {
      headers: { authorization: 'Bearer read' },
    })
    expect(await absent.json()).toEqual({ regions: [] })
    expect((await h.call('DELETE', id, { actor: other })).status).toBe(403)
    expect((await h.call('DELETE', id, { actor: other }, 'admin')).status).toBe(200)
    expect((await h.call('DELETE', id, { actor })).status).toBe(404)
    expect(h.publishRegions).toHaveBeenCalledTimes(3)
    expect(h.publishRegions).toHaveBeenLastCalledWith(0, WORLD_TEMPLATE_SURFACE)
  })

  it('binds editing and withdrawal to the creating credential while allowing admins', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    const response = await h.call('PUT', id, h.body)
    expect(response.status).toBe(200)
    const original = await response.json()
    expect(original).not.toHaveProperty('tokenHash')
    for (const method of ['PUT', 'DELETE']) {
      expect(
        (await h.call(method, id, { ...h.body, label: 'Forged', withdraw: true }, 'second-report'))
          .status,
      ).toBe(403)
      expect((await h.call(method, id, { ...h.body, actor: other })).status).toBe(403)
    }
    expect(await h.sql.regions.readRegion(id)).toEqual(original)
    expect(h.publishRegions).toHaveBeenCalledTimes(1)
    expect((await h.call('PUT', id, { ...h.body, label: 'Owner' })).status).toBe(200)
    expect(
      (await h.call('PUT', id, { ...h.body, actor: other, label: 'Admin' }, 'admin')).status,
    ).toBe(200)
    // Administrative edits do not transfer an existing credential's ownership.
    expect((await h.call('DELETE', id, { actor })).status).toBe(200)
    const nextId = uuidV7()
    expect((await h.call('PUT', nextId, h.body)).status).toBe(200)
    expect((await h.call('DELETE', nextId, { actor: other }, 'admin')).status).toBe(200)
  })

  it('allows one matching-actor writer to adopt an unowned legacy claim atomically', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    const legacy: RegionClaim = {
      id,
      season: 0,
      surface: WORLD_TEMPLATE_SURFACE,
      templateId: h.body.templateId,
      claimant: actor,
      document: h.body.document,
      rect: { x: 0, y: 0, w: 8, h: 8 },
      label: '',
      createdAt: Date.now(),
    }
    expect(await h.sql.regions.createRegion(legacy, null)).toBe(true)
    expect((await h.call('PUT', id, { ...h.body, actor: other })).status).toBe(403)
    expect((await h.call('DELETE', id, { actor: other })).status).toBe(403)
    const tokens = ['report', 'second-report']
    const responses = await Promise.all(tokens.map((token) => h.call('PUT', id, h.body, token)))
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403])
    const loser = tokens[responses.findIndex((response) => response.status === 403)]
    expect((await h.call('DELETE', id, { actor, withdraw: true }, loser)).status).toBe(403)
    expect((await h.call('DELETE', id, { actor }, loser)).status).toBe(200)
    const nextId = uuidV7()
    expect(await h.sql.regions.createRegion({ ...legacy, id: nextId }, null)).toBe(true)
    expect((await h.call('PUT', nextId, { ...h.body, actor: other }, 'admin')).status).toBe(200)
  })

  it('updates and clears the template hint with the same validation as creation', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    expect((await h.call('PUT', id, h.body)).status).toBe(200)
    expect((await h.call('PUT', id, { ...h.body, templateId: uuidV7() })).status).toBe(400)
    expect((await h.call('PUT', id, { ...h.body, templateId: null })).status).toBe(200)
    const list = await h.app.request(`/v1/work/regions?season=0&templateId=${h.body.templateId}`, {
      headers: { authorization: 'Bearer read' },
    })
    expect(await list.json()).toEqual({ regions: [] })
    expect((await h.sql.regions.readRegion(id))?.templateId).toBeNull()
    expect((await h.call('PUT', id, h.body)).status).toBe(200)
    expect((await h.sql.regions.readRegion(id))?.templateId).toBe(h.body.templateId)
  })

  it.each(['nodes', 'handles'])(
    'rejects an oversized subtract path with distant %s before storing it',
    async (extent) => {
      const h = await setup(adapter)
      const id = uuidV7()
      const response = await h.call('PUT', id, {
        ...h.body,
        document: {
          items: [
            { id: 'add', op: 'add', shape: { kind: 'rectangle', x: 0, y: 0, w: 1, h: 1 } },
            {
              id: 'subtract',
              op: 'subtract',
              shape: {
                kind: 'path',
                closed: false,
                width: 1,
                nodes:
                  extent === 'nodes'
                    ? [
                        { x: 0, y: 0 },
                        { x: 1_000_000, y: 1_000_000 },
                      ]
                    : [
                        { x: 0, y: 0, out: { x: 1_000_000, y: 1_000_000 } },
                        { x: 1, y: 1 },
                      ],
              },
            },
          ],
        },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Invalid region request' })
      expect(await h.sql.regions.readRegion(id)).toBeNull()
      expect(h.publishRegions).not.toHaveBeenCalled()
    },
  )

  it.each(['PUT', 'DELETE'])(
    'rejects oversized %s bodies before reading declared bytes and cancels chunked overflow',
    async (method) => {
      const h = await setup(adapter)
      const limit =
        method === 'PUT'
          ? 16_384 + MAX_REGION_ITEMS * Math.ceil(Math.ceil(MAX_RASTER_BITS / 8) / 3) * 4
          : 16_384
      const url = `https://example.com/v1/work/regions/${uuidV7()}?season=0`
      const headers = { authorization: 'Bearer report', 'content-type': 'application/json' }
      const pull = vi.fn()
      const declared = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 })
      const declaredInit = {
        method,
        headers: { ...headers, 'content-length': String(limit + 1) },
        body: declared,
        duplex: 'half',
      }
      expect((await h.app.request(new Request(url, declaredInit))).status).toBe(413)
      expect(pull).not.toHaveBeenCalled()
      await declared.cancel()

      const cancel = vi.fn()
      const chunks = [
        new TextEncoder().encode('é'.repeat(Math.floor(limit / 2))),
        new Uint8Array(2),
      ]
      let reads = 0
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const chunk = chunks[reads++]
            if (chunk === undefined) throw new Error('Read beyond byte limit')
            controller.enqueue(chunk)
          },
          cancel,
        },
        { highWaterMark: 0 },
      )
      const chunkedInit = { method, headers, body: stream, duplex: 'half' }
      expect((await h.app.request(new Request(url, chunkedInit))).status).toBe(413)
      expect(reads).toBe(2)
      expect(cancel).toHaveBeenCalledOnce()
      expect(h.publishRegions).not.toHaveBeenCalled()
    },
  )

  it.each([{}, { templateId: null }])(
    'creates, lists, reads, and broadcasts a standalone claim with hint %j',
    async (hint) => {
      const h = await setup(adapter)
      const id = uuidV7()
      const publications: unknown[] = []
      h.publishRegions.mockImplementation(async () => {
        publications.push(await h.sql.regions.listRegions(1, WORLD_TEMPLATE_SURFACE))
      })
      const response = await h.call(
        'PUT',
        id,
        { ...hint, actor, document, label: 'Canvas claim' },
        'report',
        'season=1',
      )
      expect(response.status).toBe(200)
      const region = Schema.decodeUnknownSync(RegionClaimSchema)(await response.json())
      expect(region).toMatchObject({ id, season: 1, templateId: null, document })
      expect(await h.sql.regions.readRegion(id)).toEqual(region)
      const list = await h.app.request('/work/regions?season=1', {
        headers: { authorization: 'Bearer read' },
      })
      expect(list.status).toBe(200)
      expect(await list.json()).toEqual({ regions: [region] })
      const filtered = await h.app.request(
        `/work/regions?season=1&templateId=${h.body.templateId}`,
        { headers: { authorization: 'Bearer read' } },
      )
      expect(await filtered.json()).toEqual({ regions: [] })
      expect(publications).toEqual([[region]])
      expect(h.publishRegions).toHaveBeenCalledExactlyOnceWith(1, WORLD_TEMPLATE_SURFACE)
      if (database !== undefined)
        expect(
          database.sqlite.prepare('SELECT template_id FROM work_regions WHERE id = ?').get(id),
        ).toEqual({ template_id: null })
    },
  )

  it('rejects a hint for a missing template', async () => {
    const h = await setup(adapter)
    const response = await h.call('PUT', uuidV7(), { ...h.body, templateId: uuidV7() })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'Template is missing or belongs to another drawing surface',
    })
    expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([])
    expect(h.publishRegions).not.toHaveBeenCalled()
  })

  it('saves and updates a raster document with its mask and derived bounds', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    for (const shape of [
      {
        kind: 'pixels',
        x: 10,
        y: 20,
        w: 3,
        h: 3,
        mask: packBits(Uint8Array.of(1, 0, 1, 0, 1, 0, 1, 0, 1)),
      },
      {
        kind: 'pixels',
        x: 30,
        y: 40,
        w: 512,
        h: 512,
        mask: packBits(new Uint8Array(MAX_RASTER_BITS).fill(1)),
      },
    ] as const) {
      const document = documentOf(shape)
      const response = await h.call('PUT', id, { ...h.body, document })
      expect(response.status).toBe(200)
      const region = Schema.decodeUnknownSync(RegionClaimSchema)(await response.json())
      expect(region).toMatchObject({
        document,
        rect: { x: shape.x, y: shape.y, w: shape.w, h: shape.h },
      })
      expect(await h.sql.regions.readRegion(id)).toEqual(region)
      const list = await h.app.request('/v1/work/regions?season=0', {
        headers: { authorization: 'Bearer read' },
      })
      expect(list.status).toBe(200)
      expect(await list.json()).toEqual({ regions: [region] })
    }
    expect(h.publishRegions).toHaveBeenCalledTimes(2)
  })

  it('rejects a raster document with a wrong-length mask', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    const response = await h.call('PUT', id, {
      ...h.body,
      document: documentOf({ kind: 'pixels', x: 10, y: 20, w: 8, h: 8, mask: 'gA==' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid region request' })
    expect(await h.sql.regions.readRegion(id)).toBeNull()
    expect(h.publishRegions).not.toHaveBeenCalled()
  })

  it('round-trips a star, subtraction, and stroked path with derived bounds', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    const response = await h.call('PUT', id, { ...h.body, document })
    expect(response.status).toBe(200)
    const region = Schema.decodeUnknownSync(RegionClaimSchema)(await response.json())
    expect(region).toMatchObject({ document, rect: regionDocumentBounds(document) })
    expect(await h.sql.regions.readRegion(id)).toEqual(region)
    expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([region])
    if (database !== undefined) {
      expect(
        database.sqlite.prepare('SELECT shape, x, y, w, h FROM work_regions WHERE id = ?').get(id),
      ).toEqual({ shape: JSON.stringify(region.document), ...regionDocumentBounds(document) })
    }
  })

  it.each(['report', 'admin'])(
    'updates document and label in place as %s and broadcasts',
    async (token) => {
      const h = await setup(adapter)
      const id = uuidV7()
      const original = Schema.decodeUnknownSync(RegionClaimSchema)(
        await (await h.call('PUT', id, h.body)).json(),
      )
      const publications: unknown[] = []
      h.publishRegions.mockImplementation(async () => {
        publications.push(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE))
      })
      const response = await h.call(
        'PUT',
        id,
        {
          ...h.body,
          actor: token === 'admin' ? other : { ...actor, displayName: 'New name' },
          document,
          label: 'Star work',
        },
        token,
      )
      expect(response.status).toBe(200)
      const updated = {
        ...original,
        document,
        rect: regionDocumentBounds(document),
        label: 'Star work',
      }
      expect(await response.json()).toEqual(updated)
      expect(await h.sql.regions.readRegion(id)).toEqual(updated)
      expect(publications).toEqual([[updated]])
      expect(h.publishRegions).toHaveBeenCalledTimes(2)
    },
  )

  it('rejects an ellipse outside the surface and an out-of-range radius with 400', async () => {
    const h = await setup(adapter)
    const outside = await h.call('PUT', uuidV7(), {
      ...h.body,
      document: documentOf({ kind: 'ellipse', x: WORLD_PIXELS - 1, y: 0, w: 8, h: 8 }),
    })
    expect(outside.status).toBe(400)
    expect(await outside.json()).toEqual({ error: 'Region is outside the drawing surface' })
    const invalid = await h.call('PUT', uuidV7(), {
      ...h.body,
      document: documentOf({ ...star, r: 1_001 }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'Invalid region request' })
    expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([])
    expect(h.publishRegions).not.toHaveBeenCalled()
  })

  it('validates scope, identity, template membership, rect bounds and area, and label length', async () => {
    const h = await setup(adapter)
    expect((await h.call('PUT', uuidV7(), h.body, 'read')).status).toBe(403)
    for (const body of [
      { ...h.body, document: documentOf({ ...rectangle, x: WORLD_PIXELS }) },
      { ...h.body, document: documentOf({ ...rectangle, w: 2_001, h: 2_000 }) },
      { ...h.body, document: documentOf({ ...rectangle, x: -1 }) },
      { ...h.body, label: 'x'.repeat(65) },
      { ...h.body, actor: { ...actor, displayName: '' } },
      { ...h.body, templateId: 'bad' },
    ])
      expect((await h.call('PUT', uuidV7(), body)).status).toBe(400)
    expect((await h.call('PUT', uuidV7(), h.body, 'report', 'season=1')).status).toBe(400)
    expect(
      (
        await h.call(
          'PUT',
          uuidV7(),
          h.body,
          'report',
          'season=0&surface=alliance-picture&allianceId=1',
        )
      ).status,
    ).toBe(400)
    expect(
      (await h.call('PUT', uuidV7(), h.body, 'report', 'season=0&allianceId=bad')).status,
    ).toBe(400)
    expect(h.publishRegions).not.toHaveBeenCalled()
  })

  it('keeps conflicting concurrent IDs immutable and lists every claim on a surface', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    const responses = await Promise.all(
      [actor, other].map((actor) => h.call('PUT', id, { ...h.body, actor })),
    )
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403])
    const region = await h.sql.regions.readRegion(id)
    if (region === null) throw new Error('Missing region')
    // No cap on how many claims a surface holds: every one is stored and listed in order.
    const extra = 600
    for (let i = 1; i <= extra; i++)
      expect(
        await h.sql.regions.createRegion({ ...region, id: uuidV7(), createdAt: i }, null),
      ).toBe(true)
    expect(await h.sql.regions.createRegion({ ...region, id }, null)).toBe(false)
    const list = await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)
    expect(list).toHaveLength(extra + 1)
    expect(list[0]?.createdAt).toBe(1)
    expect((await h.call('PUT', uuidV7(), h.body)).status).toBe(200)
    expect((await h.call('DELETE', id, { actor: region.claimant })).status).toBe(200)
  })

  it('rejects documents containing only subtractions without changing an existing claim', async () => {
    const h = await setup(adapter)
    const id = uuidV7()
    const original = Schema.decodeUnknownSync(RegionClaimSchema)(
      await (await h.call('PUT', id, h.body)).json(),
    )
    for (const target of [id, uuidV7()]) {
      const response = await h.call('PUT', target, {
        ...h.body,
        document: { items: [{ id: 'cutout', shape: star, op: 'subtract' }] },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'Region document must contain an added shape',
      })
    }
    expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([original])
    expect(h.publishRegions).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      items: [
        { id: 'rectangle', shape: rectangle, op: 'add' },
        { id: 'cutout', shape: rectangle, op: 'subtract' },
      ],
    },
    documentOf({ kind: 'pixels', x: 0, y: 0, w: 8, h: 8, mask: packBits(new Uint8Array(64)) }),
  ] satisfies RegionDocument[])(
    'rejects an empty claim without saving or replacing a region: %j',
    async (document) => {
      const h = await setup(adapter)
      const id = uuidV7()
      const saved = await h.call('PUT', id, h.body)
      expect(saved.status).toBe(200)
      const original = Schema.decodeUnknownSync(RegionClaimSchema)(await saved.json())
      for (const target of [id, uuidV7()]) {
        const response = await h.call('PUT', target, { ...h.body, document })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Region claims no pixels' })
      }
      expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([original])
      expect(h.publishRegions).toHaveBeenCalledTimes(1)
    },
  )

  it('rejects a document whose added shapes span more than the region area limit', async () => {
    const h = await setup(adapter)
    const response = await h.call('PUT', uuidV7(), {
      ...h.body,
      document: {
        items: [
          { id: 'first', shape: rectangle, op: 'add' },
          { id: 'second', shape: { ...rectangle, x: 2_000, y: 2_000 }, op: 'add' },
        ],
      },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Region area exceeds limit' })
    expect(h.publishRegions).not.toHaveBeenCalled()
  })
})

it.each([null, '{', 'null', JSON.stringify({ ...star, inner: star.r }), '{"items":[]}'])(
  'reads a legacy rectangle when stored shape is %s',
  async (shape) => {
    const h = await setup('d1')
    const id = uuidV7()
    const original = Schema.decodeUnknownSync(RegionClaimSchema)(
      await (await h.call('PUT', id, h.body)).json(),
    )
    database?.sqlite.prepare('UPDATE work_regions SET shape = ? WHERE id = ?').run(shape, id)
    const region = {
      ...original,
      document: { items: [{ id: 'legacy', shape: rectangle, op: 'add' }] },
    }
    expect(await h.sql.regions.readRegion(id)).toEqual(region)
    expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([region])
  },
)

it('assigns finite expiry to rows an old binary writes after migration', async () => {
  const h = await setup('d1')
  const id = uuidV7()
  const original = Schema.decodeUnknownSync(RegionClaimSchema)(
    await (await h.call('PUT', id, h.body)).json(),
  )
  database?.sqlite.prepare('UPDATE work_regions SET expires_at = NULL WHERE id = ?').run(id)
  expect((await h.sql.regions.readRegion(id))?.expiresAt).toBe(
    original.createdAt + REGION_CLAIM_TTL_MS,
  )
  database?.sqlite.prepare('UPDATE work_regions SET expires_at = NULL WHERE id = ?').run(id)
  await h.sql.regions.renewRegions(
    await hashToken('report'),
    actor.wplaceUserId,
    original.createdAt + 1_000,
  )
  expect((await h.sql.regions.readRegion(id))?.expiresAt).toBe(
    original.createdAt + 1_000 + REGION_CLAIM_TTL_MS,
  )
  database?.sqlite.prepare('UPDATE work_regions SET expires_at = NULL WHERE id = ?').run(id)
  await h.sql.regions.expireRegions(original.createdAt + REGION_CLAIM_TTL_MS)
  expect(await h.sql.regions.readRegion(id)).toBeNull()
})

it('wraps a legacy single-shape row in a document', async () => {
  const h = await setup('d1')
  const id = uuidV7()
  const original = Schema.decodeUnknownSync(RegionClaimSchema)(
    await (await h.call('PUT', id, { ...h.body, document: documentOf(star) })).json(),
  )
  database?.sqlite
    .prepare('UPDATE work_regions SET shape = ? WHERE id = ?')
    .run(JSON.stringify(star), id)
  const region = {
    ...original,
    document: { items: [{ id: 'legacy', shape: star, op: 'add' }] },
  }
  expect(await h.sql.regions.readRegion(id)).toEqual(region)
  expect(await h.sql.regions.listRegions(0, WORLD_TEMPLATE_SURFACE)).toEqual([region])
})
