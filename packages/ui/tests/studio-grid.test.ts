import type { TwoInputCurve } from 'ditherette'
import { describe, expect, it } from 'vitest'
import {
  canRemoveColumn,
  evaluateGrid,
  insertColumn,
  neutralGrid,
  removeColumn,
  setGridValue,
} from '../src/studio/effects/grid.js'

const hue = { model: 'oklch', channel: 'hue' } as const
const lightness = { model: 'oklch', channel: 'lightness' } as const
const chroma = { model: 'oklch', channel: 'chroma' } as const

function redShadows(): TwoInputCurve {
  let curve: TwoInputCurve = {
    kind: 'adjust',
    x: hue,
    x2: lightness,
    y: chroma,
    grid: neutralGrid(hue, lightness),
  }
  curve = setGridValue(curve, 0, 1, 0.95)
  curve = setGridValue(curve, 1, 1, 0.9)
  return setGridValue(curve, 1, 2, 0.7)
}

describe('two-input curve grids', () => {
  it('starts neutral, a column every 30° on hue and five rows', () => {
    const { grid } = redShadows()
    expect(grid.columns).toHaveLength(12)
    expect(grid.rows).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(evaluateGrid({ ...redShadows(), grid: neutralGrid(hue, lightness) }, 0.3, 0.6)).toBe(0.5)
  })

  it('passes through its points and wraps across the hue seam', () => {
    const curve = redShadows()
    expect(evaluateGrid(curve, curve.grid.columns[1] ?? Number.NaN, 0)).toBeCloseTo(0.95, 6)
    expect(evaluateGrid(curve, 0.999999, 0.3)).toBeCloseTo(evaluateGrid(curve, 0, 0.3), 4)
  })

  it('samples the existing surface at an inserted column', () => {
    const curve = redShadows()
    const result = insertColumn(curve, 0.11)
    if (result === undefined) throw new Error('the column was refused')
    const { curve: inserted, index } = result
    expect(inserted.grid.columns[index]).toBe(0.11)
    for (const b of [0, 0.1, 0.3, 0.8, 1])
      expect(evaluateGrid(inserted, 0.11, b)).toBeCloseTo(evaluateGrid(curve, 0.11, b), 6)
    expect(removeColumn(inserted, index).grid.columns).toEqual(curve.grid.columns)
  })

  it('rejects insertions outside the grid contract', () => {
    const curve = redShadows()
    expect(insertColumn(curve, 1)).toBeUndefined()

    const columns = Array.from({ length: 48 }, (_, index) => index / 48)
    const full = {
      ...curve,
      grid: { ...curve.grid, columns, values: curve.grid.values.map(() => columns.map(() => 0.5)) },
    }
    expect(insertColumn(full, 0.99)).toBeUndefined()

    const seam = {
      ...curve,
      grid: {
        ...curve.grid,
        columns: [0.1, 0.999],
        values: curve.grid.values.map(() => [0.5, 0.5]),
      },
    }
    expect(insertColumn(seam, 0)).toBeUndefined()
  })

  it('keeps open-axis endpoints when removing columns', () => {
    const open: TwoInputCurve = {
      kind: 'adjust',
      x: lightness,
      x2: hue,
      y: chroma,
      grid: neutralGrid(lightness, hue),
    }
    const last = open.grid.columns.length - 1
    expect(canRemoveColumn(open, 0)).toBe(false)
    expect(canRemoveColumn(open, last)).toBe(false)
    expect(removeColumn(open, 0)).toBe(open)
    expect(removeColumn(open, last)).toBe(open)
    expect(removeColumn(open, 1).grid.columns).toHaveLength(open.grid.columns.length - 1)
    expect(canRemoveColumn(redShadows(), 0)).toBe(true)
  })
})
