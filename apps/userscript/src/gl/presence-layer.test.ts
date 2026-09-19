import type { RegionClaim } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TileQuad } from '../tile-transform.js'

const harness = vi.hoisted(() => ({
  map: null as object | null,
  regions: [] as RegionClaim[],
  quads: [] as TileQuad[],
  flags: { showPresence: true, showPresenceClaims: true, showPresenceViewports: true },
  raster: vi.fn(),
}))

vi.mock('@caelestis/shared', async (original) => {
  const shared = await original<typeof import('@caelestis/shared')>()
  return {
    ...shared,
    regionDocumentPixels: (...args: Parameters<typeof shared.regionDocumentPixels>) => {
      harness.raster()
      return shared.regionDocumentPixels(...args)
    },
  }
})
vi.mock('./renderer-core.js', () => ({ linkTemplateProgram: () => ({}), writeClipCorner: vi.fn() }))

vi.mock('../map-handle.js', () => ({ getMap: () => harness.map }))
vi.mock('../claim-editor.js', () => ({
  claimEditorPixels: () => null,
  claimEditorEditingIds: () => [],
}))
vi.mock('../debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../presence-client.js', () => ({
  presenceView: () => ({
    peers: [],
    regions: harness.regions,
    online: 0,
    connected: false,
    me: null,
  }),
}))
vi.mock('../state.js', () => ({ getState: () => harness.flags }))
vi.mock('../tile-transform.js', () => ({
  currentQuads: () => harness.quads,
  isDrawingTiles: () => harness.quads.length > 0,
}))

const orderedMap = (order: string[]) => {
  const moveLayer = vi.fn((id: string, before?: string) => {
    const from = order.indexOf(id)
    if (from >= 0) order.splice(from, 1)
    const target = before === undefined ? order.length : order.indexOf(before)
    order.splice(target < 0 ? order.length : target, 0, id)
  })
  const addLayer = vi.fn((layer: { id: string }, before?: string) => {
    const target = before === undefined ? order.length : order.indexOf(before)
    order.splice(target < 0 ? order.length : target, 0, layer.id)
  })
  return {
    moveLayer,
    map: {
      style: { _order: order },
      addLayer,
      getLayer: (id: string) => (order.includes(id) ? { id } : undefined),
      moveLayer,
    },
  }
}

afterEach(() => {
  harness.map = null
  harness.regions = []
  harness.quads = []
  harness.flags = { showPresence: true, showPresenceClaims: true, showPresenceViewports: true }
  harness.raster.mockClear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('claim preparation', () => {
  it('prepares complete unions but waits for visible pixels before uploading, then retains the mask across pans', async () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const calls = Object.fromEntries(
      [
        'createBuffer',
        'createVertexArray',
        'createTexture',
        'getUniformLocation',
        'getAttribLocation',
        'bindVertexArray',
        'bindBuffer',
        'bufferData',
        'enableVertexAttribArray',
        'vertexAttribPointer',
        'useProgram',
        'enable',
        'blendFunc',
        'disable',
        'uniform1f',
        'uniform1i',
        'uniform2f',
        'uniform3f',
        'activeTexture',
        'bindTexture',
        'pixelStorei',
        'texImage2D',
        'texParameteri',
        'bufferSubData',
        'drawArrays',
        'deleteTexture',
      ].map((name) => [name, vi.fn(() => ({}))]),
    )
    const gl = {
      ...calls,
      drawingBufferWidth: 100,
      drawingBufferHeight: 100,
    } as unknown as WebGL2RenderingContext
    const rect = { x: 500, y: 500, w: 20, h: 20 }
    const claim: RegionClaim = {
      id: 'claim',
      season: 0,
      surface: { kind: 'world', allianceId: null },
      templateId: null,
      claimant: { wplaceUserId: 1, displayName: 'Painter' },
      document: { items: [{ id: 'a', op: 'add', shape: { kind: 'rectangle', ...rect } }] },
      rect,
      label: '',
      createdAt: 1,
    }
    harness.regions = [claim]
    const tile = { tile: { x: 0, y: 0 }, x: 0, y: 0, width: 1000, height: 1000 }
    harness.quads = [tile]
    const { presenceLayer } = await import('./presence-layer.js')
    presenceLayer.onAdd(null, gl)
    presenceLayer.draw(gl)
    clock.mockReturnValue(500)
    presenceLayer.draw(gl)
    expect(harness.raster).toHaveBeenCalledOnce()
    expect(calls.texImage2D).not.toHaveBeenCalled()
    harness.quads = [{ ...tile, x: -450, y: -450 }]
    presenceLayer.draw(gl)
    expect(harness.raster).toHaveBeenCalledOnce()
    expect(calls.texImage2D).toHaveBeenCalledOnce()
    harness.quads = [tile]
    presenceLayer.draw(gl)
    harness.quads = [{ ...tile, x: -450, y: -450 }]
    presenceLayer.draw(gl)
    expect(calls.texImage2D).toHaveBeenCalledOnce()
    harness.flags.showPresenceClaims = false
    clock.mockReturnValue(501)
    presenceLayer.draw(gl)
    clock.mockReturnValue(1000)
    presenceLayer.draw(gl)
    harness.regions = [
      {
        ...claim,
        document: { items: [{ id: 'a', op: 'add', shape: { kind: 'ellipse', ...rect } }] },
      },
    ]
    presenceLayer.draw(gl)
    expect(harness.raster).toHaveBeenCalledOnce()
    expect(calls.deleteTexture).toHaveBeenCalledOnce()
  })
})

describe('installPresenceLayer', () => {
  it('puts presence over the art and markers, under the crosshair', async () => {
    const order = [
      'background',
      'caelestis-outline',
      'pixel-art-layer',
      'caelestis-overlay',
      'caelestis-markers',
      'pixel-hover',
    ]
    harness.map = orderedMap(order).map
    const { installPresenceLayer } = await import('./presence-layer.js')

    expect(installPresenceLayer()).toBe(true)
    expect(order).toEqual([
      'background',
      'caelestis-outline',
      'pixel-art-layer',
      'caelestis-overlay',
      'caelestis-markers',
      'caelestis-presence',
      'pixel-hover',
    ])
  })

  it('waits until the crosshair exists', async () => {
    harness.map = orderedMap(['background', 'pixel-art-layer']).map
    const { installPresenceLayer } = await import('./presence-layer.js')

    expect(installPresenceLayer()).toBe(false)
  })

  it('restores the layer after a style change displaces it', async () => {
    const order = [
      'background',
      'caelestis-presence',
      'pixel-art-layer',
      'caelestis-markers',
      'pixel-hover',
    ]
    const { map, moveLayer } = orderedMap(order)
    harness.map = map
    const { installPresenceLayer } = await import('./presence-layer.js')

    expect(installPresenceLayer()).toBe(true)
    expect(moveLayer).toHaveBeenCalledOnce()
    expect(order).toEqual([
      'background',
      'pixel-art-layer',
      'caelestis-markers',
      'caelestis-presence',
      'pixel-hover',
    ])
  })

  it('leaves a correctly ordered layer alone', async () => {
    const order = ['pixel-art-layer', 'caelestis-markers', 'caelestis-presence', 'pixel-hover']
    const { map, moveLayer } = orderedMap(order)
    harness.map = map
    const { installPresenceLayer } = await import('./presence-layer.js')

    expect(installPresenceLayer()).toBe(true)
    expect(moveLayer).not.toHaveBeenCalled()
  })
})
