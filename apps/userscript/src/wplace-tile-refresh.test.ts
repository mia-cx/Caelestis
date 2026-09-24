import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetWplacePatches, setWplacePatchEnabled } from './wplace-patches.js'
import {
  installServiceWorkerTap,
  patchTileRefresh,
  watchCaptureScope,
} from './wplace-tile-refresh.js'

const A = { x: 1, y: 2, z: 11 }
const B = { x: 3, y: 4, z: 11 }
const C = { x: 5, y: 6, z: 11 }
const D = { x: 7, y: 8, z: 11 }

const realm = () => {
  const frames: FrameRequestCallback[] = []
  const listeners: ((event: { data: unknown }) => void)[] = []
  const calls: { receiver: unknown; args: unknown[] }[] = []
  class Worker {
    postMessage(...args: unknown[]) {
      calls.push({ receiver: this, args })
      return 'sent'
    }
  }
  const page = {
    ServiceWorker: Worker,
    navigator: {
      serviceWorker: {
        addEventListener: (_type: string, listener: (event: { data: unknown }) => void) =>
          listeners.push(listener),
      },
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    },
    setTimeout,
    clearTimeout,
    fetch: vi.fn(),
    AbortController,
  }
  vi.stubGlobal('window', page)
  return {
    page,
    worker: new Worker(),
    calls,
    flush: () => {
      for (const callback of frames.splice(0)) callback(0)
    },
    message: (data: unknown) => {
      for (const listener of listeners) listener({ data })
    },
  }
}

const preview = (tile: { x: number; y: number }, x = 1, color = 10) => ({
  tile: [tile.x, tile.y],
  pixel: [x, 2],
  // Wplace's live season. It must never be mistaken for the tile zoom (11).
  season: 0,
  color: { r: color, g: 0, b: 0, a: 255 },
})

const fakeMap = (tiles = [A, B, C, D]) => {
  const reset = vi.fn()
  const errored = new Set<typeof A>()
  const manager = {
    _inViewTiles: {
      getAllTiles: () =>
        tiles.map((tile) => ({
          tileID: { canonical: tile },
          state: errored.has(tile) ? 'errored' : 'loaded',
        })),
    },
    _outOfViewCache: { reset },
  }
  const source = {
    tiles: ['https://backend.wplace.live/files/s0/tiles/{x}/{y}.png'],
    minzoom: 11,
    maxzoom: 11,
  }
  const original = vi.fn(function (this: unknown, _id: string, _tiles?: unknown) {
    return this
  })
  const map = {
    getSource: (id: string) => (id === 'pixel-art-layer' ? source : undefined),
    style: { tileManagers: { 'pixel-art-layer': manager } },
    refreshTiles: original,
  }
  patchTileRefresh(map)
  return { map, original, reset, source, manager, errored }
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  resetWplacePatches()
})

