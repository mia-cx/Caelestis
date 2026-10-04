import {
  decodeWplaceIndexedPng,
  encodeIndexedPng,
  PALETTE_RGB,
  TRANSPARENT_INDEX,
} from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'

// A pass-through spy: a crafted header must be refused before this decoder allocates its size.
vi.mock('@caelestis/shared', async (original) => {
  const shared = await original<typeof import('@caelestis/shared')>()
  return { ...shared, decodeWplaceIndexedPng: vi.fn(shared.decodeWplaceIndexedPng) }
})

import { type ImportedTemplate, importFile } from '../src/templates/import.js'
import { loadTemplate, openTemplateDatabase, saveTemplate } from '../src/templates/persist.js'
import { installBitmapDecoder } from './image-decoder.js'

const STORE = 'local-templates'

const rawRecord = async (id: string): Promise<Record<string, unknown> | undefined> => {
  const db = await openTemplateDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

const putRaw = async (record: Record<string, unknown>): Promise<void> => {
  const db = await openTemplateDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(record)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

const bytes = async (blob: unknown): Promise<number[]> => [
  ...new Uint8Array(await (blob as Blob).arrayBuffer()),
]

/** Import a small PNG and store it the way a placed local template is stored. */
const importedAndSaved = async () => {
  const source = await encodeIndexedPng(3, 2, new Uint8Array([0, 1, 2, 3, 4, TRANSPARENT_INDEX]))
  const decode = installBitmapDecoder()
  const file = new File([Uint8Array.from(source)], 'art.png', { type: 'image/png' })
  const [imported] = await importFile(file, {
    x: 1_000,
    y: 1_000,
  })
  if (imported === undefined) throw new Error('nothing imported')
  expect(
    await saveTemplate({ ...imported, visible: true, everPlaced: true, revision: 0 }, null),
  ).toMatchObject({ status: 'saved' })
  decode.mockClear()
  return { source, imported, decode }
}

const loaded = async (id: string): Promise<ImportedTemplate> => {
  const result = await loadTemplate(id)
  if (result.status !== 'loaded') throw new Error(`template did not load: ${result.status}`)
  return result.template as ImportedTemplate
}

const dataUrlFetch = () =>
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.startsWith('data:image/png;base64,')) throw new Error(`unexpected request: ${url}`)
    return new Response(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
  })

/** Export a placed local template, returning the parsed `.wplace` JSON. */
const exported = async () => {
  const { imported, decode } = await importedAndSaved()
  const store = await import('../src/templates/local-store.js')
  const { templateAsWplace } = await import('../src/templates/wplace-export.js')
  const placed = await store.addLocalTemplate(
    { ...imported, id: `${imported.id}-placed` },
    undefined,
    true,
  )
  const file = await templateAsWplace(placed, placed.authoring ?? null)
  await store.removeLocalTemplate(placed.id)
  if (file === null) throw new Error('nothing exported')
  return { imported, decode, json: JSON.parse(await file.text()) as Record<string, unknown> }
}

const reimport = async (json: unknown) =>
  await importFile(new File([JSON.stringify(json)], 'art.wplace'), { x: 0, y: 0 })

describe('exported template files', () => {
  it('round trips artwork, placement, source, and recipe without processing', async () => {
    dataUrlFetch()
    const { imported, decode, json } = await exported()
    decode.mockClear()
    const [again] = await reimport(json)
    expect(again).toMatchObject({
      originX: imported.originX,
      originY: imported.originY,
      width: imported.width,
      height: imported.height,
      indices: imported.indices,
    })
    expect(again?.authoring?.recipe).toEqual(imported.authoring?.recipe)
    expect(await bytes(again?.authoring?.source)).toEqual(await bytes(imported.authoring?.source))
    expect(decode).not.toHaveBeenCalled()
  })

  it('rebuilds damaged artwork from the source, and refuses when nothing can rebuild it', async () => {
    dataUrlFetch()
    const { imported, decode, json } = await exported()
    const other = await encodeIndexedPng(3, 2, new Uint8Array(6))
    const damaged = {
      ...json,
      image: {
        ...(json.image as object),
        dataUrl: `data:image/png;base64,${Buffer.from(other).toString('base64')}`,
      },
    }
    decode.mockClear()
    const [rebuilt] = await reimport(damaged)
    expect(rebuilt?.indices).toEqual(imported.indices)
    expect(decode).toHaveBeenCalledOnce()

    const { authoring: _authoring, ...processedOnly } = json.caelestis as Record<string, unknown>
    await expect(reimport({ ...damaged, caelestis: processedOnly })).rejects.toThrow('damaged')
    await expect(
      reimport({ ...json, caelestis: { ...(json.caelestis as object), version: 2 } }),
    ).rejects.toThrow('newer Caelestis')
  })

  it('refuses artwork whose PNG header disagrees with the block before decoding it', async () => {
    dataUrlFetch()
    const { json } = await exported()
    const { authoring: _authoring, ...block } = json.caelestis as Record<string, unknown>
    const huge = Uint8Array.from(await encodeIndexedPng(3, 2, new Uint8Array(6)))
    new DataView(huge.buffer).setUint32(16, 10_000)
    new DataView(huge.buffer).setUint32(20, 10_000)
    const image = {
      ...(json.image as object),
      dataUrl: `data:image/png;base64,${Buffer.from(huge).toString('base64')}`,
    }
    vi.mocked(decodeWplaceIndexedPng).mockClear()

    await expect(reimport({ ...json, image, caelestis: block })).rejects.toThrow('damaged')
    expect(decodeWplaceIndexedPng).not.toHaveBeenCalled()
    await expect(
      reimport({ ...json, caelestis: { ...block, width: 5_000, height: 5_000 } }),
    ).rejects.toThrow('unreadable')
  })
})

