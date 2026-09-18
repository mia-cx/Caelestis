import {
  isRegionDocument,
  type RegionDocument,
  type RegionItem,
  type RegionShape,
  regionDocumentContainsPixel,
  regionDocumentPixels,
} from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import {
  claimDocumentPixels,
  claimDocuments,
  claimDocumentsLimitError,
  regionShapesOverlap,
} from './claim-document.js'

const rectangle = (x: number, y: number, w: number, h: number): RegionShape => ({
  kind: 'rectangle',
  x,
  y,
  w,
  h,
})

const item = (id: string, shape: RegionShape, op: 'add' | 'subtract' = 'add'): RegionItem => ({
  id,
  shape,
  op,
})

describe('claimDocuments', () => {
  it('splits distant shapes before rasterising their empty bounding space', () => {
    const near = item('near', rectangle(0, 0, 1, 1))
    const far = item('far', rectangle(2000, 2000, 1, 1))
    const document = { items: [near, far] }
    expect(regionDocumentPixels(document)).toBeNull()

    const documents = claimDocuments(document)
    expect(documents).toHaveLength(2)
    expect(documents[0]?.items[0]).toBe(near)
    expect(documents[1]?.items[0]).toBe(far)
    expect(documents.every(isRegionDocument)).toBe(true)
    const counts = documents.map((entry) => claimDocumentPixels(entry)?.count)
    expect(counts).toEqual([1, 1])
    expect((counts[0] as number) + (counts[1] as number)).toBe(2)
    expect(claimDocuments(document)).toBe(documents)
  })

  it('keeps intersecting shapes and ordered subtractors in one claim', () => {
    const first = item('first', rectangle(0, 0, 10, 10))
    const cut = item('cut', rectangle(0, 0, 5, 10), 'subtract')
    const patch = item('patch', rectangle(0, 0, 1, 1))
    const far = item('far', rectangle(2000, 2000, 1, 1))
    const document = { items: [first, cut, patch, far] }

    const documents = claimDocuments(document)
    expect(documents).toHaveLength(2)
    const near = documents[0] as RegionDocument
    expect(near.items[0]).toBe(first)
    expect(near.items[1]).toBe(cut)
    expect(near.items[2]).toBe(patch)
    expect(claimDocumentPixels(near)?.count).toBe(51)
    expect(claimDocumentPixels(documents[1] as RegionDocument)?.count).toBe(1)

    const reassembled = { items: documents.flatMap((entry) => entry.items) }
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        expect(regionDocumentContainsPixel(document, x, y)).toBe(
          regionDocumentContainsPixel(reassembled, x, y),
        )
      }
    }
    expect(regionDocumentContainsPixel(document, 2000, 2000)).toBe(
      regionDocumentContainsPixel(reassembled, 2000, 2000),
    )
  })

  it('connects transitive overlaps without joining empty group bounds', () => {
    const insideUnion = {
      items: [
        item('a', rectangle(0, 0, 2, 10)),
        item('b', rectangle(0, 8, 10, 2)),
        item('c', rectangle(8, 0, 2, 2)),
      ],
    }
    const split = claimDocuments(insideUnion)
    expect(split).toHaveLength(2)
    expect(split[0]?.items.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(split[1]?.items.map((entry) => entry.id)).toEqual(['c'])

    const chain = {
      items: [
        item('a', rectangle(0, 0, 10, 2)),
        item('b', rectangle(8, 0, 10, 2)),
        item('c', rectangle(16, 0, 10, 2)),
      ],
    }
    const joined = claimDocuments(chain)
    expect(joined).toHaveLength(1)
    expect(joined[0]?.items.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('groups by shared pixels, not by touching bounding boxes', () => {
    // Two ellipses whose boxes overlap at a corner but whose pixels never meet.
    const ellipse = (x: number, y: number): RegionShape => ({ kind: 'ellipse', x, y, w: 20, h: 20 })
    const apart = { items: [item('a', ellipse(0, 0)), item('b', ellipse(18, 18))] }
    expect(regionShapesOverlap(ellipse(0, 0), ellipse(18, 18))).toBe(false)
    expect(claimDocuments(apart)).toHaveLength(2)

    const touching = { items: [item('a', ellipse(0, 0)), item('b', ellipse(10, 0))] }
    expect(claimDocuments(touching)).toHaveLength(1)
  })

  it('joins separate regions when one subtractor cuts across both', () => {
    const left = item('left', rectangle(0, 0, 10, 10))
    const right = item('right', rectangle(20, 0, 10, 10))
    expect(claimDocuments({ items: [left, right] })).toHaveLength(2)
    const bridge = item('bridge', rectangle(5, 4, 20, 2), 'subtract')
    const joined = claimDocuments({ items: [left, right, bridge] })
    expect(joined).toHaveLength(1)
    expect(joined[0]?.items.map((entry) => entry.id)).toEqual(['left', 'right', 'bridge'])
    expect(claimDocumentPixels(joined[0] as RegionDocument)?.count).toBe(180)
  })

  it('keeps subtraction before a later addition in its original order', () => {
    const cut = item('cut', rectangle(0, 0, 10, 10), 'subtract')
    const fill = item('fill', rectangle(0, 0, 10, 10))
    const documents = claimDocuments({ items: [cut, fill] })
    expect(documents).toHaveLength(1)
    expect(documents[0]?.items[0]).toBe(cut)
    expect(documents[0]?.items[1]).toBe(fill)
    expect(claimDocumentPixels(documents[0] as RegionDocument)?.count).toBe(100)
  })

  it('ignores isolated subtractors without expanding added bounds', () => {
    const dot = item('dot', rectangle(0, 0, 1, 1))
    const stray = item('stray', rectangle(2000, 2000, 5, 5), 'subtract')
    const documents = claimDocuments({ items: [dot, stray] })
    expect(documents).toHaveLength(1)
    expect(documents[0]?.items[0]).toBe(dot)
    expect(claimDocumentPixels(documents[0] as RegionDocument)?.count).toBe(1)
    expect(claimDocuments({ items: [stray] })).toEqual([])
  })

  it('applies shape and raster work limits per independent claim', () => {
    const spaced = {
      items: Array.from({ length: 70 }, (_, index) =>
        item(`s${index}`, rectangle(index * 2, 0, 1, 1)),
      ),
    }
    const split = claimDocuments(spaced)
    expect(split).toHaveLength(70)
    expect(claimDocumentsLimitError(split)).toBeNull()

    const crowded = {
      items: Array.from({ length: 65 }, (_, index) => item(`c${index}`, rectangle(0, 0, 1, 1))),
    }
    expect(claimDocumentsLimitError(claimDocuments(crowded))).toBe(
      'A claim holds at most 64 shapes.',
    )

    const wide = {
      items: [item('a', rectangle(0, 0, 2000, 2000)), item('b', rectangle(5000, 0, 2000, 2000))],
    }
    const wideSplit = claimDocuments(wide)
    expect(wideSplit).toHaveLength(2)
    expect(claimDocumentsLimitError(wideSplit)).toBeNull()

    const heavy = {
      items: [item('a', rectangle(0, 0, 2000, 2000)), item('b', rectangle(0, 0, 2000, 2000))],
    }
    expect(claimDocumentsLimitError(claimDocuments(heavy))).toBe(
      'This claim is too complex to draw; shrink or remove some shapes before saving.',
    )
  })
})
