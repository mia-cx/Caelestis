import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Wplace refetches visible tiles, usually with identical bytes. Capturing a tile reads back a full
 * 1000x1000 canvas, so an unchanged refetch must not pay for it again, and a changed or otherwise
 * untrustworthy one always must. The page realm (fetch, Blob, createImageBitmap, OffscreenCanvas)
 * is Wplace's boundary and is faked; the capture pipeline under test is the production one.
 */
const TILE = { x: 100, y: 200 }

let stopCapture: (() => void) | undefined

const setup = async () => {
  vi.stubGlobal('navigator', { deviceMemory: 1 })
  vi.resetModules()
  const tileTransform = await import('../src/tile-transform.js')
  const { resetWplacePatches, setWplacePatchEnabled } = await import('../src/wplace-patches.js')
  resetWplacePatches()

  const readback = vi.fn(() => ({ data: new Uint8ClampedArray(4_000_000) }))
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return { clearRect() {}, drawImage() {}, getImageData: readback }
      }
    },
  )
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
    // A leading zero byte stands for Wplace's 1x1 "nothing painted here" tile.
    createImageBitmap: vi.fn(async (source: Blob) => {
      const size = new Uint8Array(await source.arrayBuffer())[0] === 0 ? 1 : 1_000
      return { width: size, height: size, close() {} } as ImageBitmap
    }),
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
  const fetchTile = async (x = TILE.x, bytes = new Uint8Array([1, 2, 3])) => {
    body = bytes
    const response = await realm.fetch(`https://backend.wplace.live/files/s0/tiles/${x}/200.png`)
    await realm.createImageBitmap(new realm.Blob([await response.arrayBuffer()]))
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
    const workerReads = vi.fn(async () => ({
      bitmap: { width: 1_000, height: 1_000, close() {} },
      digest: await globalThis.crypto.subtle.digest('SHA-256', served),
    }))
    vi.stubGlobal(
      'Worker',
      class extends EventTarget {
        postMessage({ id }: { id: number }) {
          void workerReads().then((tile) =>
            this.dispatchEvent(new MessageEvent('message', { data: { id, ...tile } })),
          )
        }
        terminate() {}
      },
    )
    const { tileTransform, readback, fetchTile, backend } = await setup()
    await fetchTile()
    backend.mockClear()
    readback.mockClear()
    await tileTransform.rereadKeptTiles([])
    expect(workerReads).toHaveBeenCalledTimes(1)
    expect(backend).not.toHaveBeenCalled()
    expect(readback).not.toHaveBeenCalled()
    served = new Uint8Array([1, 2, 4])
    await tileTransform.rereadKeptTiles([])
    expect(readback).toHaveBeenCalledTimes(1)
  })
})
