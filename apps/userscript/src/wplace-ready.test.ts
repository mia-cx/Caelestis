// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { isWplaceMapReady, whenWplaceMapReady } from './wplace-ready.js'

const mapCanvas = (): HTMLCanvasElement => {
  const container = document.createElement('div')
  container.id = 'map'
  const canvas = document.createElement('canvas')
  canvas.className = 'maplibregl-canvas'
  container.append(canvas)
  document.body.append(container)
  return canvas
}

describe('Wplace map readiness', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
  })

  it('is not ready before Wplace builds its map canvas', () => {
    document.dispatchEvent(new Event('DOMContentLoaded'))
    expect(isWplaceMapReady()).toBe(false)
  })

  it('is ready once the MapLibre canvas is in the document', () => {
    mapCanvas()
    expect(isWplaceMapReady()).toBe(true)
  })

  it('resolves immediately when the canvas already exists', async () => {
    mapCanvas()
    const wait = vi.fn(async () => {})
    await whenWplaceMapReady(isWplaceMapReady, wait)
    expect(wait).not.toHaveBeenCalled()
  })

  it('keeps waiting until the canvas appears and never gives up on its own', async () => {
    let polls = 0
    const wait = vi.fn(async () => {
      polls++
      if (polls === 40) mapCanvas()
    })
    await whenWplaceMapReady(isWplaceMapReady, wait)
    expect(wait).toHaveBeenCalledTimes(40)
    expect(wait).toHaveBeenLastCalledWith(250)
  })
})
