import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, expect, it, vi } from 'vitest'
import { loadTemplate, openTemplateDatabase } from '../src/templates/persist.js'

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))

const legacyDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('caelestis', 3)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('local-templates', { keyPath: 'id' })
      store.put({ id: 'a-corrupt', indices: 'not pixels' })
      store.put({
        id: 'b-art',
        name: 'Legacy art',
        source: 'image',
        originX: 12,
        originY: 34,
        width: 2,
        height: 2,
        indices: new Blob([new Uint8Array([17, 18, 54, 63])]),
        moved: 0,
        opaque: 4,
        visible: true,
        everPlaced: true,
        revision: 0,
        appearance: { hiddenColours: [17, 54] },
      })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

it('upgrades Blob-backed legacy artwork past a corrupt row without remapping it twice', async () => {
  const legacy = await legacyDatabase()
  legacy.close()
  for (let reopen = 0; reopen < 2; reopen++) {
    const loaded = await loadTemplate('b-art')
    expect(loaded).toMatchObject({
      status: 'loaded',
      template: {
        indices: new Uint8Array([19, 17, 35, 63]),
        appearance: { hiddenColours: [19, 35] },
      },
    })
  }
})

it('recovers a blocked upgrade and closes the abandoned connection before the next upgrade', async () => {
  const legacy = await legacyDatabase()
  try {
    await expect(openTemplateDatabase()).rejects.toThrow('blocked')
    await expect(openTemplateDatabase()).rejects.toThrow('still blocked')
  } finally {
    legacy.close()
  }
  // This queued open completes after the abandoned upgrade has delivered its success event.
  const settled = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('caelestis', 6)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  settled.close()
  expect(await loadTemplate('b-art')).toMatchObject({ status: 'loaded' })
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('caelestis', 7)
    request.onblocked = () => reject(new Error('Abandoned connection still holds the database'))
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
  })
})
