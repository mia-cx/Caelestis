import { WPLACE_PALETTE } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Wplace refetches visible tiles, usually with identical bytes. Capturing a tile reads back a full
 * 1000x1000 canvas, so an unchanged refetch must not pay for it again, and a changed or otherwise
 * untrustworthy one always must. The page realm (fetch, Blob, createImageBitmap, OffscreenCanvas)
 * is Wplace's boundary and is faked; the capture pipeline under test is the production one.
 */
const TILE = { x: 100, y: 200 }

let stopCapture: (() => void) | undefined

/**
 * The fakes' tile format: a leading zero byte is Wplace's 1x1 "nothing painted here" tile; otherwise
 * each later byte paints the next pixel that palette colour.
 */
interface FakeBitmap {
  readonly width: number
  readonly height: number
  readonly colours: Uint8Array
  close(): void
}

const decode = async (source: Blob): Promise<FakeBitmap> => {
  const bytes = new Uint8Array(await source.arrayBuffer())
  const size = bytes[0] === 0 ? 1 : 1_000
  return { width: size, height: size, colours: bytes.subarray(1), close() {} }
}

/** What a canvas reads back after drawing a fake bitmap. */
const rgbaOf = (bitmap: FakeBitmap) => {
  const data = new Uint8ClampedArray(4_000_000)
  bitmap.colours.forEach((colour, p) => {
    const [r, g, b] = WPLACE_PALETTE[colour]?.rgb ?? [0, 0, 0]
    data.set([r, g, b, 255], p * 4)
  })
  return { data }
}

const canvasReadingBackWith = (readback: (bitmap: FakeBitmap) => { data: Uint8ClampedArray }) =>
  class {
    getContext() {
      let drawn: FakeBitmap | undefined
      return {
        clearRect() {},
        drawImage(bitmap: FakeBitmap) {
          drawn = bitmap
        },
        getImageData: () => readback(drawn as FakeBitmap),
      }
    }
  }

/**
 * The production tile reader worker, run in this realm from the source the page starts it from.
 * Only the worker's own globals are faked: its network, decoder and canvas. `hold` pauses decodes
 * until the returned function is called.
 */
const inProcessWorker = (served: (url: string) => Response) => {
  const readback = vi.fn(rgbaOf)
  const fetch = vi.fn(async (url: string) => served(url))
  let gate = Promise.resolve()
  const sources = new Map<string, Blob>()
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:tile-reader/${sources.size}`
    sources.set(url, blob as Blob)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal(
    'Worker',
    class extends EventTarget {
      readonly scope = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage: (data: unknown) => this.dispatchEvent(new MessageEvent('message', { data })),
        crypto: globalThis.crypto,
      }
      readonly started: Promise<void>
      constructor(url: string) {
        super()
        this.started = (sources.get(url) as Blob).text().then((source) => {
          new Function('self', 'fetch', 'createImageBitmap', 'OffscreenCanvas', source)(
            this.scope,
            fetch,
            async (body: Blob) => {
              await gate
              return decode(body)
            },
            canvasReadingBackWith(readback),
          )
        })
      }
      postMessage(data: unknown) {
        void this.started.then(() => this.scope.onmessage?.({ data }))
      }
      terminate() {}
    },
  )
  const hold = () => {
    let release = () => {}
    gate = new Promise((resolve) => {
      release = resolve
    })
    return release
  }
  return { readback, fetch, hold }
}

const setup = async () => {
  vi.stubGlobal('navigator', { deviceMemory: 1 })
  vi.resetModules()
  const tileTransform = await import('../src/tile-transform.js')
  const { resetWplacePatches, setWplacePatchEnabled } = await import('../src/wplace-patches.js')
  resetWplacePatches()

  const readback = vi.fn(rgbaOf)
  vi.stubGlobal('OffscreenCanvas', canvasReadingBackWith(readback))
  let body = new Uint8Array([1, 2, 3])
  const digest = vi.fn((algorithm: AlgorithmIdentifier, data: BufferSource) =>
    globalThis.crypto.subtle.digest(algorithm, data),
  )
  /** Wplace's backend, behind the fetch tap that `install` puts in front of it. */
  const backend = vi.fn(async (url: string) =>
    url.endsWith('/paint') ? Response.json({ painted: 1 }) : new Response(body),
  )
  const realm = {
    ...globalThis,
    Object,
    Request,
    URL,
    Response,
    ArrayBuffer,
    Blob,
    crypto: { subtle: { digest } },
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

  /** Wplace's own tile path: fetch, read the body, build a Blob, decode it. */
  const decodeTile = async (x = TILE.x, bytes = new Uint8Array([1, 2, 3])) => {
    body = bytes
    const response = await realm.fetch(`https://backend.wplace.live/files/s0/tiles/${x}/200.png`)
    return realm.createImageBitmap(new realm.Blob([await response.arrayBuffer()]))
  }
  /** Wplace's tile path, and Caelestis's capture of it. */
  const fetchTile = async (x = TILE.x, bytes = new Uint8Array([1, 2, 3])) => {
    await decodeTile(x, bytes)
    await tileTransform.settledTileCaptures()
  }
  const paint = async () => {
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
        tiles: [{ ...TILE, pixels: { x: [3], y: [4], colors: [5] } }],
      }),
    })
    await accepted
  }
  /** What the backend answers from now on, without Wplace asking. */
  const serve = (bytes: typeof body) => {
    body = bytes
  }
  return {
    tileTransform,
    setWplacePatchEnabled,
    readback,
    digest,
    decodeTile,
    fetchTile,
    paint,
    backend,
    serve,
  }
}

