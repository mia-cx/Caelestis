// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { createScreenProjectionCache } from './coordinates.js'

it('invalidates ancestor movement without observing per-frame label writes', async () => {
  const parent = document.createElement('div')
  const canvas = document.createElement('canvas')
  const labels = document.createElement('div')
  const label = document.createElement('span')
  labels.append(label)
  parent.append(canvas, labels)
  document.body.append(parent)
  const bounds = { left: 0, top: 0, width: 100, height: 100 }
  const read = vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(() => ({
    ...bounds,
    right: bounds.left + 100,
    bottom: 100,
    x: bounds.left,
    y: 0,
    toJSON() {},
  }))
  const frame = { canvas, quads: [{ tile: { x: 0, y: 0 }, x: 0, y: 0, width: 100, height: 100 }] }
  const cache = createScreenProjectionCache()
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    cache.project(frame)
    label.style.transform = 'translate(5px, 5px)'
    await settle()
    cache.project(frame)
    expect(read).toHaveBeenCalledTimes(1)
    bounds.left = 32
    parent.style.transform = 'translateX(32px)'
    await settle()
    expect(cache.project(frame)?.canvasBox.left).toBe(32)
    expect(read).toHaveBeenCalledTimes(2)
    parent.prepend(document.createElement('div'))
    await settle()
    cache.project(frame)
    expect(read).toHaveBeenCalledTimes(3)
  } finally {
    cache.dispose()
    parent.remove()
  }
})
