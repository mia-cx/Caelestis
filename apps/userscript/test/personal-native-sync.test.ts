import { decodePng, encodeIndexedPng } from '@caelestis/shared'
import { expect, it, vi } from 'vitest'
import * as local from '../src/templates/local-store.js'
import {
  type NativeImageStore,
  type NativeMetadataStore,
  type NativeTemplate,
  NativeTemplates,
} from '../src/templates/native-store.js'
import type { StoredTemplate } from '../src/templates/persist.js'
import * as disk from '../src/templates/persist.js'
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

/**
 * Wplace's metadata singleton and image store, which are external. Its render echoes the image.
 * Like Wplace, it stamps `updatedAt` on every metadata update and announces every image write in
 * this tab; `setInAnotherTab` is a write this tab is never told about.
 */
const wplace = () => {
  const records: NativeTemplate[] = []
  const imageListeners = new Set<(id: string) => void>()
  const store = new Map<string, Blob>()
  const images = {
    get: (id: string) => store.get(id),
    set: (id: string, blob: Blob) => {
      store.set(id, blob)
      for (const listener of imageListeners) listener(id)
    },
    setInAnotherTab: (id: string, blob: Blob) => void store.set(id, blob),
    has: (blob: Blob) => [...store.values()].includes(blob),
  }
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
    update: (id, patch) =>
      Object.assign(records.find((record) => record.id === id) ?? {}, {
        ...patch,
        updatedAt: patch.updatedAt ?? Date.now(),
      }),
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
    save: async (id, blob) => images.set(id, blob),
    remove: async (id) => void store.delete(id),
    subscribe: (listener) => {
      const announce = (id: string) => listener({ id, kind: 'save' })
      imageListeners.add(announce)
      return () => imageListeners.delete(announce)
    },
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

/** A placed Local template, through the same store the sidebar edits. */
const place = async (id: string) =>
  await local.addLocalTemplate(
    {
      id,
      name: id,
      source: 'image',
      originX: 1000,
      originY: 2000,
      width: 4,
      height: 2,
      indices,
      moved: 0,
      opaque: 8,
    },
    undefined,
    true,
  )

/** What a tab does when it regains focus. */
const focus = async () => {
  await synchronizePersonalTemplates()
  await local.refreshPersonalTemplates()
}

/** Every artwork byte read from IndexedDB or Wplace's image store goes through a Blob. */
const artworkReads = () => vi.spyOn(Blob.prototype, 'arrayBuffer')

it('confirms an unchanged catalog on focus without reading any artwork', async () => {
  connectPersonalStore(wplace().api)
  const { id } = await place('focus-unchanged')
  await focus()

  const reads = artworkReads()
  await focus()

  expect(reads).not.toHaveBeenCalled()
  reads.mockRestore()
  expect(await storedPixels(id)).toEqual(indices)
})

it('saves a visibility change without reading its pixels', async () => {
  const native = wplace()
  connectPersonalStore(native.api)
  const { id } = await place('save-visibility')
  await focus()

  const reads = artworkReads()
  expect(await local.setLocalVisible(id, false)).toBe(true)

  // Only the Wplace source is read: checked before it is written over, and after.
  const stored = reads.mock.contexts.filter((blob) => !native.images.has(blob as Blob))
  expect(stored).toEqual([])
  reads.mockRestore()
  expect(native.records[0]?.visible).toBe(false)
  expect(await storedPixels(id)).toEqual(indices)
})

it('refuses to delete a template whose Wplace image another tab just replaced', async () => {
  const native = wplace()
  connectPersonalStore(native.api)
  const { id } = await place('cross-tab-delete')
  await focus()
  const nativeId = native.records[0]?.id ?? ''
  const png = new Uint8Array(await encodeIndexedPng(4, 2, indices.slice().reverse()))
  const replacement = new Blob([png], { type: 'image/png' })

  native.images.setInAnotherTab(nativeId, replacement)

  expect(await local.removeLocalTemplate(id)).toBe(false)
  expect(native.images.get(nativeId)).toBe(replacement)
  expect(native.records).toHaveLength(1)
})

it('keeps the artwork in memory when Wplace hides a template', async () => {
  const native = wplace()
  connectPersonalStore(native.api)
  const { id, artwork } = await place('native-hidden')
  await focus()

  native.api.metadata.update(native.records[0]?.id ?? '', { visible: false })
  await focus()

  expect(local.templateById(id)).toMatchObject({ visible: false, artwork })
  expect(native.render).not.toHaveBeenCalled()
})

it('applies another tab’s rename without reading any artwork', async () => {
  connectPersonalStore(wplace().api)
  const { id, artwork } = await place('cross-tab-rename')
  await focus()
  const loaded = await disk.loadTemplate(id)
  if (loaded.status !== 'loaded') throw new Error(`template did not load: ${loaded.status}`)
  const stored = loaded.template as StoredTemplate
  expect(
    await disk.saveTemplate({ ...stored, name: 'Renamed', pixels: null }, stored.revision),
  ).toMatchObject({ status: 'saved' })

  const reads = artworkReads()
  await focus()

  expect(reads).not.toHaveBeenCalled()
  reads.mockRestore()
  expect(local.templateById(id)).toMatchObject({ name: 'Renamed', artwork })
  expect(await storedPixels(id)).toEqual(indices)
})

it('shows Wplace artwork edited during linking after later metadata edits', async () => {
  const native = wplace()
  connectPersonalStore(native.api)
  const reversed = indices.slice().reverse()
  duringTagSync.edit = async () => {
    const png = new Uint8Array(await encodeIndexedPng(4, 2, reversed))
    native.images.set(native.records[0]?.id ?? '', new Blob([png], { type: 'image/png' }))
  }
  const { id } = await place('linking-edited')

  expect(await local.setLocalVisible(id, false)).toBe(true)
  native.api.metadata.update(native.records[0]?.id ?? '', { name: 'Renamed in Wplace' })
  await focus()

  const template = local.templateById(id)
  if (template === undefined) throw new Error('the template left the catalog')
  expect(template.name).toBe('Renamed in Wplace')
  expect(await local.templatePixels(template)).toEqual(reversed)
})

it('refuses a save when another tab replaces the Wplace image while it is checked', async () => {
  const native = wplace()
  connectPersonalStore(native.api)
  const { id } = await place('cross-tab-save')
  await focus()
  const nativeId = native.records[0]?.id ?? ''
  const original = native.images.get(nativeId)
  if (original === undefined) throw new Error('the Wplace copy was not written')
  const replacement = new Blob([new Uint8Array(original.size).fill(1)], { type: 'image/png' })
  const read = Blob.prototype.arrayBuffer
  vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementationOnce(async function (this: Blob) {
    const bytes = await read.call(this)
    native.images.setInAnotherTab(nativeId, replacement)
    return bytes
  })

  expect(await local.setLocalVisible(id, false)).toBe(false)
  expect(native.images.get(nativeId)).toBe(replacement)
})

it('shows Wplace artwork edited while a hide links an unlinked template', async () => {
  const native = wplace()
  connectPersonalStore(native.api)
  const id = 'unlinked-hidden'
  // An earlier link never finished, so the stored record still has no Wplace copy.
  expect(
    await disk.saveTemplate(
      {
        id,
        name: id,
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
        tileKeys: ['1/2'],
      },
      null,
    ),
  ).toMatchObject({ status: 'saved' })
  await local.restoreLocalTemplates()
  const reversed = indices.slice().reverse()
  duringTagSync.edit = async () => {
    const png = new Uint8Array(await encodeIndexedPng(4, 2, reversed))
    native.images.set(native.records[0]?.id ?? '', new Blob([png], { type: 'image/png' }))
  }

  expect(await local.setLocalVisible(id, false)).toBe(true)
  native.api.metadata.update(native.records[0]?.id ?? '', { name: 'Renamed in Wplace' })
  await focus()

  const template = local.templateById(id)
  if (template === undefined) throw new Error('the template left the catalog')
  expect(template.name).toBe('Renamed in Wplace')
  expect(await local.templatePixels(template)).toEqual(reversed)
})

it('renders a Wplace image replacement on the next focus', async () => {
  const native = wplace()
  connectPersonalStore(native.api)
  const { id } = await place('native-repainted')
  await focus()
  const reversed = indices.slice().reverse()

  const png = new Uint8Array(await encodeIndexedPng(4, 2, reversed))
  native.images.set(native.records[0]?.id ?? '', new Blob([png], { type: 'image/png' }))
  await focus()

  const template = local.templateById(id)
  if (template === undefined) throw new Error('the template left the catalog')
  expect(await local.templatePixels(template)).toEqual(reversed)
  expect(await storedPixels(id)).toEqual(reversed)
})
