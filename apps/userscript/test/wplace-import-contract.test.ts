import { readFile } from 'node:fs/promises'
import {
  canvasPixelToLatLng,
  decodePng,
  encodeIndexedPng,
  PALETTE_RGB,
  TRANSPARENT_INDEX,
} from '@caelestis/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeTemplate } from '../src/templates/native-store.js'

const processor = vi.hoisted(() => ({
  render: vi.fn(async (image: ImageData, _recipe: NativeTemplate) => image),
}))

// Wplace's module discovery and worker are external. Import, resize, palette indexing, and local
// persistence remain production code; the worker's output is explicit, never recomputed as an oracle.
vi.mock('../src/templates/native-store.js', async (original) => {
  const native = await original<typeof import('../src/templates/native-store.js')>()
  const forbiddenWrite = () => {
    throw new Error('File import must not mutate native templates')
  }
  return {
    ...native,
    connectNativeTemplates: async (options: Parameters<typeof native.connectNativeTemplates>[0]) =>
      new native.NativeTemplates(
        {
          templates: [],
          placementSession: false,
          getById: () => undefined,
          add: forbiddenWrite,
          update: forbiddenWrite,
          remove: forbiddenWrite,
          persist: forbiddenWrite,
          commitPendingChanges: forbiddenWrite,
          subscribeChange: () => () => {},
        },
        {
          read: async () => undefined,
          save: async () => forbiddenWrite(),
          remove: async () => forbiddenWrite(),
          subscribe: () => () => {},
          render: async (blob, recipe) => {
            const decoded = await decodePng(new Uint8Array(await blob.arrayBuffer()))
            const image = new ImageData(
              new Uint8ClampedArray(decoded.pixels),
              decoded.width,
              decoded.height,
            )
            const size = native.nativePlacement(recipe)
            if (!options?.resize) throw new Error('Missing native resize contract')
            return processor.render(await options.resize(image, size.width, size.height), recipe)
          },
        },
      ),
  }
})

afterEach(() => processor.render.mockReset())
beforeEach(() =>
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.startsWith('data:image/png;base64,'))
      throw new Error(`Unexpected external request: ${url}`)
    return new Response(Buffer.from(url.slice('data:image/png;base64,'.length), 'base64'), {
      headers: { 'content-type': 'image/png' },
    })
  }),
)

const file = async (recipe: Record<string, unknown> = {}) => {
  const northWest = canvasPixelToLatLng({ x: 500, y: 600 })
  const southEast = canvasPixelToLatLng({ x: 503, y: 601 })
  const png = await encodeIndexedPng(4, 2, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
  return new File(
    [
      JSON.stringify({
        name: 'Native recipe',
        image: { dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}` },
        bounds: {
          north: northWest.lat,
          west: northWest.lng,
          south: southEast.lat,
          east: southEast.lng,
        },
        colorMetric: 'ciede2000',
        dithering: true,
        colorPaletteMode: 'template',
        templateColorIdxs: [2, 3, 4],
        ...recipe,
      }),
    ],
    'native.wplace',
  )
}

it('samples the projected footprint before processing the embedded recipe and persists final native pixels', async () => {
  processor.render.mockImplementationOnce(async (sampled, recipe) => {
    expect([sampled.width, sampled.height]).toEqual([3, 1])
    expect([...sampled.data]).toEqual(
      [1, 2, 3].flatMap((index) => [...(PALETTE_RGB[index] ?? []), 255]),
    )
    expect(recipe).toMatchObject({
      originalWidth: 4,
      originalHeight: 2,
      colorMetric: 'ciede2000',
      dithering: true,
      colorPaletteMode: 'template',
      templateColorIdxs: [2, 3, 4],
    })
    return new ImageData(
      new Uint8ClampedArray([
        ...(PALETTE_RGB[1] ?? []),
        15,
        ...(PALETTE_RGB[2] ?? []),
        16,
        ...(PALETTE_RGB[3] ?? []),
        255,
      ]),
      3,
      1,
    )
  })
  const { importFile } = await import('../src/templates/import.js')
  const [imported] = await importFile(await file(), { x: 0, y: 0 })
  expect(imported).toMatchObject({
    originX: 500,
    originY: 600,
    width: 3,
    height: 1,
    indices: new Uint8Array([TRANSPARENT_INDEX, 2, 3]),
    opaque: 2,
  })
  if (!imported) throw new Error('Missing imported template')
  const store = await import('../src/templates/local-store.js')
  const saved = await store.addLocalTemplate(imported, undefined, true)
  try {
    await store.restoreLocalTemplates()
    expect(store.templateById(saved.id)?.indices).toEqual(new Uint8Array([TRANSPARENT_INDEX, 2, 3]))
    expect(processor.render).toHaveBeenCalledTimes(1)
  } finally {
    await store.removeLocalTemplate(saved.id)
  }
})

it('surfaces native processing failure and rejects remote images before decoding', async () => {
  const { importFile } = await import('../src/templates/import.js')
  processor.render.mockRejectedValueOnce(new Error('native worker unavailable'))
  await expect(importFile(await file(), { x: 0, y: 0 })).rejects.toThrow(
    'native worker unavailable',
  )
  await expect(
    importFile(await file({ image: { dataUrl: 'https://external.test/image.png' } }), {
      x: 0,
      y: 0,
    }),
  ).rejects.toThrow('embedded PNG')
})

it('imports the reported 1024px United Pixels export at its 113px geographic footprint', async () => {
  const contents = await readFile('../../fixtures/wplace/united-pixels-logo.wplace', 'utf8')
  const { importFile } = await import('../src/templates/import.js')
  processor.render.mockImplementationOnce(async (sampled, recipe) => {
    expect(recipe).toMatchObject({
      originalWidth: 1024,
      originalHeight: 1024,
      colorMetric: 'lab',
      dithering: false,
      colorPaletteMode: 'all',
    })
    expect([sampled.width, sampled.height]).toEqual([113, 113])
    return sampled
  })
  const [imported] = await importFile(new File([contents], 'United-Pixels.wplace'), { x: 0, y: 0 })
  expect(imported).toMatchObject({
    name: 'United Pixels logo',
    width: 113,
    height: 113,
    originX: 794966,
    originY: 1697843,
  })
})
