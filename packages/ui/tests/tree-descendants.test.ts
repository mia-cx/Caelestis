import { describe, expect, it } from 'vitest'

import { descendantKeys } from '../src/tree/descendants.js'

const row = (key: string, depth: number) => ({ key, depth })

describe('descendantKeys', () => {
  it('returns the contiguous run of deeper rows after the key', () => {
    const entries = [
      row('a', 0),
      row('a1', 1),
      row('a1x', 2),
      row('a2', 1),
      row('b', 0),
      row('b1', 1),
    ]
    expect([...descendantKeys(entries, 'a')]).toEqual(['a1', 'a1x', 'a2'])
    expect([...descendantKeys(entries, 'b')]).toEqual(['b1'])
  })

  it('stops at the first sibling, not at end of list', () => {
    const entries = [row('a', 0), row('a1', 1), row('b', 0), row('b1', 1)]
    expect(descendantKeys(entries, 'a').has('b1')).toBe(false)
  })

  it('is empty for a leaf, a missing key, and a trailing row', () => {
    const entries = [row('a', 0), row('a1', 1)]
    expect(descendantKeys(entries, 'a1').size).toBe(0)
    expect(descendantKeys(entries, 'missing').size).toBe(0)
    expect(descendantKeys([], 'a').size).toBe(0)
  })
})