afterEach(() => {
  stopCapture?.()
  stopCapture = undefined
  vi.unstubAllGlobals()
})

describe('tile reads in the worker', () => {
  it('hands Wplace its bitmap while the tile is still being read', async () => {
    const worker = inProcessWorker(() => new Response(null, { status: 500 }))
    const release = worker.hold()
    const { tileTransform, readback, decodeTile } = await setup()
    const bitmap = await decodeTile(TILE.x, Uint8Array.of(1, 5, 9))
    expect(bitmap.width).toBe(1_000)
    expect(tileTransform.tilePixels(TILE)).toBeNull()
    release()
    await tileTransform.settledTileCaptures()
    expect(tileTransform.tilePixels(TILE)?.slice(0, 3)).toEqual(Uint8Array.of(5, 9, 255))
    expect(worker.readback).toHaveBeenCalledTimes(1)
    expect(readback).not.toHaveBeenCalled()
  })

  it('applies a re-read as a diff into the same pixels', async () => {
    inProcessWorker(() => new Response(null, { status: 500 }))
    const { tileTransform, fetchTile } = await setup()
    const changes: number[][] = []
    tileTransform.onTilePixels((_tile, triples, source) => {
      if (source === 'server') changes.push([...triples])
    })
    await fetchTile(TILE.x, Uint8Array.of(1, 5, 9))
    const pixels = tileTransform.tilePixels(TILE)
    await fetchTile(TILE.x, Uint8Array.of(1, 5, 7))
    expect(tileTransform.tilePixels(TILE)).toBe(pixels)
    expect(pixels?.slice(0, 3)).toEqual(Uint8Array.of(5, 7, 255))
    expect(changes).toEqual([[1, 0, 7]])
  })

  it('drops a read that a newer, unchanged refetch overtook', async () => {
    const worker = inProcessWorker(() => new Response(null, { status: 500 }))
    const { tileTransform, decodeTile, fetchTile } = await setup()
    await fetchTile(TILE.x, Uint8Array.of(1, 5))
    const release = worker.hold()
    await decodeTile(TILE.x, Uint8Array.of(1, 6))
    // Back to the bytes already captured, so this one is settled without a read, ahead of the other.
    await decodeTile(TILE.x, Uint8Array.of(1, 5))
    release()
    await tileTransform.settledTileCaptures()
    expect(tileTransform.tilePixels(TILE)?.[0]).toBe(5)
  })
})

describe('missed tiles', () => {
  it('reads on the page when the worker is refused after it was created', async () => {
    // A page CSP lets the Worker construct, then reports the refusal as an error event.
    vi.stubGlobal(
      'Worker',
      class extends EventTarget {
        constructor() {
          super()
          setTimeout(() => this.dispatchEvent(new Event('error')))
        }
        postMessage() {}
        terminate() {}
      },
    )
    const { tileTransform, backend, fetchTile } = await setup()
    await fetchTile()
    expect(tileTransform.tilePixels(TILE)).not.toBeNull()
    backend.mockClear()
    const missed = { x: TILE.x + 1, y: TILE.y }
    tileTransform.ensureTilePixels(missed)
    await vi.waitFor(() => expect(tileTransform.tilePixels(missed)).not.toBeNull())
    expect(backend.mock.calls.map(([url]) => url)).toEqual([
      'https://backend.wplace.live/files/s0/tiles/101/200.png',
    ])
  })
})

