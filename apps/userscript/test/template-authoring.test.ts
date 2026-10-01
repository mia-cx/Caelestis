import { encodeIndexedPng, PALETTE_RGB, TRANSPARENT_INDEX } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
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
  const [imported] = await importFile(new File([source], 'art.png', { type: 'image/png' }), {
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

  it('rebuilds lost artwork from its source and writes it back', async () => {
    const { imported, decode } = await importedAndSaved()
    const stored = await rawRecord(imported.id)
    await putRaw({ ...stored, indices: new Blob([new Uint8Array(2)]) })

    expect([...(await loaded(imported.id)).indices]).toEqual([...imported.indices])
    expect(decode).toHaveBeenCalledOnce()
    await vi.waitFor(async () =>
      expect(await bytes((await rawRecord(imported.id))?.indices)).toEqual([...imported.indices]),
    )
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
