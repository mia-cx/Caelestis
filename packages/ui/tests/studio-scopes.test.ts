import { describe, expect, it } from 'vitest'
import { paint } from '../src/studio/scopes/scopes.js'

describe('scope painting', () => {
  it('lights a cell of black samples, and leaves empty cells dark', () => {
    // Two cells: black samples in the first, none in the second.
    const image = paint(2, 1, [
      { density: Float32Array.of(1, 0), colour: Float32Array.of(0, 0, 0, 0, 0, 0) },
    ])
    const [r, g, b] = image.data.subarray(0, 3)
    expect(r).toBeGreaterThan(0)
    expect([r, g, b]).toEqual([r, r, r])
    expect([...image.data.subarray(4, 7)]).toEqual([0, 0, 0])
  })
})
