import { encodeIndexedPng, millis, seconds, sha256Hex, TRANSPARENT_INDEX } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemorySqlStore } from '../src/adapters/memory/memory-sql-store.js'
import { DirectStatusReadModel } from '../src/status-read-model/port.js'
import { adminToken, createTestBackend } from './support/backend.js'
import { openRelationalStore } from './support/relational.js'

const id = '01890f3e-7b2c-7abc-8def-012345678901'
const hash = 'a'.repeat(64)
type Backend = Awaited<ReturnType<typeof createTestBackend>>
const request = (backend: Backend, path: string, method = 'GET', token?: string, body?: unknown) =>
  backend.app.fetch(
    new Request(`https://backend.test${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

const mint = async (backend: Backend, scope: 'read' | 'report', token = adminToken) => {
  const response = await request(backend, '/admin/tokens', 'POST', token, { label: scope, scope })
  expect(response.status).toBe(201)
  const value = (await response.json()) as { token: string; tokenHash: string }
  expect(value.token).toEqual(expect.any(String))
  expect(value.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  return value
}

const reads = [
  '/manifest',
  `/chunks/${hash}`,
  `/sources/${hash}`,
  `/recipes/${id}`,
  `/tiles/${hash}`,
  `/archive/templates/${id}`,
  `/archive/tiles/${hash}`,
  '/work?season=3',
  '/work/regions?season=3',
  `/work/${id}/history`,
  '/telemetry/status',
  '/telemetry/alarms',
  '/telemetry/canvas',
  '/telemetry/presence/online',
  '/telemetry/history',
  '/telemetry/painter-history',
  '/telemetry/painters',
  '/telemetry/contributions',
  '/telemetry/leaderboard',
  '/telemetry/tiles/0/0/history',
  `/telemetry/progress/${id}`,
  `/telemetry/templates/${id}/versions/${id}/tiles/0/0/mismatches`,
]
const adminOperations = [
  ['PATCH', '/admin/server'],
  ['GET', '/admin/tokens'],
  ['POST', '/admin/tokens'],
  ['DELETE', `/admin/tokens/${hash}`],
  ['GET', '/admin/nodes'],
  ['POST', '/admin/nodes'],
  ['PATCH', `/admin/nodes/${id}`],
  ['GET', `/admin/nodes/${id}/subtree`],
  ['DELETE', `/admin/nodes/${id}`],
  ['POST', '/admin/templates'],
  ['POST', `/admin/templates/${id}/versions`],
  ['PATCH', `/admin/templates/${id}`],
  ['DELETE', `/admin/templates/${id}`],
  ['DELETE', `/admin/templates/${id}/alarms/${id}`],
  ['GET', '/admin/tags'],
  ['POST', '/admin/tags'],
  ['PATCH', `/admin/tags/${id}`],
  ['DELETE', `/admin/tags/${id}`],
  ['PUT', `/admin/tags/${id}/templates/${id}`],
  ['DELETE', `/admin/tags/${id}/templates/${id}`],
  ['PUT', `/admin/tags/${id}/folders/${id}`],
  ['DELETE', `/admin/tags/${id}/folders/${id}`],
  ['GET', `/admin/backfill/${id}/preview`],
  ['GET', `/admin/backfill/${id}/job`],
  ['POST', `/admin/backfill/${id}/start`],
  ['POST', `/admin/backfill/${id}/cancel`],
  ['GET', '/admin/archive'],
  ['POST', '/admin/archive/export'],
  ['GET', '/admin/archive/export'],
  ['DELETE', '/admin/archive/export'],
  ['POST', '/admin/archive/import'],
  ['POST', '/admin/archive/import/records?position=1'],
  ['POST', '/admin/archive/import/activate'],
  ['DELETE', '/admin/archive/import'],
] as const
const reportOperations = [
  ['POST', '/telemetry/paints'],
  ['POST', '/telemetry/tiles/offers'],
  ['PUT', `/telemetry/tiles/0/0/${hash}`],
  ['PUT', `/work/${id}`],
  ['PUT', `/work/regions/${id}`],
  ['DELETE', `/work/regions/${id}`],
] as const

afterEach(() => vi.restoreAllMocks())

describe('backend API trust boundary', () => {
  it('admits permitted scopes to every protected route at both API prefixes', async () => {
    const backend = await createTestBackend()
    const read = await mint(backend, 'read')
    const report = await mint(backend, 'report')
    for (const prefix of ['', '/v1']) {
      const operations = [
        ...reads.flatMap((path) =>
          [read.token, report.token, adminToken].map((token) => ({ method: 'GET', path, token })),
        ),
        ...adminOperations.map(([method, path]) => ({ method, path, token: adminToken })),
        ...reportOperations.flatMap(([method, path]) =>
          [report.token, adminToken].map((token) => ({ method, path, token })),
        ),
      ]
      for (const { method, path, token } of operations) {
        const response = await request(backend, prefix + path, method, token)
        // Missing records/bodies can fail validation. Authentication must still admit the scope.
        // Populated successful operations are covered in the real client and route contracts.
        expect([401, 403, 500], `${method} ${prefix}${path}`).not.toContain(response.status)
      }
    }
  })

  it('requires authentication on every protected read at both API prefixes', async () => {
    const backend = await createTestBackend()
    for (const prefix of ['', '/v1']) {
      for (const path of reads) {
        const response = await request(backend, prefix + path)
        expect(response.status, prefix + path).toBe(401)
        expect(await response.json()).toEqual({ error: 'unauthorized' })
      }
    }
  })

  it('keeps every administration operation inaccessible to read and report credentials', async () => {
    const backend = await createTestBackend({ openAccess: true })
    const read = await mint(backend, 'read')
    const report = await mint(backend, 'report')
    for (const [method, path] of adminOperations) {
      for (const token of [undefined, read.token, report.token]) {
        const response = await request(backend, `/v1${path}`, method, token)
        expect(response.status, `${method} ${path}`).toBe(token === undefined ? 401 : 403)
        expect(await response.json()).toEqual({
          error: token === undefined ? 'unauthorized' : 'forbidden',
        })
      }
    }
  })

  it('keeps every reporting operation inaccessible to anonymous and read-only callers', async () => {
    const backend = await createTestBackend({ openAccess: true })
    const read = await mint(backend, 'read')
    for (const [method, path] of reportOperations) {
      for (const token of [undefined, read.token]) {
        const response = await request(backend, path, method, token)
        expect(response.status, `${method} ${path}`).toBe(token === undefined ? 401 : 403)
      }
    }
  })

  it('supports cross-origin authorization and exposes conditional-read headers to browser clients', async () => {
    const backend = await createTestBackend({ openAccess: true })
    const preflight = await backend.app.fetch(
      new Request('https://backend.test/v1/admin/templates', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://wplace.live',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      }),
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    )
    const manifest = await request(backend, '/v1/manifest')
    expect(manifest.status).toBe(200)
    expect(manifest.headers.get('access-control-expose-headers')).toContain('ETag')
    const etag = manifest.headers.get('etag')
    if (etag === null) throw new Error('manifest omitted its ETag')
    const cached = await backend.app.fetch(
      new Request('https://backend.test/v1/manifest', {
        headers: { 'if-none-match': etag, origin: 'https://wplace.live' },
      }),
    )
    expect(cached.status).toBe(304)
    expect(await cached.text()).toBe('')
    expect((await request(backend, '/manifest', 'GET', 'revoked')).status).toBe(401)
  })

  it('revalidates the current season status per caller scope and answers a matching validator with 304', async () => {
    const backend = await createTestBackend()
    const reader = await mint(backend, 'read')
    const form = new FormData()
    form.set('png', new File([await encodeIndexedPng(1, 1, new Uint8Array([1]))], 'art.png'))
    form.set('name', 'Draft')
    form.set('season', '3')
    form.set('originX', '0')
    form.set('originY', '0')
    expect(
      (
        await backend.app.fetch(
          new Request('https://backend.test/admin/templates', {
            method: 'POST',
            headers: { authorization: `Bearer ${adminToken}` },
            body: form,
          }),
        )
      ).status,
    ).toBe(201)
    const status = async (token: string, validator?: string, season = 3) => {
      const response = await backend.app.fetch(
        new Request(`https://backend.test/v1/telemetry/status?season=${season}`, {
          headers: {
            authorization: `Bearer ${token}`,
            ...(validator === undefined ? {} : { 'if-none-match': validator }),
          },
        }),
      )
      return { response, etag: response.headers.get('etag') }
    }
    const first = await status(adminToken)
    expect(first.response.status).toBe(200)
    expect(first.response.headers.get('vary')).toContain('Authorization')
    if (first.etag === null) throw new Error('status omitted its ETag')
    for (const validator of [first.etag, `"other", W/${first.etag}`, '*']) {
      const cached = await status(adminToken, validator)
      expect(cached.response.status, validator).toBe(304)
      expect(cached.etag).toBe(first.etag)
      expect(await cached.response.text()).toBe('')
    }
    // Admins see drafts, so the public projection at the same revision needs its own validator.
    const published = await status(reader.token, first.etag)
    expect(published.response.status).toBe(200)
    expect(published.etag).not.toBe(first.etag)

    // A painted pixel commits a new status, and the old validator no longer matches.
    const indices = new Uint8Array(1_000_000).fill(TRANSPARENT_INDEX)
    indices[0] = 1
    const canvas = await encodeIndexedPng(1000, 1000, indices)
    const uploaded = await backend.app.fetch(
      new Request(`https://backend.test/v1/telemetry/tiles/0/0/${await sha256Hex(canvas)}`, {
        method: 'PUT',
        body: canvas,
        headers: {
          authorization: `Bearer ${adminToken}`,
          'x-caelestis-season': '3',
          'x-caelestis-observed-at': String(Math.floor(Date.now() / 1000) - 10),
          'x-caelestis-wplace-user-id': '42',
          'x-caelestis-display-name': 'Painter',
        },
      }),
    )
    expect(uploaded.status).toBe(200)
    const changed = await status(adminToken, first.etag)
    expect(changed.response.status).toBe(200)
    expect(changed.etag).not.toBe(first.etag)
    expect(await changed.response.json()).toMatchObject({
      templates: [expect.objectContaining({ correct: 1 })],
    })

    // Earlier seasons are read straight from the database and carry no validator.
    const historical = await status(adminToken, '*', 2)
    expect(historical.response.status).toBe(200)
    expect(historical.etag).toBeNull()
  })

  for (const change of ['unpublished', 'moved'] as const)
    it(`hides tile history once its template is ${change}, even when the manifest cache misses it`, async () => {
      let invalidation = true
      const backend = await createTestBackend({
        statusReadModel: (sql) =>
          new (class extends DirectStatusReadModel {
            override async notifyManifestChange(
              ...args: Parameters<DirectStatusReadModel['notifyManifestChange']>
            ): Promise<void> {
              if (!invalidation) throw new Error('manifest invalidation lost')
              await super.notifyManifestChange(...args)
            }
          })(sql),
      })
      const reader = await mint(backend, 'read')
      const form = new FormData()
      form.set('png', new File([await encodeIndexedPng(1, 1, new Uint8Array([1]))], 'art.png'))
      form.set('name', 'Published')
      form.set('season', '3')
      form.set('originX', '0')
      form.set('originY', '0')
      const created = await backend.app.fetch(
        new Request('https://backend.test/admin/templates', {
          method: 'POST',
          headers: { authorization: `Bearer ${adminToken}` },
          body: form,
        }),
      )
      const { templateId } = (await created.json()) as { templateId: string }
      const publish = (published: boolean) =>
        request(backend, `/admin/templates/${templateId}`, 'PATCH', adminToken, { published })
      expect((await publish(true)).status).toBe(200)
      await backend.sql.recordTileObservation(
        {
          season: 3,
          tile: { x: 0, y: 0 },
          hash,
          observedAt: millis(1_000),
          reportedAt: seconds(1),
          reportedWithToken: hash,
          reportedByUserId: 42,
        },
        [],
        true,
      )
      const frames = async () =>
        (
          (await (
            await request(
              backend,
              '/telemetry/tiles/0/0/history?season=3&from=0&to=2',
              'GET',
              reader.token,
            )
          ).json()) as { frames: unknown[] }
        ).frames.length
      expect(await frames()).toBe(1)

      invalidation = false
      if (change === 'unpublished') expect((await publish(false)).status).toBe(200)
      else {
        // A new version far away: the tile no longer frames the published artwork.
        const moved = new FormData()
        moved.set('png', new File([await encodeIndexedPng(1, 1, new Uint8Array([1]))], 'art.png'))
        moved.set('originX', '500000')
        moved.set('originY', '500000')
        const replaced = await backend.app.fetch(
          new Request(`https://backend.test/admin/templates/${templateId}/versions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${adminToken}` },
            body: moved,
          }),
        )
        expect(replaced.status).toBe(201)
      }
      expect(await frames()).toBe(0)
    })

  it('confirms a tile covered by many stale templates within a bounded number of queries', async () => {
    let invalidation = true
    const backend = await createTestBackend({
      statusReadModel: (sql) =>
        new (class extends DirectStatusReadModel {
          override async notifyManifestChange(
            ...args: Parameters<DirectStatusReadModel['notifyManifestChange']>
          ): Promise<void> {
            if (!invalidation) throw new Error('manifest invalidation lost')
            await super.notifyManifestChange(...args)
          }
        })(sql),
    })
    const reader = await mint(backend, 'read')
    const templateIds: string[] = []
    for (let index = 0; index < 12; index++) {
      const form = new FormData()
      form.set('png', new File([await encodeIndexedPng(1, 1, new Uint8Array([1]))], 'art.png'))
      form.set('name', `Template ${index}`)
      form.set('season', '3')
      form.set('originX', String(index))
      form.set('originY', '0')
      const created = await backend.app.fetch(
        new Request('https://backend.test/admin/templates', {
          method: 'POST',
          headers: { authorization: `Bearer ${adminToken}` },
          body: form,
        }),
      )
      templateIds.push(((await created.json()) as { templateId: string }).templateId)
    }
    const publish = (templateId: string, published: boolean) =>
      request(backend, `/admin/templates/${templateId}`, 'PATCH', adminToken, { published })
    for (const templateId of templateIds) expect((await publish(templateId, true)).status).toBe(200)
    await backend.sql.recordTileObservation(
      {
        season: 3,
        tile: { x: 0, y: 0 },
        hash,
        observedAt: millis(1_000),
        reportedAt: seconds(1),
        reportedWithToken: hash,
        reportedByUserId: 42,
      },
      [],
      true,
    )
    let queries = 0
    for (const name of ['readTemplate', 'listManifestTemplates'] as const) {
      const original = backend.sql[name].bind(backend.sql) as (...args: unknown[]) => unknown
      Object.assign(backend.sql, {
        [name]: (...args: unknown[]) => {
          queries++
          return original(...args)
        },
      })
    }
    const frames = async () => {
      queries = 0
      return (
        (await (
          await request(
            backend,
            '/telemetry/tiles/0/0/history?season=3&from=0&to=2',
            'GET',
            reader.token,
          )
        ).json()) as { frames: unknown[] }
      ).frames.length
    }
    // The first read also builds the manifest; afterwards a fresh cache costs one template read.
    expect(await frames()).toBe(1)
    expect(await frames()).toBe(1)
    expect(queries).toBe(1)

    // Every template but the last is unpublished while the cached manifest still lists them all.
    invalidation = false
    for (const templateId of templateIds.slice(0, -1))
      expect((await publish(templateId, false)).status).toBe(200)
    expect(await frames()).toBe(1)
    expect(queries).toBeLessThanOrEqual(9)
    expect((await publish(templateIds.at(-1) ?? '', false)).status).toBe(200)
    expect(await frames()).toBe(0)
    expect(queries).toBeLessThanOrEqual(9)
  })

  it('rejects malformed read parameters instead of returning a successful empty result', async () => {
    const backend = await createTestBackend()
    const invalid = [
      '/manifest?season=-1',
      '/admin/nodes?season=NaN',
      '/admin/tokens?cursor=invalid',
      `/admin/tags?templateId=${id}&folderId=${id}`,
      '/chunks/not-a-hash',
      '/tiles/not-a-hash',
      '/archive/templates/not-a-uuid',
      '/telemetry/status?season=-1',
      '/telemetry/alarms?season=-1',
      `/telemetry/history?templateIds=${id}&from=10&to=5`,
      `/telemetry/history?templateIds=${id}&from=1&to=2&resolution=60&maxResolution=60`,
      `/telemetry/painter-history?templateIds=${id}&from=1&to=2&painters=bad`,
      `/telemetry/painters?templateIds=${id}&from=1&to=2&limit=0`,
      `/telemetry/contributions?templateIds=${id}&from=2&to=1`,
      '/telemetry/leaderboard?limit=0',
      '/telemetry/canvas?season=-1',
      '/telemetry/tiles/2048/0/history?from=1&to=2',
      `/telemetry/progress/${id}?version=bad&from=1&to=2`,
      `/telemetry/templates/${id}/versions/${id}/tiles/2048/0/mismatches`,
      '/work?season=-1',
      '/work/regions?season=-1',
    ]
    for (const path of invalid) {
      const response = await request(backend, path, 'GET', adminToken)
      expect(response.status, path).toBe(400)
      expect(await response.json(), path).toMatchObject({ error: expect.any(String) })
    }
  })

  it('mints and revokes scoped credentials through bootstrap without exposing stored secrets', async () => {
    const backend = await createTestBackend({ bootstrapAdminToken: 'bootstrap-secret' })
    const reader = await mint(backend, 'read', 'bootstrap-secret')
    expect((await request(backend, '/manifest', 'GET', reader.token)).status).toBe(200)
    const listed = await request(backend, '/admin/tokens', 'GET', 'bootstrap-secret')
    const body = (await listed.json()) as { tokens: Record<string, unknown>[] }
    expect(body.tokens).toContainEqual(expect.objectContaining({ bootstrap: true, scope: 'admin' }))
    expect(body.tokens.every((token) => !('token' in token))).toBe(true)
    for (let retry = 0; retry < 2; retry++)
      expect(
        (await request(backend, `/admin/tokens/${reader.tokenHash}`, 'DELETE', 'bootstrap-secret'))
          .status,
      ).toBe(204)
    expect((await request(backend, '/manifest', 'GET', reader.token)).status).toBe(401)
    expect(
      (await request(backend, '/admin/tokens/bootstrap', 'DELETE', 'bootstrap-secret')).status,
    ).toBe(400)
  })

  it('rejects malformed mutations and oversized work requests before changing stored state', async () => {
    const backend = await createTestBackend()
    const invalid: readonly { method: string; path: string; body: unknown }[] = [
      { method: 'PATCH', path: '/admin/server', body: { name: '' } },
      { method: 'POST', path: '/admin/tokens', body: { label: 'Invalid scope', scope: 'owner' } },
      { method: 'POST', path: '/admin/nodes', body: { season: 3, parentId: null, name: '' } },
      { method: 'PATCH', path: `/admin/nodes/${id}`, body: { parentId: 'not-a-uuid' } },
      { method: 'POST', path: '/admin/templates', body: { png: 'a filename is not an upload' } },
      { method: 'PATCH', path: `/admin/templates/${id}`, body: { published: 'true' } },
      { method: 'POST', path: '/admin/tags', body: { name: '\u0000' } },
      { method: 'POST', path: '/telemetry/paints', body: null },
      { method: 'POST', path: '/telemetry/tiles/offers', body: { season: 3, offers: 'invalid' } },
      { method: 'PUT', path: `/work/${id}?season=3`, body: { action: 'unknown' } },
      { method: 'PUT', path: `/work/regions/${id}?season=3`, body: { label: 'Missing geometry' } },
    ]
    for (const { method, path, body } of invalid) {
      const response = await request(backend, path, method, adminToken, body)
      expect(response.status, `${method} ${path}`).toBe(400)
      expect(await response.json()).toMatchObject({ error: expect.any(String) })
    }
    const oversized = await request(
      backend,
      `/work/${id}?season=3`,
      'PUT',
      adminToken,
      'x'.repeat(16_385),
    )
    expect(oversized.status).toBe(413)
    expect(await backend.sql.work.read(id)).toBeNull()
    expect(
      await (await request(backend, '/admin/nodes?season=3', 'GET', adminToken)).json(),
    ).toEqual([])
    expect(await (await request(backend, '/server')).json()).toMatchObject({ name: 'Test server' })
  })

  it('maps storage failures to a non-sensitive HTTP error and permits a later retry', async () => {
    class UnavailableSql extends MemorySqlStore {
      fail = true
      override async readServerSettings() {
        if (this.fail) throw new Error('database password=do-not-expose')
        return super.readServerSettings()
      }
    }
    const sql = new UnavailableSql()
    const backend = await createTestBackend({ sql })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await request(backend, '/server')
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('Internal Server Error')
    expect(logged).toHaveBeenCalled()
    sql.fail = false
    expect(await (await request(backend, '/server')).json()).toMatchObject({ name: 'Test server' })
  })

  it('preserves SQLite data on missing or stale destructive preconditions', async () => {
    const store = await openRelationalStore()
    try {
      const backend = await createTestBackend({ sql: store.sql })
      const nodeResponse = await request(backend, '/admin/nodes', 'POST', adminToken, {
        season: 3,
        parentId: null,
        name: 'Collection',
      })
      expect(nodeResponse.status).toBe(201)
      const node = (await nodeResponse.json()) as { id: string }
      const form = new FormData()
      form.set('png', new File([await encodeIndexedPng(1, 1, new Uint8Array([1]))], 'pixel.png'))
      for (const [key, value] of Object.entries({
        nodeId: node.id,
        name: 'Pixel',
        originX: '0',
        originY: '0',
      }))
        form.set(key, value)
      const upload = await backend.app.fetch(
        new Request('https://backend.test/admin/templates', {
          method: 'POST',
          headers: { authorization: `Bearer ${adminToken}` },
          body: form,
        }),
      )
      expect(upload.status).toBe(201)
      const created = (await upload.json()) as { templateId: string; versionId: string }
      const templatePath = `/admin/templates/${created.templateId}`
      expect((await request(backend, templatePath, 'DELETE', adminToken)).status).toBe(428)
      expect(
        (
          await request(
            backend,
            `${templatePath}?expectedVersion=${created.versionId}&expectedUpdatedAt=0`,
            'DELETE',
            adminToken,
          )
        ).status,
      ).toBe(409)
      expect((await request(backend, `/admin/nodes/${node.id}`, 'DELETE', adminToken)).status).toBe(
        409,
      )
      expect(
        (
          await request(
            backend,
            `/admin/nodes/${node.id}?cascade=true&expectedNodes=1&expectedTemplates=0`,
            'DELETE',
            adminToken,
          )
        ).status,
      ).toBe(409)
      expect(await store.sql.countNodeSubtree(node.id)).toEqual({ nodes: 1, templates: 1 })
      const deleted = await request(
        backend,
        `/admin/nodes/${node.id}?cascade=true&expectedNodes=1&expectedTemplates=1`,
        'DELETE',
        adminToken,
      )
      expect(deleted.status).toBe(200)
      expect(await deleted.json()).toEqual({ nodes: 1, templates: 1, chunks: 0 })
      expect(await store.sql.readTemplate(created.templateId)).toBeNull()
    } finally {
      await store.close()
    }
  })
})
