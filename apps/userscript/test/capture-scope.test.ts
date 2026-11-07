import { expect, it, vi } from 'vitest'
import * as store from '../src/templates/local-store.js'
import { captureScopeTiles } from '../src/templates/mismatch.js'

vi.mock('../src/main.js', () => ({ repaint: () => {}, viewportCentre: () => null }))

it('grows the capture scope only when a dragged template reaches a new tile', async () => {
  const id = `capture-scope-${crypto.randomUUID()}`
  await store.addLocalTemplate(
    {
      id,
      name: 'Dragged',
      source: 'wplace',
      originX: 1_800,
      originY: 3_500,
      width: 100,
      height: 100,
      indices: new Uint8Array(100 * 100).fill(1),
      moved: 0,
      opaque: 100 * 100,
    },
    undefined,
    true,
  )
  expect([...captureScopeTiles()]).toEqual(['1/3'])

  store.previewLocalTemplate(id, 1_850, 3_500)
  expect([...captureScopeTiles()]).toEqual(['1/3'])

  store.previewLocalTemplate(id, 1_950, 3_500)
  expect([...captureScopeTiles()]).toEqual(['1/3', '2/3'])
})
