import { describe, expect, it } from 'vitest'
import { type ColourProgressSort, compareColours } from '../src/progress/colour-sorts.js'

const colour = (index: number, completed: number, total: number, mismatched = 0) => ({
  index,
  completed,
  mismatched,
  unpainted: total - completed - mismatched,
  total,
})

const rows = [colour(5, 9, 10), colour(1, 1, 10, 4), colour(3, 5, 10), colour(2, 5, 10)]
const order = (sort: ColourProgressSort) =>
  rows.toSorted(compareColours(sort)).map((row) => row.index)

describe('colour progress sorts', () => {
  it('orders by completion, remaining work and mismatches, ties in palette order', () => {
    expect(order('index')).toEqual([1, 2, 3, 5])
    expect(order('progress')).toEqual([5, 2, 3, 1])
    expect(order('progress-asc')).toEqual([1, 2, 3, 5])
    expect(order('remaining')).toEqual([1, 2, 3, 5])
    expect(order('mismatched')).toEqual([1, 2, 3, 5])
  })

  it('treats an empty colour as not started rather than dividing by zero', () => {
    expect([colour(4, 0, 0), colour(6, 1, 2)].toSorted(compareColours('progress'))).toEqual([
      colour(6, 1, 2),
      colour(4, 0, 0),
    ])
  })
})
