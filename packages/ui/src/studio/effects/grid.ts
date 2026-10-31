import type { ColourChannel, CurveGrid, TwoInputCurve } from 'ditherette'
import { evaluateClosedCurve, evaluateCurve } from './spline.js'

/** A hue axis wraps; every other axis runs from 0 to 1. */
export const wraps = (channel: ColourChannel) => channel.channel === 'hue'

/** Anything with a grid over two inputs: a two-input curve or a two-input mask curve. */
export type GridCurve = Pick<TwoInputCurve, 'x' | 'x2' | 'grid'>

/** New grids: a column every 30° on a hue axis, nine on others, and five rows. */
const HUE_COLUMNS = 12
const OPEN_COLUMNS = 9
const ROWS = 5
const NEUTRAL = 0.5
const MAX_COLUMNS = 48
const MIN_GAP = 0.001

const positions = (count: number, closed: boolean) =>
  Array.from({ length: count }, (_, index) => (closed ? index / count : index / (count - 1)))

/**
 * A grid for a curve reading `x` across and `x2` down, every value `neutral`: 0.5 for an
 * adjustment, 1 for a mask.
 */
export function neutralGrid(x: ColourChannel, x2: ColourChannel, neutral = NEUTRAL): CurveGrid {
  const columns = positions(wraps(x) ? HUE_COLUMNS : OPEN_COLUMNS, wraps(x))
  const rows = positions(ROWS, wraps(x2))
  return { columns, rows, values: rows.map(() => columns.map(() => neutral)) }
}

function along(axis: readonly number[], values: readonly number[], closed: boolean, at: number) {
  if (closed) return evaluateClosedCurve(axis, values, at)
  return evaluateCurve(
    axis.map((position, index) => [position, values[index] ?? 0] as const),
    at,
  )
}

/**
 * The grid's value at `a` on x and `b` on x2, from 0 through 1: along each row first, then down
 * the row results, as `spec/effects/curves.md` defines it.
 */
export function evaluateGrid({ x, x2, grid }: GridCurve, a: number, b: number) {
  const rows = grid.values.map((row) => along(grid.columns, row, wraps(x), a))
  return Math.min(1, Math.max(0, along(grid.rows, rows, wraps(x2), b)))
}

/** Insert a column at `a`, with values sampled from the existing surface there. */
export function insertColumn<C extends GridCurve>(
  curve: C,
  a: number,
): { curve: C; index: number } | undefined {
  const { grid } = curve
  const closed = wraps(curve.x)
  if (
    grid.columns.length >= MAX_COLUMNS ||
    !Number.isFinite(a) ||
    a < 0 ||
    (closed ? a >= 1 : a > 1)
  )
    return
  const after = grid.columns.findIndex((position) => position > a)
  const index = after < 0 ? grid.columns.length : after
  const splice = <T>(list: readonly T[], item: T) => [
    ...list.slice(0, index),
    item,
    ...list.slice(index),
  ]
  const columns = splice(grid.columns, a)
  const checked = closed ? columns.map(Math.fround) : columns
  if (
    checked.some(
      (position, column) =>
        column > 0 && Math.fround(position - (checked[column - 1] ?? 0)) < MIN_GAP,
    ) ||
    (closed && Math.fround(Math.fround(1 - (checked.at(-1) ?? 0)) + (checked[0] ?? 0)) < MIN_GAP)
  )
    return
  const values = grid.values.map((row, r) => splice(row, evaluateGrid(curve, a, grid.rows[r] ?? 0)))
  return {
    curve: { ...curve, grid: { ...grid, columns, values } },
    index,
  }
}

/** Whether a column can be removed without breaking the grid axis. */
export function canRemoveColumn(curve: GridCurve, index: number): boolean {
  const { columns } = curve.grid
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < columns.length &&
    columns.length > 2 &&
    (wraps(curve.x) || (index > 0 && index < columns.length - 1))
  )
}

/** Remove a column while keeping a valid axis. */
export function removeColumn<C extends GridCurve>(curve: C, index: number): C {
  const { grid } = curve
  if (!canRemoveColumn(curve, index)) return curve
  const drop = <T>(list: readonly T[]) => list.filter((_, other) => other !== index)
  return {
    ...curve,
    grid: { ...grid, columns: drop(grid.columns), values: grid.values.map(drop) },
  }
}

/** Set one grid value. */
export function setGridValue<C extends GridCurve>(
  curve: C,
  row: number,
  column: number,
  value: number,
): C {
  const values = curve.grid.values.map((cells, r) =>
    r === row ? cells.map((cell, c) => (c === column ? value : cell)) : cells,
  )
  return { ...curve, grid: { ...curve.grid, values } }
}
