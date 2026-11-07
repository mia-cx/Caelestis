import { WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { afterEach, expect, it } from 'vitest'
import { setState } from '../state.js'
import { clearAppearancePreview, setAppearancePreview } from '../templates/appearance-preview.js'
import type { PlacedTemplate } from '../templates/local-store.js'
import { cutPixels } from '../templates/sparse-pixels.js'
import { RenderScene } from './render-scene.js'

const shown: PlacedTemplate = {
  id: 'settled',
  name: 'Settled',
  source: 'image',
  originX: 0,
  originY: 0,
  width: 2,
  height: 1,
  artwork: { pixels: cutPixels(2, 1, new Uint8Array([5, 6])) },
  moved: 0,
  opaque: 2,
  tiles: new Set(),
  visible: true,
  everPlaced: true,
  appearance: null,
  revision: 0,
  owns: [],
  folderId: null,
}

afterEach(() => {
  setState({ hiddenColours: [] })
  clearAppearancePreview(shown.id)
})

it('reuses a settled scene until something outside the template changes', () => {
  const scene = new RenderScene()
  const frame = (now: number) => scene.advanceTemplates([shown], WORLD_TEMPLATE_SURFACE, now, false)
  frame(0)
  const settled = frame(1000)
  expect(settled.animating).toBe(false)
  expect(frame(2000)).toBe(settled)

  // The global colour filter lives in state, not in the template.
  setState({ hiddenColours: [5] })
  frame(3000)
  const filtered = frame(4000).templates[0]?.palette
  expect(filtered?.[5 * 4 + 3]).toBe(0)
  expect(filtered?.[6 * 4 + 3]).toBe(255)

  // A slider gesture previews without touching state.
  setAppearancePreview(shown.id, 'opacity', 0.25)
  frame(5000)
  expect(frame(6000).templates[0]?.appearance.opacity).toBe(0.25)
})