describe('local template authoring', () => {
  it('keeps the source and recipe, and reloads the cached artwork without processing', async () => {
    const { source, imported, decode } = await importedAndSaved()
    expect(imported.authoring?.recipe).toMatchObject({
      processor: 'caelestis-nearest',
      width: 3,
      height: 2,
      palette: PALETTE_RGB.map((_, index) => index),
    })

    const template = await loaded(imported.id)
    expect([...template.indices]).toEqual([0, 1, 2, 3, 4, TRANSPARENT_INDEX])
    expect(template.authoring?.recipe).toEqual(imported.authoring?.recipe)
    expect(await bytes(template.authoring?.source)).toEqual([...source])
    expect(decode).not.toHaveBeenCalled()
  })

  it.each([
    [
      'truncated',
      (record: Record<string, unknown>) => ({ ...record, indices: new Blob([new Uint8Array(2)]) }),
    ],
    ['missing', ({ indices: _indices, ...record }: Record<string, unknown>) => record],
    [
      'a different colour',
      (record: Record<string, unknown>) => ({
        ...record,
        indices: new Blob([new Uint8Array([5, 1, 2, 3, 4, TRANSPARENT_INDEX])]),
      }),
    ],
    [
      'an invalid palette byte',
      (record: Record<string, unknown>) => ({
        ...record,
        indices: new Blob([new Uint8Array([255, 1, 2, 3, 4, TRANSPARENT_INDEX])]),
      }),
    ],
  ])('rebuilds %s artwork from its source and writes it back', async (_damage, damage) => {
    const { imported, decode } = await importedAndSaved()
    const stored = await rawRecord(imported.id)
    if (stored === undefined) throw new Error('template was not stored')
    await putRaw(damage(stored))

    expect([...(await loaded(imported.id)).indices]).toEqual([...imported.indices])
    expect(decode).toHaveBeenCalledOnce()
    await vi.waitFor(async () =>
      expect(await bytes((await rawRecord(imported.id))?.indices)).toEqual([...imported.indices]),
    )
  })

  it('rebuilds an oversized cache without reading its bytes', async () => {
    const { imported } = await importedAndSaved()
    const stored = await rawRecord(imported.id)
    const oversized = imported.indices.length + 1
    await putRaw({ ...stored, indices: new Blob([new Uint8Array(oversized)]) })
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer')

    expect([...(await loaded(imported.id)).indices]).toEqual([...imported.indices])
    expect(read.mock.contexts.map((blob) => (blob as Blob).size)).not.toContain(oversized)
    read.mockRestore()
  })

  it('keeps a record whose source no longer reproduces its artwork', async () => {
    const { imported } = await importedAndSaved()
    const stored = await rawRecord(imported.id)
    const authoring = stored?.authoring as Record<string, unknown>
    await putRaw({
      ...stored,
      indices: new Blob([new Uint8Array(2)]),
      authoring: { ...authoring, artwork: 'f'.repeat(64) },
    })

    expect(await loadTemplate(imported.id)).toEqual({ status: 'unavailable' })
    const kept = (await rawRecord(imported.id))?.authoring as Record<string, unknown> | undefined
    expect(await bytes(kept?.source)).toEqual(await bytes(imported.authoring?.source))
  })
})
