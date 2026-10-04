import {
  encodeIndexedPng,
  sha256Hex,
  type TemplateRecipe,
  templateRecipeJson,
} from '@caelestis/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { authorized, createTestBackend } from './support/backend.js'
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
