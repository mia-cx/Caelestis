import { expect, it } from 'vitest'
import { cutPixels } from '../templates/sparse-pixels.js'
import { TEMPLATE_UPLOAD_PIXELS_PER_FRAME, TemplateGpuStore } from './template-gpu-store.js'

/** WebGL is a browser boundary: every call succeeds, and textures are plain objects. */
const fakeGl = (): WebGL2RenderingContext =>
  new Proxy({} as Record<string | symbol, unknown>, {
    get: (_target, key) => {
      if (key === 'getParameter') return () => 16384
      if (key === 'createTexture') return () => ({})
      return typeof key === 'string' && /^[A-Z_0-9]+$/.test(key) ? 0 : () => {}
    },
  }) as unknown as WebGL2RenderingContext

it('draws the visible chunks of a large template before the rest have uploaded', () => {
  // Six 1000×1000 chunks of about a million texels each, against a 512K-texel frame budget.
  const width = 3000
  const height = 2000
  const template = {
    id: 'large',
    width,
    height,
    artwork: { pixels: cutPixels(width, height, new Uint8Array(width * height).fill(5)) },
  }
  const view = [{ x: 2600, y: 1700, width: 400, height: 300 }]
  const store = new TemplateGpuStore(fakeGl())
  const advance = (frame: number) =>
    store.advance(template, TEMPLATE_UPLOAD_PIXELS_PER_FRAME, frame, view)

  advance(1)
  const second = advance(2)
  expect(second.status).toBe('pending')
  expect(second.entry?.indices.map(({ x, y }) => [x, y])).toEqual([[2000, 1000]])

  let frame = 3
  while (advance(frame).status === 'pending') frame++
  expect(
    store
      .entry('large')
      ?.indices.map(({ x, y }) => `${x},${y}`)
      .sort(),
  ).toEqual(['0,0', '0,1000', '1000,0', '1000,1000', '2000,0', '2000,1000'])
})