describe('unchanged tile capture', () => {
  it('skips the readback for identical bytes and reads changed bytes again', async () => {
    const { tileTransform, readback, fetchTile } = await setup()
    await fetchTile()
    await fetchTile()
    expect(readback).toHaveBeenCalledTimes(1)
    expect(tileTransform.tilePixels(TILE)).not.toBeNull()
    await fetchTile(TILE.x, new Uint8Array([1, 2, 4]))
    expect(readback).toHaveBeenCalledTimes(2)
  })

  it('reads identical bytes again once the retained pixels were evicted', async () => {
    const { readback, fetchTile } = await setup()
    await fetchTile()
    for (let x = 101; x <= 124; x++) await fetchTile(x, new Uint8Array([0]))
    await fetchTile()
    expect(readback).toHaveBeenCalledTimes(2)
  })

  it('keeps the answer for a repeated empty tile', async () => {
    const { tileTransform, readback, fetchTile } = await setup()
    await fetchTile(TILE.x, new Uint8Array([0]))
    await fetchTile(TILE.x, new Uint8Array([0]))
    expect(tileTransform.tilePixels(TILE)?.[0]).toBe(tileTransform.UNPAINTED)
    expect(readback).not.toHaveBeenCalled()
  })

  it('reads identical bytes while accepted paint awaits a newer observation', async () => {
    const { readback, fetchTile, paint } = await setup()
    await fetchTile()
    await paint()
    await fetchTile()
    expect(readback).toHaveBeenCalledTimes(2)
  })

  it('reads identical bytes after a draft wrote to the tile', async () => {
    const { tileTransform, readback, fetchTile } = await setup()
    await fetchTile()
    tileTransform.captureDraftPixels(TILE, new Uint8Array(1_000_000).fill(tileTransform.UNPAINTED))
    await fetchTile()
    expect(readback).toHaveBeenCalledTimes(2)
  })

  it('reads every refetch when switched off', async () => {
    const { setWplacePatchEnabled, readback, digest, fetchTile } = await setup()
    setWplacePatchEnabled('capture-dedupe', false)
    await fetchTile()
    await fetchTile()
    expect(readback).toHaveBeenCalledTimes(2)
    expect(digest).not.toHaveBeenCalled()
  })

  it('reads the tile when hashing fails', async () => {
    const { digest, readback, fetchTile } = await setup()
    await fetchTile()
    digest.mockRejectedValueOnce(new Error('unavailable'))
    await fetchTile()
    expect(readback).toHaveBeenCalledTimes(2)
  })
})

describe('reload on request', () => {
  it('re-reads kept tiles off screen and leaves the visible ones to Wplace', async () => {
    const { tileTransform, readback, fetchTile, backend, serve } = await setup()
    await fetchTile(100)
    await fetchTile(101)
    backend.mockClear()
    readback.mockClear()
    // Tile 100 changed while nobody looked; tile 101 is on screen, where Wplace reloads it.
    serve(new Uint8Array([1, 2, 4]))
    await tileTransform.rereadKeptTiles([{ x: 101, y: 200 }])
    expect(backend.mock.calls.map(([url]) => url)).toEqual([
      'https://backend.wplace.live/files/s0/tiles/100/200.png',
    ])
    expect(readback).toHaveBeenCalledTimes(1)
  })

  it('skips the readback for kept tiles that did not change', async () => {
    const { tileTransform, readback, fetchTile } = await setup()
    await fetchTile()
    readback.mockClear()
    await tileTransform.rereadKeptTiles([])
    expect(readback).not.toHaveBeenCalled()
  })

  it('re-reads through the worker, past the page fetch, and skips unchanged tiles', async () => {
    // The server's real tile, as the worker fetches it, while the page's fetch may be rewritten.
    let served = new Uint8Array([1, 2, 3])
    const worker = inProcessWorker(() => new Response(served))
    const { tileTransform, fetchTile, backend } = await setup()
    await fetchTile()
    backend.mockClear()
    worker.readback.mockClear()
    await tileTransform.rereadKeptTiles([])
    expect(worker.fetch).toHaveBeenCalledTimes(1)
    expect(backend).not.toHaveBeenCalled()
    expect(worker.readback).not.toHaveBeenCalled()
    served = new Uint8Array([1, 2, 4])
    await tileTransform.rereadKeptTiles([])
    expect(worker.readback).toHaveBeenCalledTimes(1)
    expect(tileTransform.tilePixels(TILE)?.[1]).toBe(4)
  })
})
