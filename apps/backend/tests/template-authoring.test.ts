import {
  createWorkClient,
  encodeIndexedPng,
  millis,
  seconds,
  sha256Hex,
  type TemplateRecipe,
  templateRecipeJson,
} from '@caelestis/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { hashToken } from '../src/auth/tokens.js'
import { adminToken, authorized, createTestBackend } from './support/backend.js'
import { openRelationalStore } from './support/relational.js'

type Backend = Awaited<ReturnType<typeof createTestBackend>>

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

const backend = async (): Promise<Backend> => {
  const store = await openRelationalStore()
  closers.push(store.close)
  return await createTestBackend({ sql: store.sql })
}

/** A 2x1 processed artwork and the 4x2 source it was sampled from. */
const fixture = async (palette: readonly number[] = [0, 1, 2]) => {
  const png = await encodeIndexedPng(2, 1, new Uint8Array([1, 2]))
  const source = await encodeIndexedPng(4, 2, new Uint8Array([1, 1, 2, 2, 1, 1, 2, 2]))
  const recipe: TemplateRecipe = {
    format: 1,
    processor: 'wplace-native',
    processorVersion: 1,
    source: { sha256: await sha256Hex(source), width: 4, height: 2 },
    width: 2,
    height: 1,
    colorMetric: 'lab',
    dithering: false,
    legacyDecode: false,
    palette,
  }
  return { png, source, recipe }
}

const form = (
  parts: Record<string, string>,
  files: { png: Uint8Array; source?: Uint8Array; recipe?: string },
) => {
  const body = new FormData()
  body.set('png', new File([new Uint8Array(files.png)], 'art.png'))
  if (files.source !== undefined)
    body.set('source', new File([new Uint8Array(files.source)], 'source.png'))
  if (files.recipe !== undefined) body.set('recipe', files.recipe)
  for (const [key, value] of Object.entries(parts)) body.set(key, value)
  return body
}

const create = async (server: Backend, files: Parameters<typeof form>[1]) =>
  await server.app.fetch(
    authorized('/admin/templates', {
      method: 'POST',
      body: form({ season: '3', name: 'Art', originX: '10', originY: '20' }, files),
    }),
  )

const replace = async (server: Backend, templateId: string, files: Parameters<typeof form>[1]) =>
  await server.app.fetch(
    authorized(`/admin/templates/${templateId}/versions`, {
      method: 'POST',
      body: form({ originX: '10', originY: '20' }, files),
    }),
  )

const recipeOf = async (server: Backend, versionId: string) =>
  await server.app.fetch(authorized(`/recipes/${versionId}`))

