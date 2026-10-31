import { type CurvePoints, isEffect } from 'ditherette'
import { flushSync, mount, unmount } from 'svelte'
import { expect, it } from 'vitest'
import CurveGraph from '../src/studio/effects/CurveGraph.svelte'
import { EFFECTS } from '../src/studio/effects/catalog.js'

// Palette-fit analysis spaces knots closer than one byte apart.
const ANALYSED: CurvePoints = [
  [0, 0],
  [0.5, 0.4],
  [0.5015, 0.5],
  [0.503, 0.6],
  [1, 1],
]

/** The points after one key press on the middle analysed knot. */
const nudge = (key: string): CurvePoints => {
  let changed: CurvePoints = ANALYSED
  const graph = mount(CurveGraph, {
    target: document.body,
    props: { id: 'curve', points: ANALYSED, colour: 'red', onChange: (next) => (changed = next) },
  })
  flushSync()
  document
    .querySelector('[data-point="2"]')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  unmount(graph)
  return changed
}

/** Whether Ditherette accepts the points as a curve. */
const accepted = (points: CurvePoints): boolean => {
  const step = EFFECTS.curves.create()
  const [curve] = step.curves
  return curve !== undefined && isEffect({ ...step, curves: [{ ...curve, points }] })
}

it.each(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])(
  'keeps a curve Ditherette accepts when %s nudges an analysed knot off the byte grid',
  (key) => {
    const points = nudge(key)
    expect(accepted(points)).toBe(true)
    // Raising or lowering a knot leaves it where it was along the curve.
    if (key === 'ArrowUp' || key === 'ArrowDown') expect(points[2]?.[0]).toBe(0.5015)
  },
)
