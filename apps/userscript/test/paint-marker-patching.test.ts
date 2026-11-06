import { WPLACE_PALETTE } from '@caelestis/shared'
import { afterEach, expect, it, vi } from 'vitest'
import type { MarkList } from '../src/templates/mark-list.js'

vi.mock('../src/main.js', () => ({ repaint: () => {}, viewportCentre: () => null }))

/**
 * A painted pixel patches cached marker lists in place instead of rescanning the tile. Patching is
 * only right if the patched lists are exactly what a fresh scan would find, and the GPU copy holds
 * exactly the patched lists. Wplace's page (tile fetch, decode, canvas readback, paint endpoint) is
 * faked; capture, drafts, accepted paint, the mismatch cache and the marker renderer are real.
 */
const TILE = { x: 100, y: 200 }
const SIZE = 1_000
const SIDE = 40
const UNPAINTED = 255
const COLOURS = [1, 2, 3, 4, 5]

/** What the template wants at a tile-local pixel. */
const wantedAt = (x: number, y: number): number => 1 + ((x * 7 + y * 3) % 5)

/** The served tile: correct, wrong or blank in a fixed pattern, with every class present. */
const servedAt = (x: number, y: number): number => {
  const pattern = (x * 13 + y * 29) % 3
  return pattern === 0 ? wantedAt(x, y) : pattern === 1 ? 1 + (wantedAt(x, y) % 5) : UNPAINTED
}

interface FakeBitmap {
  readonly width: number
  readonly height: number
  readonly colours: Uint8Array
  close(): void
}

/** The fakes' tile format: each byte paints the next pixel that colour, 255 leaves it blank. */
const decode = async (source: Blob): Promise<FakeBitmap> => ({
  width: SIZE,
  height: SIZE,
  colours: new Uint8Array(await source.arrayBuffer()),
  close() {},
})

const OffscreenCanvasStub = class {
  getContext() {
    let drawn: FakeBitmap | undefined
    return {
      clearRect() {},
      drawImage(bitmap: FakeBitmap) {
        drawn = bitmap
      },
      getImageData: () => {
        const data = new Uint8ClampedArray(SIZE * SIZE * 4)
        drawn?.colours.forEach((colour, p) => {
          const rgb = WPLACE_PALETTE[colour]?.rgb
          if (rgb !== undefined) data.set([...rgb, 255], p * 4)
        })
        return { data }
      },
    }
  }
}

/** A WebGL2 context that keeps what the marker renderer uploads, so the GPU copy can be read back. */
const recordingGl = () => {
  const stored = new Map<object, Uint32Array>()
  const drawn: { readonly marks: Uint32Array; readonly count: number }[] = []
  let bound: object | null = null
  const calls: Record<string, unknown> = {
    createBuffer: () => ({}),
    bindBuffer: (_target: number, buffer: object | null) => {
      bound = buffer
    },
    bufferData: (_target: number, data: Uint32Array) => {
      stored.set(bound as object, data.slice())
    },
    bufferSubData: (
      _target: number,
      offset: number,
      data: Uint32Array,
      first: number,
      count: number,
    ) => {
      stored.get(bound as object)?.set(data.subarray(first, first + count), offset / 4)
    },
    drawArrays: (_mode: number, _first: number, count: number) => {
      drawn.push({ marks: stored.get(bound as object) as Uint32Array, count })
    },
    getShaderParameter: () => true,
    getProgramParameter: () => true,
  }
  const gl = new Proxy(calls, {
    get: (target, name) => {
      if (name in target) return target[name as string]
      if (name === 'drawingBufferWidth' || name === 'drawingBufferHeight') return 2_000
      if (name === 'canvas') return {}
      if (typeof name === 'string' && /^[A-Z_0-9]+$/.test(name)) return 1
      return () => ({})
    },
  }) as unknown as WebGL2RenderingContext
  /** The live marks the last frame's draws would put on screen, in row-major order. */
  const onScreen = (): number[] =>
    drawn
      .flatMap(({ marks, count }) => [...marks.subarray(0, count)])
      .filter((mark) => mark < 0x8000_0000)
      .sort((left, right) => (left & 0xf_ffff) - (right & 0xf_ffff))
  return { gl, drawn, onScreen }
}