describe('template authoring inputs', () => {
  it('keeps source and recipe with each immutable version', async () => {
    const server = await backend()
    const first = await fixture()
    const created = await create(server, { ...first, recipe: templateRecipeJson(first.recipe) })
    expect(created.status).toBe(201)
    const { templateId, versionId } = (await created.json()) as {
      templateId: string
      versionId: string
    }

    const recipe = await recipeOf(server, versionId)
    expect(recipe.status).toBe(200)
    expect(await recipe.json()).toEqual({ templateId, versionId, recipe: first.recipe })
    const source = await server.app.fetch(authorized(`/sources/${first.recipe.source.sha256}`))
    expect(source.status).toBe(200)
    expect(new Uint8Array(await source.arrayBuffer())).toEqual(first.source)

    // A palette change is a new recipe, so it is a new version; the old one keeps its own.
    const second = await fixture([1, 2])
    const replaced = await replace(server, templateId, {
      ...second,
      recipe: templateRecipeJson(second.recipe),
    })
    expect(replaced.status).toBe(201)
    const next = (await replaced.json()) as { versionId: string }
    expect(
      ((await (await recipeOf(server, next.versionId)).json()) as { recipe: unknown }).recipe,
    ).toEqual(second.recipe)
    expect(
      ((await (await recipeOf(server, versionId)).json()) as { recipe: unknown }).recipe,
    ).toEqual(first.recipe)

    // Canvas artwork has no recipe. Its version is processed-only, not a copy of the last recipe.
    const processedOnly = await replace(server, templateId, { png: first.png })
    expect(processedOnly.status).toBe(201)
    const latest = (await processedOnly.json()) as { versionId: string }
    expect((await recipeOf(server, latest.versionId)).status).toBe(404)
  })

  it('serves an unpublished template’s chunks, source, and recipe to admins only', async () => {
    const server = await backend()
    const art = await fixture()
    const created = await create(server, { ...art, recipe: templateRecipeJson(art.recipe) })
    const { templateId, versionId } = (await created.json()) as {
      templateId: string
      versionId: string
    }
    const minted = await server.app.fetch(
      authorized('/admin/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'reader', scope: 'read' }),
      }),
    )
    const { token } = (await minted.json()) as { token: string }
    const chunk = (await server.sql.readTemplateVersion(versionId))?.chunks[0]?.hash
    const paths = [
      `/chunks/${chunk}`,
      `/sources/${art.recipe.source.sha256}`,
      `/recipes/${versionId}`,
    ]
    const statuses = async (bearer: string) =>
      await Promise.all(
        paths.map(
          async (path) =>
            (
              await server.app.fetch(
                new Request(`https://backend.test${path}`, {
                  headers: { authorization: `Bearer ${bearer}` },
                }),
              )
            ).status,
        ),
      )
    const publish = async (published: boolean) =>
      await server.app.fetch(
        authorized(`/admin/templates/${templateId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ published }),
        }),
      )

    expect(await statuses(token)).toEqual([404, 404, 404])
    expect(await statuses(adminToken)).toEqual([200, 200, 200])
    expect((await publish(true)).status).toBe(200)
    expect(await statuses(token)).toEqual([200, 200, 200])
    expect((await publish(false)).status).toBe(200)
    expect(await statuses(token)).toEqual([404, 404, 404])
  })

  it('tells callers below admin nothing about an unpublished template', async () => {
    const server = await backend()
    const art = await fixture()
    const created = await create(server, { ...art, recipe: templateRecipeJson(art.recipe) })
    const { templateId } = (await created.json()) as { templateId: string }
    const call = async (bearer: string, path: string, init: RequestInit = {}) =>
      await server.app.fetch(
        new Request(`https://backend.test${path}`, {
          ...init,
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        }),
      )
    const mint = async (scope: 'read' | 'report') =>
      (
        (await (
          await call(adminToken, '/admin/tokens', {
            method: 'POST',
            body: JSON.stringify({ label: scope, scope }),
          })
        ).json()) as { token: string }
      ).token
    const [reader, reporter] = [await mint('read'), await mint('report')]
    const folder = (await (
      await call(adminToken, '/admin/nodes', {
        method: 'POST',
        body: JSON.stringify({ season: 3, parentId: null, name: 'Drafts' }),
      })
    ).json()) as { id: string }
    const patch = async (body: object) =>
      expect(
        (
          await call(adminToken, `/admin/templates/${templateId}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(200)
    await patch({ nodeId: folder.id, published: true })

    // Everything a reader could learn while the template was public: work, a hinted region, and
    // the canvas tile under it with its history.
    const actor = { wplaceUserId: 42, displayName: 'Painter' }
    const workId = '01890f3e-7b2c-7abc-8def-012345678901'
    const regionPath = '/work/regions/01890f3e-7b2c-7abc-8def-0123456789ab?season=3&surface=world'
    const region = {
      actor,
      label: 'Corner',
      templateId,
      document: {
        items: [{ id: 'shape', op: 'add', shape: { kind: 'rectangle', x: 10, y: 20, w: 2, h: 1 } }],
      },
    }
    expect(
      (
        await call(adminToken, `/work/${workId}?season=3&surface=world`, {
          method: 'PUT',
          body: JSON.stringify({
            action: 'create',
            actor,
            expectedRevision: 0,
            fields: {
              title: 'Finish the corner',
              description: '',
              status: 'open',
              priority: 'normal',
              tags: [],
              blockerIds: [],
              nodeId: null,
              templateIds: [templateId],
            },
          }),
        })
      ).status,
    ).toBe(200)
    expect(
      (await call(reporter, regionPath, { method: 'PUT', body: JSON.stringify(region) })).status,
    ).toBe(200)
    await server.sql.recordTileObservation(
      {
        season: 3,
        tile: { x: 0, y: 0 },
        hash: 'a'.repeat(64),
        observedAt: millis(1_000),
        reportedAt: seconds(1),
        reportedWithToken: await hashToken(reporter),
        reportedByUserId: 42,
      },
      [],
      true,
    )
    const history = `/telemetry/tiles/0/0/history?season=3&from=0&to=${4_000_000_000}`

    const view = async (bearer: string) => ({
      folders: ((await (await call(bearer, '/manifest?season=3')).json()) as { nodes: unknown[] })
        .nodes.length,
      tiles: (
        (await (await call(bearer, '/telemetry/canvas?season=3')).json()) as {
          tiles: unknown[]
        }
      ).tiles.length,
      frames: ((await (await call(bearer, history)).json()) as { frames: unknown[] }).frames.length,
      work: (
        (await (await call(bearer, '/work?season=3&surface=world')).json()) as {
          items: unknown[]
        }
      ).items.length,
      workHistory: (await call(bearer, `/work/${workId}/history`)).status,
      hint: (
        (await (await call(bearer, '/work/regions?season=3&surface=world')).json()) as {
          regions: { templateId: string | null }[]
        }
      ).regions[0]?.templateId,
    })
    const visible = { folders: 1, tiles: 1, frames: 1, work: 1, workHistory: 200, hint: templateId }
    expect(await view(reader)).toEqual(visible)

    await patch({ published: false })
    expect(await view(reader)).toEqual({
      folders: 0,
      tiles: 0,
      frames: 0,
      work: 0,
      workHistory: 404,
      hint: null,
    })
    expect(await view(adminToken)).toEqual({ ...visible, hint: null })
    // A hint may not name a draft either, and the refusal reads the same as for a missing template.
    expect(
      (await call(reporter, regionPath, { method: 'PUT', body: JSON.stringify(region) })).status,
    ).toBe(400)
  })

  it('refuses authoring that does not describe the uploaded pixels', async () => {
    const server = await backend()
    const { png, source, recipe } = await fixture()
    const json = templateRecipeJson(recipe)
    const refusals = [
      { png, source: new Uint8Array([...source, 0]), recipe: json },
      { png, recipe: json },
      { png, source },
      { png, source, recipe: '{"format":1}' },
      { png, source, recipe: templateRecipeJson({ ...recipe, width: 3 }) },
      {
        png,
        source,
        recipe: templateRecipeJson({ ...recipe, source: { ...recipe.source, width: 5 } }),
      },
    ]
    for (const files of refusals) expect((await create(server, files)).status).toBe(400)
    expect(await server.blobs.get('sources', recipe.source.sha256)).toBeNull()
  })
})

describe('work hidden behind an unpublished template', () => {
  it('pages past hidden work so the work client still loads everything visible', async () => {
    const server = await backend()
    const art = await fixture()
    const created = await create(server, { ...art, recipe: templateRecipeJson(art.recipe) })
    const { templateId } = (await created.json()) as { templateId: string }
    const actor = { wplaceUserId: 42, displayName: 'Painter' }
    // 499 visible, then more hidden work than one page holds, then one more visible item.
    const hidden = (n: number) => n >= 500 && n <= 1000
    for (let n = 1; n <= 1001; n++) {
      const item = {
        id: `01890f3e-7b2c-7abc-8def-${n.toString(16).padStart(12, '0')}`,
        season: 3,
        surface: { kind: 'world', allianceId: null },
        title: `Work ${n}`,
        description: '',
        status: 'open',
        priority: 'normal',
        tags: [],
        blockerIds: [],
        nodeId: null,
        templateIds: hidden(n) ? [templateId] : [],
        claimant: null,
        revision: 1,
        createdAt: n,
        updatedAt: n,
      } as const
      await server.sql.work.save(
        item,
        0,
        { id: item.id, action: 'create', actor, item },
        'a'.repeat(64),
      )
    }
    const minted = await server.app.fetch(
      authorized('/admin/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'reader', scope: 'read' }),
      }),
    )
    const { token } = (await minted.json()) as { token: string }
    const reader = createWorkClient(
      async (path, init) =>
        await server.app.fetch(
          new Request(`https://backend.test${path}`, {
            ...init,
            headers: { authorization: `Bearer ${token}` },
          }),
        ),
      3,
      { kind: 'world', allianceId: null },
    )
    const { items } = await reader.list()
    expect(items.map((item) => item.title)).toEqual(
      Array.from({ length: 1001 }, (_, at) => at + 1)
        .filter((n) => !hidden(n))
        .map((n) => `Work ${n}`),
    )
  })
})
