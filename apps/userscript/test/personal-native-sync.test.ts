import { decodePng, encodeIndexedPng } from '@caelestis/shared'
import { expect, it, vi } from 'vitest'
import {
  type NativeImageStore,
  type NativeMetadataStore,
  type NativeTemplate,
  NativeTemplates,
} from '../src/templates/native-store.js'
import type { StoredTemplate } from '../src/templates/persist.js'
import {
  connectPersonalStore,
  loadTemplate,
  saveTemplate,
  synchronizePersonalTemplates,
} from '../src/templates/personal-store.js'
import { cutPixels, joinPixels } from '../src/templates/sparse-pixels.js'

/** Lets a test land a Wplace edit while tags reconcile, the one await inside a projection. */
const duringTagSync = vi.hoisted(() => ({ edit: null as (() => Promise<void>) | null }))
vi.mock('../src/templates/tags.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/templates/tags.js')>()
  return {
    ...original,
    synchronizeLocalTemplateTags: async (
      ...args: Parameters<typeof original.synchronizeLocalTemplateTags>
    ) => {
      const edit = duringTagSync.edit
      if (edit === null) return await original.synchronizeLocalTemplateTags(...args)
      duringTagSync.edit = null
      await edit()
      return true
    },
  }
})

/** Wplace's metadata singleton and image store, which are external. Its render echoes the image. */
const wplace = () => {
  const records: NativeTemplate[] = []
  const images = new Map<string, Blob>()
  const render = vi.fn<NativeImageStore['render']>(async (blob) => {
    const decoded = await decodePng(new Uint8Array(await blob.arrayBuffer()))
    return new ImageData(new Uint8ClampedArray(decoded.pixels), decoded.width, decoded.height)
  })
  const metadata: NativeMetadataStore = {
    templates: records,
    tagCatalog: [],
    placementSession: false,
    getById: (id) => records.find((record) => record.id === id),
    add: (template) => records.push(template),
    update: (id, patch) => Object.assign(records.find((record) => record.id === id) ?? {}, patch),
    remove: (id) =>
      records.splice(
        records.findIndex((record) => record.id === id),
        1,
      ),
    persist: () => {},
    commitPendingChanges: () => {},
    subscribeChange: () => () => {},
  }
  const api = new NativeTemplates(metadata, {
    read: async (id) => images.get(id),
    save: async (id, blob) => void images.set(id, blob),
    remove: async (id) => void images.delete(id),
    subscribe: () => () => {},
    render,
  })
  /** What Wplace does on load: rebuild each record with its own field order. */
  const reload = () => {
    for (const [index, { id, name, bounds, ...rest }] of records.entries())
      records[index] = { ...rest, bounds, name, id }
  }
  return { api, images, records, render, reload }
}

const indices = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

const add = async (id: string) => {
  const saved = await saveTemplate(
    {
      id,
      name: 'Large',
      source: 'image',
      originX: 1000,
      originY: 2000,
      width: 4,
      height: 2,
      pixels: cutPixels(4, 2, indices),
      moved: 0,
      opaque: 8,
      visible: true,
      everPlaced: true,
      revision: 0,
    },
    null,
  )
  expect(saved.status).toBe('saved')
}

const storedPixels = async (id: string): Promise<Uint8Array> => {
  const loaded = await loadTemplate(id)
  if (loaded.status !== 'loaded') throw new Error(`template did not load: ${loaded.status}`)
  return joinPixels((loaded.template as StoredTemplate).pixels)
}

it('adds and reloads a Wplace-mirrored template without rendering its pixels back', async () => {
  const native = wplace()
  connectPersonalStore(native.api)

  await add('local-reloaded')
  native.reload()
  native.records[0] = { ...(native.records[0] as NativeTemplate), visible: false }
  await synchronizePersonalTemplates()

  expect(native.render).not.toHaveBeenCalled()
  expect(await storedPixels('local-reloaded')).toEqual(indices)
})

it('renders Wplace artwork that changed while the new copy was being linked', async () => {
  const native = wplace()
  connectPersonalStore(native.api)
  const reversed = indices.slice().reverse()
  duringTagSync.edit = async () => {
    const [record] = native.records
    if (record === undefined) throw new Error('the native copy was not written')
    const png = new Uint8Array(await encodeIndexedPng(4, 2, reversed))
    native.images.set(record.id, new Blob([png], { type: 'image/png' }))
  }

  await add('local-edited')

  expect(native.render).toHaveBeenCalledTimes(1)
  expect(await storedPixels('local-edited')).toEqual(reversed)
})

it('renders again when Wplace changes how the template is coloured', async () => {
  const native = wplace()
  connectPersonalStore(native.api)
  await add('local-recoloured')
  native.render.mockClear()

  native.records[0] = { ...(native.records[0] as NativeTemplate), dithering: true }
  await synchronizePersonalTemplates()

  expect(native.render).toHaveBeenCalledTimes(1)
})
