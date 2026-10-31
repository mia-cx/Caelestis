import type { ColourChannel, CurvePoints, MaskCurve, OneInputMaskCurve } from 'ditherette'
import { channelValue, type Rgb } from '../colour.js'
import { sameChannel } from './catalog.js'
import { evaluateCurve, evaluatePeriodicCurve } from './spline.js'

/**
 * Ditherette web's effect masks: curves that read the colour entering a step and say how much of
 * the step applies there, with slider presets for tones, colours, and saturation.
 */

/** The most curves one step's mask holds. */
export const MAX_MASK_CURVES = 4

/** A full-strength mask curve: it holds nothing back. */
export const FULL: CurvePoints = [
  [0, 1],
  [1, 1],
]

/** A new mask curve reading `x`: full strength everywhere. */
export const fullMaskCurve = (x: ColourChannel): OneInputMaskCurve => ({ x, points: FULL })

/**
 * A preset family: sliders for windows along one OKLCH channel. Each window is a raised cosine
 * that is 1 at its centre and 0 at its neighbours' centres, so the windows always sum to 1 and
 * every slider at 100% is a no-op.
 */
export interface MaskPreset {
  readonly label: string
  readonly channel: ColourChannel
  readonly ranges: readonly { readonly label: string; readonly centre: number }[]
  /** Hue wraps: the last range blends back into the first across 360°. */
  readonly cyclic: boolean
  /** Points where the generated curve is sampled, in input order. */
  readonly knots: readonly number[]
}

const steps = (count: number, end = 1): number[] =>
  Array.from({ length: count + 1 }, (_, index) => (index / count) * end)

/** OKLCH hue of an sRGB colour, from 0 through 1. */
const hueOf = (rgb: Rgb): number => channelValue({ model: 'oklch', channel: 'hue' }, rgb)

const COLOUR_RANGES = (
  [
    ['Reds', [255, 0, 0]],
    ['Oranges', [255, 136, 0]],
    ['Yellows', [255, 255, 0]],
    ['Greens', [0, 255, 0]],
    ['Aquas', [0, 255, 255]],
    ['Blues', [0, 0, 255]],
    ['Purples', [136, 0, 255]],
    ['Magentas', [255, 0, 255]],
  ] as const
).map(([label, rgb]) => ({ label, centre: hueOf(rgb) }))

/**
 * Colour knots: the seam, every centre, and the midpoints of the widest gaps, up to the package's
 * 16 points. Centres are knots, so each slider reads back exactly.
 */
const COLOUR_KNOTS = (() => {
  const centres = COLOUR_RANGES.map(({ centre }) => centre).sort((a, b) => a - b)
  const gaps = centres.map((centre, index) => {
    const next =
      (centres[(index + 1) % centres.length] ?? 0) + (index === centres.length - 1 ? 1 : 0)
    return { middle: ((centre + next) / 2) % 1, width: next - centre }
  })
  const middles = gaps
    .sort((a, b) => b.width - a.width)
    .slice(0, 6)
    .map(({ middle }) => middle)
  return [...new Set([0, ...centres, ...middles, 1])].sort((a, b) => a - b)
})()

/** Tones, Colours, and Saturation. */
export const MASK_PRESETS: readonly MaskPreset[] = [
  {
    label: 'Tones',
    channel: { model: 'oklch', channel: 'lightness' },
    ranges: [
      { label: 'Shadows', centre: 0 },
      { label: 'Midtones', centre: 0.5 },
      { label: 'Highlights', centre: 1 },
    ],
    cyclic: false,
    knots: steps(8),
  },
  {
    label: 'Colours',
    channel: { model: 'oklch', channel: 'hue' },
    ranges: COLOUR_RANGES,
    cyclic: true,
    knots: COLOUR_KNOTS,
  },
  {
    label: 'Saturation',
    // Normalised chroma is C / 0.4, so Muted falls to 0 at C = 0.2, halfway along.
    channel: { model: 'oklch', channel: 'chroma' },
    ranges: [
      { label: 'Muted', centre: 0 },
      { label: 'Vivid', centre: 0.5 },
    ],
    cyclic: false,
    knots: [...steps(8, 0.5), 1],
  },
]

/** The blended strength at `x`: between neighbouring centres, a raised cosine from one to the next. */
const blend = (preset: MaskPreset, values: readonly number[], x: number): number => {
  const order = preset.ranges
    .map(({ centre }, index) => ({ centre, value: values[index] ?? 1 }))
    .sort((a, b) => a.centre - b.centre)
  const last = order.length - 1
  const first = order[0]
  const final = order[last]
  if (first === undefined || final === undefined) return 1
  let from = order.findLastIndex(({ centre }) => centre <= x)
  if (from < 0) {
    if (!preset.cyclic) return first.value
    from = last
  }
  if (from === last && !preset.cyclic) return final.value
  const start = order[from] ?? first
  const end = order[(from + 1) % order.length] ?? first
  const span = (end.centre - start.centre + 1) % 1 || 1
  const t = (((x - start.centre) % 1) + 1) % 1
  const rise = 0.5 * (1 - Math.cos((Math.PI * Math.min(t, span)) / span))
  return start.value + (end.value - start.value) * rise
}

/** The curve a preset's sliders generate, or none when every slider is at 100%. */
export const presetCurve = (
  preset: MaskPreset,
  values: readonly number[],
): OneInputMaskCurve | undefined => {
  if (values.every((value) => value === 1)) return undefined
  const points: (readonly [number, number])[] = preset.knots.map((x) => [
    x,
    blend(preset, values, x),
  ])
  // A hue curve's seam points must match exactly; rounding can split 0 and 1 by an ulp.
  if (preset.cyclic) points[points.length - 1] = [1, points[0]?.[1] ?? 1]
  return { x: preset.channel, points }
}

const evaluate = (curve: OneInputMaskCurve, x: number): number =>
  curve.x.channel === 'hue'
    ? evaluatePeriodicCurve(curve.points, x)
    : evaluateCurve(curve.points, x)

/** The preset's mask curve: the one-input curve reading its channel. */
export const presetIndex = (mask: readonly MaskCurve[], preset: MaskPreset): number =>
  mask.findIndex((curve) => !curve.x2 && sameChannel(curve.x, preset.channel))

/** Slider values read from the mask: its preset curve at each range's centre, or 100% without one. */
export const presetValues = (mask: readonly MaskCurve[], preset: MaskPreset): number[] => {
  const curve = mask[presetIndex(mask, preset)]
  return preset.ranges.map(({ centre }) =>
    curve && !curve.x2 ? Math.min(1, Math.max(0, evaluate(curve, centre))) : 1,
  )
}

/**
 * The mask with one preset's curve regenerated from `values`: replaced in place, appended, or
 * removed when every slider is back at 100%. A full mask has no room for a new curve.
 */
export const setPreset = (
  mask: readonly MaskCurve[],
  preset: MaskPreset,
  values: readonly number[],
): MaskCurve[] => {
  const index = presetIndex(mask, preset)
  const curve = presetCurve(preset, values)
  if (index < 0) return curve && mask.length < MAX_MASK_CURVES ? [...mask, curve] : [...mask]
  return curve
    ? mask.map((other, at) => (at === index ? curve : other))
    : mask.filter((_, at) => at !== index)
}