const setup = async () => {
  vi.stubGlobal('navigator', { deviceMemory: 8 })
  vi.stubGlobal('OffscreenCanvas', OffscreenCanvasStub)
  vi.resetModules()
  const tileTransform = await import('../src/tile-transform.js')
  const store = await import('../src/templates/local-store.js')
  const { pixelAccounting } = await import('../src/templates/mismatch.js')
  const { MarkerRenderer } = await import('../src/gl/marker-renderer.js')

  const served = new Uint8Array(SIZE * SIDE).fill(UNPAINTED)
  for (let y = 0; y < SIDE; y++)
    for (let x = 0; x < SIDE; x++) served[y * SIZE + x] = servedAt(x, y)
  /** Wplace's backend: the tile, and a paint endpoint that accepts everything it is sent. */
  const backend = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.endsWith('/paint')) return new Response(served)
    const { tiles } = JSON.parse(String(init?.body)) as { tiles: { pixels: { x: number[] } }[] }
    return Response.json({ painted: tiles.reduce((sum, tile) => sum + tile.pixels.x.length, 0) })
  })
  const realm = {
    ...globalThis,
    Object,
    Request,
    URL,
    Response,
    ArrayBuffer,
    Blob,
    crypto: globalThis.crypto,
    fetch: backend,
    createImageBitmap: vi.fn(decode),
    HTMLCanvasElement: class {
      getContext(): null {
        return null
      }
    },
  } as unknown as Window & typeof globalThis
  tileTransform.install(realm, () => null)
  tileTransform.captureTilePixels(true)
  stopCapture = () => tileTransform.captureTilePixels(false)
  const tileResponse = await realm.fetch(
    `https://backend.wplace.live/files/s0/tiles/${TILE.x}/${TILE.y}.png`,
  )
  await realm.createImageBitmap(new realm.Blob([await tileResponse.arrayBuffer()]))
  await tileTransform.settledTileCaptures()

  const indices = new Uint8Array(SIDE * SIDE)
  for (let y = 0; y < SIDE; y++)
    for (let x = 0; x < SIDE; x++) indices[y * SIDE + x] = wantedAt(x, y)
  let added = 0
  const addTemplate = async (): Promise<string> => {
    const id = `patching-${added++}`
    await store.addLocalTemplate(
      {
        id,
        name: id,
        source: 'wplace',
        originX: TILE.x * SIZE,
        originY: TILE.y * SIZE,
        width: SIDE,
        height: SIDE,
        indices,
        moved: 0,
        opaque: SIDE * SIDE,
      },
      undefined,
      true,
    )
    return id
  }
  const read = (id: string) => {
    const template = store.displayTemplates().find((candidate) => candidate.id === id)
    if (template === undefined) throw new Error(`no template ${id}`)
    const accounting = pixelAccounting.read(template)
    return pixelAccounting.frame(() => {
      const tile = accounting.tile(TILE)
      if (tile === null) throw new Error(`${id} has no answer`)
      return {
        tile,
        colours: COLOURS.map((colour) => accounting.unpainted(TILE, colour) as MarkList),
        progress: accounting.progress,
      }
    })
  }
  const lists = (answer: ReturnType<typeof read>) => ({
    mismatched: [...answer.tile.mismatched.values()],
    unpainted: [...answer.tile.unpainted.values()],
    disagreements: [...answer.tile.disagreements.values()],
    markers: [...answer.tile.markers.values()],
    colours: answer.colours.map((list) => [...list.values()]),
    progress: answer.progress,
  })
  /** What a scan from nothing finds now, through a second, identical template. */
  const rescan = async () => {
    const id = await addTemplate()
    const fresh = lists(read(id))
    await store.removeLocalTemplate(id)
    return fresh
  }

  const draft = new Uint8Array(SIZE * SIZE).fill(UNPAINTED)
  /** Native draft writes, one batch at a time, as Wplace's draft canvas reports them. */
  const drafts = (pixels: readonly (readonly [number, number, number])[]) => {
    for (const [x, y, colour] of pixels) draft[y * SIZE + x] = colour
    tileTransform.captureDraftPixels(TILE, draft.slice())
  }
  /** Submit pixels to the faked paint endpoint and wait for Caelestis to accept them. */
  const submit = async (pixels: readonly (readonly [number, number, number])[]) => {
    const accepted = new Promise<void>((resolve) => {
      const stop = tileTransform.onAcceptedPaint(() => {
        stop()
        resolve()
      })
    })
    await realm.fetch('https://backend.wplace.live/paint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        season: 0,
        tiles: [
          {
            ...TILE,
            pixels: {
              x: pixels.map(([x]) => x),
              y: pixels.map(([, y]) => y),
              colors: pixels.map(([, , colour]) => colour),
            },
          },
        ],
      }),
    })
    await accepted
  }
  return { addTemplate, read, lists, rescan, drafts, submit, MarkerRenderer }
}

