// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { presenceLayer } from './presence-layer.js'

type Item = Parameters<typeof presenceLayer.displayRect>[0]

const item = (key: string, kind: Item['kind'], x: number): Item => ({
  key,
  kind,
  rect: { x, y: 0, w: 4, h: 4 },
  colour: [1, 1, 1],
  mask: null,
})

it('snaps a quick claim to its new pixels while a viewport glides between them', () => {
  presenceLayer.displayRect(item('quick', 'quick', 0), 0)
  presenceLayer.displayRect(item('viewport', 'viewport', 0), 0)
  expect(presenceLayer.displayRect(item('quick', 'quick', 10), 50)).toEqual({
    rect: { x: 10, y: 0, w: 4, h: 4 },
    moving: false,
  })
  const viewport = presenceLayer.displayRect(item('viewport', 'viewport', 10), 50)
  expect(viewport.moving).toBe(true)
  expect(viewport.rect.x).toBe(0)
})
