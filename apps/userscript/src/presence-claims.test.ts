import { type RegionClaim, regionPixelComponents, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { assert, describe, expect, it } from 'vitest'
import { createDisplayClaims } from './presence-claims.js'

const claim = (id: string, x: number, y = 0, w = 3, h = 3): RegionClaim => ({
  id,
  season: 0,
  surface: WORLD_TEMPLATE_SURFACE,
  templateId: null,
  claimant: { wplaceUserId: 7, displayName: 'Mia' },
  label: '',
  createdAt: 1,
  rect: { x, y, w, h },
  document: { items: [{ id, op: 'add', shape: { kind: 'rectangle', x, y, w, h } }] },
})

describe('display claims', () => {
  it('draws 13 existing touching claims as one mask without a save and reuses that mask', () => {
    const display = createDisplayClaims()
    const regions = Array.from({ length: 13 }, (_, i) => claim(`r${i}`, i * 3))
    const before = structuredClone(regions)
    const shown = display([
      ...regions.filter((_, i) => i % 2 === 0),
      ...regions.filter((_, i) => i % 2 === 1),
    ])
    expect(shown).toHaveLength(1)
    expect(shown[0]?.pixels).toMatchObject({ rect: { x: 0, y: 0, w: 39, h: 3 }, count: 117 })
    expect(shown[0]?.pixels.mask.every((value) => value === 1)).toBe(true)
    expect(regions).toEqual(before)
    const cached = display(regions)
    expect(display([...regions])).toBe(cached)
    expect(display(regions)[0]?.pixels).toBe(cached[0]?.pixels)
  })

  it('unions overlaps once and joins diagonal contact', () => {
    const shown = createDisplayClaims()([claim('a', 0), claim('b', 2), claim('c', 5, 3)])
    expect(shown).toHaveLength(1)
    expect(shown[0]?.pixels.count).toBe(24)
    assert(shown[0])
    expect(regionPixelComponents(shown[0].pixels).boxes).toHaveLength(1)
  })

  it('keeps another document filled where a neighbouring document subtracts', () => {
    const left = claim('left', 0)
    const cut: RegionClaim = {
      ...claim('cut', 2),
      document: {
        items: [
          ...claim('cut', 2).document.items,
          { id: 'erase', op: 'subtract', shape: { kind: 'rectangle', x: 2, y: 0, w: 1, h: 3 } },
        ],
      },
    }
    const shown = createDisplayClaims()([left, cut])
    expect(shown).toHaveLength(1)
    expect(shown[0]?.pixels.count).toBe(15)
    expect(shown[0]?.pixels.mask.every((value) => value === 1)).toBe(true)
  })

  it('keeps subtraction gaps and empty bounding-box contact separate', () => {
    const cut: RegionClaim = {
      ...claim('cut', 2),
      document: {
        items: [
          ...claim('cut', 2).document.items,
          { id: 'erase', op: 'subtract', shape: { kind: 'rectangle', x: 2, y: 0, w: 2, h: 3 } },
        ],
      },
    }
    expect(createDisplayClaims()([claim('left', 0), cut])).toHaveLength(2)
    const ellipse = (id: string, x: number, y: number): RegionClaim => ({
      ...claim(id, x, y, 20, 20),
      document: { items: [{ id, op: 'add', shape: { kind: 'ellipse', x, y, w: 20, h: 20 } }] },
    })
    expect(createDisplayClaims()([ellipse('a', 0, 0), ellipse('b', 18, 18)])).toHaveLength(2)
  })

  it('keeps painters, seasons and surfaces separate', () => {
    const next = claim('b', 3)
    for (const other of [
      { ...next, claimant: { wplaceUserId: 8, displayName: 'Sam' } },
      { ...next, season: 1 },
      { ...next, surface: { kind: 'alliance-headquarters' as const, allianceId: 1 } },
    ])
      expect(createDisplayClaims()([claim('a', 0), other])).toHaveLength(2)
  })

  it('updates the union when a bridge changes, disappears, or enters the editor', () => {
    const display = createDisplayClaims()
    const a = claim('a', 0),
      b = claim('b', 3),
      c = claim('c', 6)
    expect(display([a, b, c])).toHaveLength(1)
    expect(display([a, b, c], ['b'])).toHaveLength(2)
    expect(display([a, b, c])).toHaveLength(1)
    expect(display([a, c])).toHaveLength(2)
    expect(display([a, claim('b', 100), c])).toHaveLength(3)
    expect(display([])).toEqual([])
  })

  it('retains every claim when their union exceeds the raster budget', () => {
    const shown = createDisplayClaims()([
      claim('a', 0, 0, 2000, 2000),
      claim('b', 2000, 0, 2000, 2000),
    ])
    expect(shown).toHaveLength(2)
    expect(shown.map((part) => part.pixels.count)).toEqual([4_000_000, 4_000_000])
  })
})
