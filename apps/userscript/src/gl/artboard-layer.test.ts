import { expect, it } from 'vitest'
import { insertAllianceArtboardCanvases } from './artboard-layer.js'

const order = (frame: HTMLElement): string[] =>
  [...frame.children].map((child) => child.getAttribute('data-name') ?? '?')

const ours = (name: string): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  canvas.setAttribute(`data-caelestis-alliance-${name}`, '')
  canvas.setAttribute('data-name', name)
  return canvas
}

it.each([
  ['one HQ art canvas', '<canvas class="hq-tile-layer" data-name="art"></canvas>'],
  ['an HQ tile container', '<div class="hq-tile-layer" data-name="art"><canvas></canvas></div>'],
])('draws the overlay above native HQ art in %s', (_, art) => {
  const frame = document.createElement('div')
  frame.innerHTML = `${art}<canvas data-name="draft"></canvas>`
  insertAllianceArtboardCanvases(frame, ours('outline'), ours('overlay'), ours('markers'))
  expect(order(frame)).toEqual(['outline', 'art', 'overlay', 'draft', 'markers'])
})