describe('periodic tile refresh', () => {
  it('passes other sources and explicit tile lists through unchanged', () => {
    realm()
    const { map, original } = fakeMap()
    map.refreshTiles('other')
    map.refreshTiles('pixel-art-layer', [A])
    expect(original.mock.calls).toEqual([['other'], ['pixel-art-layer', [A]]])
  })

  it('reloads unknown, changed, and unverifiable tiles but skips unchanged ones', async () => {
    const { page } = realm()
    const replies = new Map([
      ['1/2', 'a'],
      ['3/4', 'a'],
      ['5/6', 'a'],
      ['7/8', 'a'],
    ])
    page.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      expect(init).toMatchObject({ method: 'HEAD' })
      expect(init.signal).toBeInstanceOf(AbortSignal)
      const key = /tiles\/(\d+\/\d+)\.png/.exec(url)?.[1] ?? ''
      const value = replies.get(key)
      if (value === 'fail') throw new Error('network')
      if (value === 'refused') return { ok: false }
      return {
        ok: true,
        headers: {
          get: (name: string) =>
            name === 'Last-Modified' ? (value === 'no-date' ? null : value) : '200000',
        },
      }
    })
    const { map, original, reset, manager } = fakeMap()
    map.refreshTiles('pixel-art-layer')
    expect(reset).toHaveBeenCalledTimes(1)
    await settle()
    expect(original).toHaveBeenLastCalledWith('pixel-art-layer', [A, B, C, D])

    replies.set('3/4', 'b')
    replies.set('5/6', 'refused')
    replies.set('7/8', 'fail')
    const nextTiles = [A, B, C, D, { x: 9, y: 10, z: 11 }]
    // A new in-view tile has no previous signature.
    manager._inViewTiles.getAllTiles = () =>
      nextTiles.map((tile) => ({ tileID: { canonical: tile }, state: 'loaded' }))
    replies.set('9/10', 'a')
    map.refreshTiles('pixel-art-layer')
    await settle()
    expect(reset).toHaveBeenCalledTimes(2)
    expect(original).toHaveBeenLastCalledWith('pixel-art-layer', [B, C, D, nextTiles[4]])
    expect(original).toHaveBeenCalledTimes(2)

    replies.set('5/6', 'no-date')
    map.refreshTiles('pixel-art-layer')
    await settle()
    expect(original).toHaveBeenCalledTimes(3)
    // A refused, dateless, or failed check never counts as unchanged.
    expect(original).toHaveBeenLastCalledWith('pixel-art-layer', [C, D])
  })

  it('treats a new source URL as unknown even when headers match', async () => {
    const { page } = realm()
    page.fetch.mockResolvedValue({ ok: true, headers: { get: () => 'a' } })
    const { map, original, source } = fakeMap([A])
    map.refreshTiles('pixel-art-layer')
    await settle()
    source.tiles[0] = 'https://backend.wplace.live/files/s12/tiles/{x}/{y}.png'
    map.refreshTiles('pixel-art-layer')
    await settle()
    expect(original).toHaveBeenCalledTimes(2)
    expect(original).toHaveBeenLastCalledWith('pixel-art-layer', [A])
  })

  it('runs a full refresh every tenth periodic call and after ninety seconds', async () => {
    const { page } = realm()
    page.fetch.mockResolvedValue({ ok: true, headers: { get: () => 'a' } })
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    const { map, original } = fakeMap([A])
    for (let i = 0; i < 10; i++) {
      map.refreshTiles('pixel-art-layer')
      await settle()
    }
    expect(original).toHaveBeenLastCalledWith('pixel-art-layer')
    expect(page.fetch).toHaveBeenCalledTimes(9)
    now.mockReturnValue(90_001)
    map.refreshTiles('pixel-art-layer')
    expect(original).toHaveBeenLastCalledWith('pixel-art-layer')
    expect(page.fetch).toHaveBeenCalledTimes(9)
  })

  it('recovers from a HEAD that never answers once its deadline passes', async () => {
    vi.useFakeTimers()
    const { page } = realm()
    page.fetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    const { map, original } = fakeMap([A])
    map.refreshTiles('pixel-art-layer')
    map.refreshTiles('pixel-art-layer')
    expect(page.fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    // The stalled round ended as a failed check, so its tile reloads and the next round runs.
    expect(original).toHaveBeenLastCalledWith('pixel-art-layer', [A])
    map.refreshTiles('pixel-art-layer')
    expect(page.fetch).toHaveBeenCalledTimes(2)
  })

  it('reloads a tile whose last reload failed even when its signature is unchanged', async () => {
    const { page } = realm()
    page.fetch.mockResolvedValue({
      ok: true,
      headers: { get: (name: string) => (name === 'Last-Modified' ? 'same' : '200000') },
    })
    const { map, original, errored } = fakeMap([A, B])
    map.refreshTiles('pixel-art-layer')
    await settle()
    expect(original).toHaveBeenLastCalledWith('pixel-art-layer', [A, B])
    errored.add(B)
    map.refreshTiles('pixel-art-layer')
    await settle()
    expect(original).toHaveBeenLastCalledWith('pixel-art-layer', [B])
  })

  it('drops an overlapping call and skips results after its source disappears', async () => {
    const { page } = realm()
    let resolve!: (value: unknown) => void
    page.fetch.mockReturnValue(new Promise((done) => (resolve = done)))
    const { map, original } = fakeMap([A])
    map.refreshTiles('pixel-art-layer')
    map.refreshTiles('pixel-art-layer')
    expect(page.fetch).toHaveBeenCalledOnce()
    expect(original).not.toHaveBeenCalled()
    map.getSource = () => undefined
    resolve({ ok: true, headers: { get: () => 'a' } })
    await settle()
    expect(original).not.toHaveBeenCalled()
  })

  it('passes through when both switches are off', () => {
    realm()
    setWplacePatchEnabled('tile-refresh', false)
    setWplacePatchEnabled('draft-refresh', false)
    const { map, original } = fakeMap()
    map.refreshTiles('pixel-art-layer')
    expect(original).toHaveBeenCalledWith('pixel-art-layer')
  })

  it('falls back to a full refresh when MapLibre cache internals are unavailable', () => {
    realm()
    const { map, original, manager } = fakeMap()
    manager._outOfViewCache.reset = undefined as never
    map.refreshTiles('pixel-art-layer')
    expect(original).toHaveBeenCalledWith('pixel-art-layer')
  })
})

