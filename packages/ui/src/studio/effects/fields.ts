import type { EffectKind, EffectOf } from './catalog.js'
import { hueSpectrum } from './tone.js'

type NumericKey<S> = { [K in keyof S]: S[K] extends number ? K : never }[keyof S]

/** One slider. Bounds and step are in display units; the step stores `display / scale`. */
export type NumberField<S> = {
  readonly key: NumericKey<S>
  readonly label: string
  readonly min: number
  readonly max: number
  readonly step: number
  readonly scale?: number
  readonly unit?: string
  /** A CSS gradient drawn as the slider's track, showing what the value does. */
  readonly track?: string
}

const PERCENT = { min: -100, max: 100, step: 1, scale: 100, unit: '%' } as const
const RED_HUE = 29
const track = (...colors: string[]) => `linear-gradient(to right, ${colors.join(', ')})`

/** Effects whose editor is a list of sliders. Levels and curves have their own editors. */
export const NUMBER_FIELDS: {
  readonly [K in Exclude<EffectKind, 'levels' | 'curves'>]: readonly NumberField<EffectOf<K>>[]
} = {
  'brightness-contrast': [
    { key: 'brightness', label: 'Brightness', ...PERCENT },
    { key: 'contrast', label: 'Contrast', ...PERCENT },
  ],
  exposure: [{ key: 'stops', label: 'Exposure', min: -4, max: 4, step: 0.05, unit: 'EV' }],
  'white-balance': [
    {
      key: 'temperature',
      label: 'Temperature',
      ...PERCENT,
      track: track('oklch(0.62 0.14 255)', 'oklch(0.85 0 0)', 'oklch(0.8 0.14 75)'),
    },
    {
      key: 'tint',
      label: 'Tint',
      ...PERCENT,
      track: track('oklch(0.72 0.16 145)', 'oklch(0.85 0 0)', 'oklch(0.66 0.2 330)'),
    },
  ],
  'hue-saturation': [
    {
      key: 'hue',
      label: 'Hue',
      min: -180,
      max: 180,
      step: 1,
      unit: '°',
      track: hueSpectrum({ from: RED_HUE - 180 }),
    },
    {
      key: 'saturation',
      label: 'Saturation',
      ...PERCENT,
      track: track(
        `oklch(0.65 0 ${RED_HUE})`,
        `oklch(0.65 0.13 ${RED_HUE})`,
        `oklch(0.65 0.26 ${RED_HUE})`,
      ),
    },
    {
      key: 'lightness',
      label: 'Lightness',
      ...PERCENT,
      track: track('black', `oklch(0.65 0.13 ${RED_HUE})`, 'white'),
    },
  ],
  recolour: [{ key: 'strength', label: 'Strength', ...PERCENT, min: 0 }],
  'palette-fit': [{ key: 'strength', label: 'Strength', ...PERCENT, min: 0, max: 300 }],
}
