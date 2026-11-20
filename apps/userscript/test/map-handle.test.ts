// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { getMap, installMapCapture, releaseMapCapture } from '../src/map-handle.js'

afterEach(() => {
  releaseMapCapture()
  document.body.replaceChildren()
})

/** A MapLibre stand-in whose style never loads, constructed the way the capture trap sees it. */
const constructMap = (): { readonly canvas: HTMLCanvasElement; readonly map: object } => {
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  const map = {
    flyTo: () => {},
    getZoom: () => 10,
    getCanvas: () => canvas,
    on: () => {},
    style: { _loaded: false },
  }
  // MapLibre assigns this during construction, which is what the capture trap waits for.
  Object.assign(map, { _canvasContainer: document.createElement('div') })
  return { canvas, map }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

it('captures the replacement of a map removed before its style ever loaded', async () => {
  installMapCapture()
  const first = constructMap()
  await settle()
  expect(getMap()).toBe(first.map)

  first.canvas.remove()
  await settle()
  const replacement = constructMap()
  await settle()

  expect(getMap()).toBe(replacement.map)
})
