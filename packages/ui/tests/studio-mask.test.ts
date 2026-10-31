import { isEffect, type MaskCurve, type OneInputMaskCurve } from 'ditherette'
import { describe, expect, it } from 'vitest'
import {
  MASK_PRESETS,
  type MaskPreset,
  presetCurve,
  presetValues,
  setPreset,
} from '../src/studio/effects/mask.js'

const [tones, colours, saturation] = MASK_PRESETS as [MaskPreset, MaskPreset, MaskPreset]

/** The value, which the case's setup guarantees is there. */
const defined = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('expected a value')
  return value
}
const oneInput = (curve: MaskCurve | undefined): OneInputMaskCurve => {
  const found = defined(curve)
  if (found.x2 !== undefined) throw new Error('expected a one-input curve')
  return found
}
/** The curve's output at the knot `x`. */
const outputAt = (curve: OneInputMaskCurve, x: number): number =>
  defined(curve.points.find(([px]) => px === x))[1]

describe('mask presets', () => {
  it('are a no-op at 100% and leave the mask', () => {
    for (const preset of MASK_PRESETS) {
      const full = preset.ranges.map(() => 1)
      expect(presetCurve(preset, full)).toBeUndefined()
      const half = preset.ranges.map(() => 0.5)
      expect(setPreset(setPreset([], preset, half), preset, full)).toEqual([])
    }
  })

  it('generate curves the package accepts, whose centres read back as the sliders', () => {
    for (const preset of MASK_PRESETS)
      for (let trial = 0; trial < 20; trial++) {
        const values = preset.ranges.map((_, index) => ((trial * 7 + index * 3) % 11) / 10)
        if (values.every((value) => value === 1)) continue
        const mask = setPreset([], preset, values)
        expect(isEffect({ effect: 'exposure', enabled: true, stops: 1, mask })).toBe(true)
        expect(oneInput(mask[0]).points.length).toBeLessThanOrEqual(16)
        for (const [index, value] of presetValues(mask, preset).entries())
          expect(value).toBeCloseTo(values[index] ?? Number.NaN, 6)
      }
  })

  it('blend neighbouring ranges along raised cosines that sum to 1', () => {
    const shadowsOff = defined(presetCurve(tones, [0, 1, 1]))
    expect(outputAt(shadowsOff, 0)).toBe(0)
    expect(outputAt(shadowsOff, 0.25)).toBeCloseTo(0.5, 12)
    expect(outputAt(shadowsOff, 0.5)).toBe(1)
    expect(outputAt(shadowsOff, 1)).toBe(1)
    const mutedOff = defined(presetCurve(saturation, [0, 1]))
    expect(mutedOff.points.at(-1)).toEqual([1, 1])
    expect(outputAt(mutedOff, 0.25)).toBeCloseTo(0.5, 12)
  })

  it('centre Colours on the OKLCH hues of the eight primaries and wrap at the seam', () => {
    const degrees = colours.ranges.map(({ centre }) => Math.round(centre * 360))
    expect(degrees).toEqual([29, 56, 110, 142, 195, 264, 297, 328])
    const redsOff = defined(presetCurve(colours, [0, 1, 1, 1, 1, 1, 1, 1]))
    const seam = defined(redsOff.points[0])[1]
    expect(seam).toBe(defined(redsOff.points.at(-1))[1])
    expect(seam).toBeLessThan(1)
  })

  it('replace their own curve in place and keep other curves', () => {
    const custom = {
      x: { model: 'oklab', channel: 'a' } as const,
      points: [
        [0, 1],
        [1, 0],
      ] as const,
    }
    const first = setPreset([custom], tones, [0.2, 1, 1])
    expect(first).toHaveLength(2)
    const second = setPreset(first, tones, [0.4, 1, 1])
    expect(second[0]).toBe(custom)
    expect(presetValues(second, tones)[0]).toBeCloseTo(0.4, 6)
  })
})
