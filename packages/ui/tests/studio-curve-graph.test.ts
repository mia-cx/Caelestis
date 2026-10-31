import type { CurvePoints } from 'ditherette'
import { flushSync, mount, unmount } from 'svelte'
import { expect, it } from 'vitest'
import CurveGraph from '../src/studio/effects/CurveGraph.svelte'
import { MIN_CURVE_POINT_GAP } from '../src/studio/effects/spline.js'

it('raises an analysed point off the byte grid without moving it along the curve', () => {
  // Palette-fit analysis spaces knots closer than one byte apart.
  const points: CurvePoints = [
    [0, 0],
    [0.5, 0.4],
    [0.5015, 0.5],
    [0.503, 0.6],
    [1, 1],
  ]
  const changes: CurvePoints[] = []
  const graph = mount(CurveGraph, {
    target: document.body,
    props: { id: 'curve', points, colour: 'red', onChange: (next) => changes.push(next) },
  })
  flushSync()

  document
    .querySelector('[data-point="2"]')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  const next = changes.at(-1) ?? []
  expect(next[2]?.[0]).toBe(0.5015)
  expect(next[2]?.[1]).toBeGreaterThan(0.5)
  for (let index = 1; index < next.length; index++)
    expect((next[index]?.[0] ?? 0) - (next[index - 1]?.[0] ?? 0)).toBeGreaterThanOrEqual(
      MIN_CURVE_POINT_GAP - Number.EPSILON,
    )
  unmount(graph)
})
