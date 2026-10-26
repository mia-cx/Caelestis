import type {
  BrightnessContrastEffect,
  ExposureEffect,
  HueSaturationEffect,
  LevelsEffect,
} from 'ditherette'

/** Maps one encoded sRGB channel value from 0 through 1, as an effect's spec defines it. */
export type ToneMap = (value: number) => number

/** Where a curve changes nothing: a remap's diagonal, an adjustment's midline, or a mask's top. */
export type Neutral = 'diagonal' | 'flat' | 'full'

const decode = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
const encode = (value: number) =>
  value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055

export function levelsTone({ input, gamma, output }: LevelsEffect): ToneMap {
  return (value) => {
    const t = Math.min(1, Math.max(0, (value - input.black) / (input.white - input.black)))
    return output.black + (output.white - output.black) * t ** (1 / gamma)
  }
}

export function brightnessContrastTone({
  brightness,
  contrast,
}: BrightnessContrastEffect): ToneMap {
  return (value) => (value - 0.5) * 4 ** contrast + 0.5 + brightness
}

export function exposureTone({ stops }: ExposureEffect): ToneMap {
  return (value) => encode(decode(value) * 2 ** stops)
}

/** An SVG path through `map` on a `size`-unit square, with output clipped to the square. */
export function tonePath(map: ToneMap, size: number, samples = 128): string {
  return Array.from({ length: samples + 1 }, (_, index) => {
    const x = index / samples
    const y = Math.min(1, Math.max(0, map(x)))
    return `${index ? 'L' : 'M'}${x * size} ${(1 - y) * size}`
  }).join('')
}

const SPECTRUM_LIGHTNESS = 0.72
const SPECTRUM_CHROMA = 0.13
const SPECTRUM_STEP_DEGREES = 30

/**
 * A CSS gradient once around the OKLCH hue circle from `from` degrees, optionally after a hue and
 * saturation step. The step turns Oklab `a, b`, which turns OKLCH hue, so CSS `oklch()` draws it.
 */
export function hueSpectrum({ from = 0, step }: { from?: number; step?: HueSaturationEffect }) {
  const stops = []
  for (let hue = from; hue <= from + 360; hue += SPECTRUM_STEP_DEGREES) {
    let [lightness, chroma, turned] = [SPECTRUM_LIGHTNESS, SPECTRUM_CHROMA, hue]
    if (step) {
      chroma *= 1 + step.saturation
      turned += step.hue
      const keep = 1 - Math.abs(step.lightness)
      lightness =
        step.lightness >= 0 ? lightness + (1 - lightness) * step.lightness : lightness * keep
      chroma *= keep
    }
    stops.push(`oklch(${lightness} ${chroma} ${turned})`)
  }
  return `linear-gradient(to right, ${stops.join(', ')})`
}

const HUE_AXIS_STEP_DEGREES = 30

/** A CSS gradient of a model's own hue circle, left to right from 0° to 360°, for a hue x axis. */
export function hueAxis(model: 'hsl' | 'hsv' | 'oklch' | 'cielch') {
  const colour = (hue: number) =>
    model === 'oklch'
      ? `oklch(${SPECTRUM_LIGHTNESS} ${SPECTRUM_CHROMA} ${hue})`
      : model === 'cielch'
        ? `lch(65% 60 ${hue})`
        : `hsl(${hue} 90% 55%)`
  const stops = []
  for (let hue = 0; hue <= 360; hue += HUE_AXIS_STEP_DEGREES) stops.push(colour(hue))
  return `linear-gradient(to right, ${stops.join(', ')})`
}