let stopCapture: (() => void) | undefined

afterEach(() => {
  stopCapture?.()
  stopCapture = undefined
  vi.unstubAllGlobals()
})

/** Every pixel of the template whose served state is `kind`, in a stable order. */
const pixelsWhere = (kind: 'correct' | 'wrong' | 'blank'): [number, number][] => {
  const found: [number, number][] = []
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const served = servedAt(x, y)
      const state = served === UNPAINTED ? 'blank' : served === wantedAt(x, y) ? 'correct' : 'wrong'
      if (state === kind) found.push([x, y])
    }
  }
  return found
}

const right = ([x, y]: [number, number]) => [x, y, wantedAt(x, y)] as const
const wrongColour = ([x, y]: [number, number]) => [x, y, 1 + ((wantedAt(x, y) + 1) % 5)] as const
const erased = ([x, y]: [number, number]) => [x, y, UNPAINTED] as const

it('keeps patched marker lists identical to a full rescan through paint, erase and accepted paint', async () => {
  const { addTemplate, read, lists, rescan, drafts, submit, MarkerRenderer } = await setup()
  const id = await addTemplate()
  const patched = read(id)
  const { gl, drawn, onScreen } = recordingGl()
  const renderer = new MarkerRenderer(gl)
  const projection = {
    x: 0,
    y: 0,
    width: 2_000,
    height: 2_000,
    pixelWidth: SIZE,
    pixelHeight: SIZE,
    seedX: 0,
    seedY: 0,
  }
  const style = {
    size: 4,
    thickness: 2,
    colour: [1, 0, 1] as const,
    otherColour: null,
    otherOpacity: 1,
    selected: -1,
  }
  const expectMatchesRescan = async (step: string) => {
    const answer = read(id)
    // Patching keeps the same lists; a rescan would have replaced them.
    expect(answer.tile.mismatched, step).toBe(patched.tile.mismatched)
    expect(lists(answer), step).toEqual(await rescan())
    drawn.length = 0
    renderer.beginFrame()
    renderer.draw(projection, [answer.tile.disagreements, ...answer.colours], style, 1)
    renderer.endFrame()
    expect(onScreen(), step).toEqual(
      [answer.tile.disagreements, ...answer.colours]
        .flatMap((list) => [...list.values()])
        .sort((left, right) => (left & 0xf_ffff) - (right & 0xf_ffff)),
    )
  }
  await expectMatchesRescan('scanned')

  const wrong = pixelsWhere('wrong')
  const blank = pixelsWhere('blank')
  const correct = pixelsWhere('correct')
  // Every batch stays at or under the 32 pixels a tile patches before it rescans instead.
  drafts([...wrong.slice(0, 10).map(right), ...blank.slice(0, 10).map(right)])
  await expectMatchesRescan('fixed wrong and blank pixels')
  drafts([...blank.slice(10, 20).map(wrongColour), ...correct.slice(0, 10).map(wrongColour)])
  await expectMatchesRescan('painted the wrong colour on blank and correct pixels')
  drafts([...wrong.slice(0, 10), ...blank.slice(0, 20), ...correct.slice(0, 2)].map(erased))
  await expectMatchesRescan('erased the drafts again')

  // Enough small fixes to drop dead slots and fold appended marks back into one sorted run.
  for (let start = 0; start < blank.length; start += 30) {
    drafts(blank.slice(start, start + 30).map(right))
  }
  await expectMatchesRescan('fixed every blank pixel in small batches')

  // Accepted paint keeps counting after its draft is gone, until a newer tile read shows it.
  const submitted = wrong.slice(20, 30).map(right)
  drafts(submitted)
  await submit(submitted)
  drafts(wrong.slice(20, 30).map(erased))
  await expectMatchesRescan('accepted paint whose draft was cleared')
})