describe('capture scope refresh', () => {
  it('re-reads every visible tile once when capture starts caring about more', async () => {
    vi.useFakeTimers()
    realm()
    const { original } = fakeMap()
    const scope = watchCaptureScope()
    scope(['paint', 'one@0,0'])
    scope(['paint', 'one@0,0', 'two@5,5'])
    await vi.advanceTimersByTimeAsync(0)
    // Two widenings in one task are one full refresh, with no tile list.
    expect(original.mock.calls).toEqual([['pixel-art-layer']])

    scope(['paint', 'one@0,0', 'two@5,5'])
    scope(['one@0,0'])
    await vi.advanceTimersByTimeAsync(0)
    expect(original).toHaveBeenCalledTimes(1)

    scope(['one@0,0', 'one@9,9'])
    await vi.advanceTimersByTimeAsync(0)
    expect(original).toHaveBeenCalledTimes(2)
  })

  it('holds a widened scope until a live map is patched, then refreshes that map once', async () => {
    vi.useFakeTimers()
    realm()
    vi.resetModules()
    const refresh = await import('./wplace-tile-refresh.js')
    const patched = (connected: boolean) => {
      const original = vi.fn()
      refresh.patchTileRefresh({
        getCanvas: () => ({ isConnected: connected }),
        getSource: () => ({ tiles: ['https://backend.wplace.live/files/s0/tiles/{x}/{y}.png'] }),
        style: { tileManagers: {} },
        refreshTiles: original,
      })
      return original
    }
    refresh.watchCaptureScope()(['paint'])
    await vi.advanceTimersByTimeAsync(0)
    // A map Wplace already replaced cannot take the refresh either.
    const replaced = patched(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(replaced).not.toHaveBeenCalled()
    const current = patched(true)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(current.mock.calls).toEqual([['pixel-art-layer']])
  })

  it('leaves refreshing to Wplace when conditional refresh is switched off', async () => {
    vi.useFakeTimers()
    realm()
    const { original } = fakeMap()
    setWplacePatchEnabled('tile-refresh', false)
    watchCaptureScope()(['paint'])
    await vi.advanceTimersByTimeAsync(0)
    expect(original).not.toHaveBeenCalled()
  })
})

describe('draft refresh', () => {
  it('diffs changed pixels and clearPixelPreview across frames', () => {
    const { page, worker, flush } = realm()
    installServiceWorkerTap(page as unknown as Window & typeof globalThis)
    const { map, original, reset } = fakeMap()
    worker.postMessage({ type: 'previewPixels', data: [preview(A), preview(B)] })
    map.refreshTiles('pixel-art-layer')
    expect(original).not.toHaveBeenCalled()
    flush()
    expect(original).toHaveBeenLastCalledWith('pixel-art-layer', [A, B])
    worker.postMessage({ type: 'previewPixels', data: [preview(A), preview(B, 1, 20)] })
    map.refreshTiles('pixel-art-layer')
    flush()
    expect(original).toHaveBeenLastCalledWith('pixel-art-layer', [B])
    worker.postMessage({ type: 'clearPixelPreview' })
    map.refreshTiles('pixel-art-layer')
    flush()
    expect(original).toHaveBeenLastCalledWith('pixel-art-layer', [A, B])
    expect(reset).toHaveBeenCalledTimes(3)
  })

  it('merges the refreshes of one brush stroke into one reload per frame', () => {
    const { page, worker, flush } = realm()
    installServiceWorkerTap(page as unknown as Window & typeof globalThis)
    const { map, original } = fakeMap()
    worker.postMessage({ type: 'previewPixels', data: [preview(A)] })
    map.refreshTiles('pixel-art-layer')
    worker.postMessage({ type: 'previewPixels', data: [preview(A), preview(B)] })
    map.refreshTiles('pixel-art-layer')
    flush()
    expect(original).toHaveBeenCalledTimes(1)
    expect(original).toHaveBeenLastCalledWith('pixel-art-layer', [A, B])
  })

  it('keeps periodic checks running through the idle clearPixelPreview keep-alive', async () => {
    const { page, worker } = realm()
    page.fetch.mockResolvedValue({
      ok: true,
      headers: { get: (name: string) => (name === 'Last-Modified' ? 'same' : '200000') },
    })
    installServiceWorkerTap(page as unknown as Window & typeof globalThis)
    const { map, original } = fakeMap()
    // Wplace posts this every few seconds with nothing drafted.
    worker.postMessage({ type: 'clearPixelPreview' })
    map.refreshTiles('pixel-art-layer')
    await settle()
    expect(page.fetch).toHaveBeenCalledTimes(4)
    expect(original).toHaveBeenLastCalledWith('pixel-art-layer', [A, B, C, D])

    worker.postMessage({ type: 'clearPixelPreview' })
    map.refreshTiles('pixel-art-layer')
    await settle()
    expect(page.fetch).toHaveBeenCalledTimes(8)
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('checks tiles instead of dropping a refresh when drafts net out to no change', async () => {
    const { page, worker, flush } = realm()
    page.fetch.mockResolvedValue({
      ok: true,
      headers: { get: (name: string) => (name === 'Last-Modified' ? 'same' : '200000') },
    })
    installServiceWorkerTap(page as unknown as Window & typeof globalThis)
    const { map } = fakeMap()
    worker.postMessage({ type: 'previewPixels', data: [preview(A)] })
    worker.postMessage({ type: 'clearPixelPreview' })
    map.refreshTiles('pixel-art-layer')
    flush()
    await settle()
    expect(page.fetch).toHaveBeenCalledTimes(4)
  })

  it('uses the timeout when the animation frame does not run', () => {
    vi.useFakeTimers()
    const { page, worker } = realm()
    installServiceWorkerTap(page as unknown as Window & typeof globalThis)
    const { map, original } = fakeMap()
    worker.postMessage({ type: 'previewPixels', data: [preview(A)] })
    map.refreshTiles('pixel-art-layer')
    vi.advanceTimersByTime(100)
    expect(original).toHaveBeenCalledWith('pixel-art-layer', [A])
    vi.useRealTimers()
  })

  it('uses a full refresh when draft narrowing is switched off', () => {
    const { page, worker } = realm()
    installServiceWorkerTap(page as unknown as Window & typeof globalThis)
    setWplacePatchEnabled('draft-refresh', false)
    const { map, original } = fakeMap()
    worker.postMessage({ type: 'previewPixels', data: [preview(A)] })
    map.refreshTiles('pixel-art-layer')
    expect(original).toHaveBeenCalledWith('pixel-art-layer')
  })

  it.each(['paintPixels', 'unpaintPixels', 'refreshPixelArt'])(
    'passes through page-sent %s',
    (type) => {
      const { page, worker } = realm()
      installServiceWorkerTap(page as unknown as Window & typeof globalThis)
      const { map, original } = fakeMap()
      worker.postMessage({ type })
      map.refreshTiles('pixel-art-layer')
      expect(original).toHaveBeenCalledWith('pixel-art-layer')
    },
  )

  it('passes through unsolicited worker refreshPixelArt before the page listener runs', () => {
    const { page, message } = realm()
    installServiceWorkerTap(page as unknown as Window & typeof globalThis)
    const { map, original } = fakeMap()
    message({ type: 'refreshPixelArt' })
    map.refreshTiles('pixel-art-layer')
    expect(original).toHaveBeenCalledWith('pixel-art-layer')
  })

  it('keeps postMessage arguments, receiver, and result intact despite observation errors', () => {
    const { page, worker, calls } = realm()
    installServiceWorkerTap(page as unknown as Window & typeof globalThis)
    expect(worker.postMessage({ type: 'previewPixels', data: null }, ['transfer'])).toBe('sent')
    expect(calls).toEqual([
      { receiver: worker, args: [{ type: 'previewPixels', data: null }, ['transfer']] },
    ])
  })

  it('preserves an error from the original postMessage', () => {
    const { page, worker } = realm()
    page.ServiceWorker.prototype.postMessage = () => {
      throw new Error('original failure')
    }
    installServiceWorkerTap(page as unknown as Window & typeof globalThis)
    expect(() => worker.postMessage({ type: 'previewPixels', data: [] })).toThrow(
      'original failure',
    )
  })
})
