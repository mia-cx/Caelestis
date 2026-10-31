import { type ChannelName, CURVE_MODELS, type CurveModel } from './effects/catalog.js'

/**
 * Colour coordinates as Ditherette normalises its curve axes, for masks and scopes. Ported from
 * Ditherette web's scopes, so the studio reads colours the way Ditherette applies them.
 */

/** Every model the scopes read: the curves models, plus CMY as inverted RGB. */
export type ScopeModel = CurveModel | 'cmy'
export interface ScopeChannel {
  readonly name: ChannelName | 'cyan' | 'magenta' | 'yellow'
  readonly label: string
}
export type Rgb = readonly [number, number, number]

const [srgb, ...others] = CURVE_MODELS
export const SCOPE_MODELS: readonly {
  readonly id: ScopeModel
  readonly label: string
  readonly channels: readonly [ScopeChannel, ScopeChannel, ScopeChannel]
}[] = [
  ...(srgb === undefined ? [] : [srgb]),
  {
    id: 'cmy',
    label: 'CMY',
    channels: [
      { name: 'cyan', label: 'Cyan' },
      { name: 'magenta', label: 'Magenta' },
      { name: 'yellow', label: 'Yellow' },
    ],
  },
  ...others,
]

/** Each channel's trace colour, bright enough to glow on the dark scope surface. */
export const TRACE: Record<ScopeChannel['name'], Rgb> = {
  red: [255, 72, 72],
  green: [72, 232, 96],
  blue: [80, 136, 255],
  cyan: [48, 220, 232],
  magenta: [240, 80, 224],
  yellow: [240, 220, 64],
  hue: [255, 184, 48],
  saturation: [232, 88, 232],
  chroma: [232, 88, 232],
  lightness: [236, 236, 236],
  value: [236, 236, 236],
  luma: [236, 236, 236],
  a: [64, 212, 144],
  b: [64, 184, 248],
  cb: [64, 184, 248],
  cr: [250, 96, 128],
}

const DECODE = Float64Array.from({ length: 256 }, (_, byte) => {
  const value = byte / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
})
/** Linear light of an encoded sRGB byte. */
const linear = (byte: number): number => DECODE[byte] ?? 0
const encode = (value: number): number =>
  value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055

const TURN = 2 * Math.PI
const hueOf = (a: number, b: number): number =>
  a === 0 && b === 0 ? 0 : (((Math.atan2(b, a) / TURN) % 1) + 1) % 1
const unit = (value: number): number => Math.min(1, Math.max(0, value))

const oklab = (r: number, g: number, b: number): Rgb => {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)]
  const l = Math.cbrt(0.41222146 * lr + 0.53633255 * lg + 0.051445995 * lb)
  const m = Math.cbrt(0.2119035 * lr + 0.6806995 * lg + 0.10739696 * lb)
  const s = Math.cbrt(0.08830246 * lr + 0.28171885 * lg + 0.6299787 * lb)
  return [
    0.21045426 * l + 0.7936178 * m - 0.004072047 * s,
    1.9779985 * l - 2.4285922 * m + 0.4505937 * s,
    0.025904037 * l + 0.78277177 * m - 0.80867577 * s,
  ]
}

/** Linear sRGB to CIE XYZ, D65. */
const xyz = (r: number, g: number, b: number): Rgb => {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)]
  return [
    0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb,
    0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb,
    0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb,
  ]
}

const labF = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
const cielab = (r: number, g: number, b: number): Rgb => {
  const [x, y, z] = xyz(r, g, b)
  const [fx, fy, fz] = [labF(x / 0.95047), labF(y), labF(z / 1.08883)]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** HSL or HSV from encoded RGB bytes, with the hue confidence the package uses. */
const cylinder = (
  r: number,
  g: number,
  b: number,
  lightness: boolean,
  out: Float64Array,
): number => {
  const [red, green, blue] = [r / 255, g / 255, b / 255]
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const chroma = max - min
  let hue = 0
  if (chroma > 0) {
    if (max === red) hue = ((green - blue) / chroma + 6) % 6
    else if (max === green) hue = (blue - red) / chroma + 2
    else hue = (red - green) / chroma + 4
  }
  out[0] = hue / 6
  if (lightness) {
    const l = (max + min) / 2
    out[1] = l === 0 || l === 1 ? 0 : chroma / (1 - Math.abs(2 * l - 1))
    out[2] = l
  } else {
    out[1] = max === 0 ? 0 : chroma / max
    out[2] = max
  }
  return unit(chroma / 0.02)
}

/**
 * Write a colour's coordinates in `model`, normalised the way the package normalises curve axes,
 * and return how much its hue counts: greys have no hue, so they add nothing to a hue trace.
 */
export const coordinates = (
  model: ScopeModel,
  r: number,
  g: number,
  b: number,
  out: Float64Array,
): number => {
  switch (model) {
    case 'srgb':
      out.set([r / 255, g / 255, b / 255])
      return 1
    case 'cmy':
      out.set([1 - r / 255, 1 - g / 255, 1 - b / 255])
      return 1
    case 'linear-rgb':
      out.set([linear(r), linear(g), linear(b)])
      return 1
    case 'hsl':
      return cylinder(r, g, b, true, out)
    case 'hsv':
      return cylinder(r, g, b, false, out)
    case 'ycbcr': {
      const [red, green, blue] = [r / 255, g / 255, b / 255]
      const luma = 0.299 * red + 0.587 * green + 0.114 * blue
      out.set([luma, (blue - luma) / 1.772 + 0.5, (red - luma) / 1.402 + 0.5])
      return 1
    }
    case 'oklab': {
      const [l, a, bb] = oklab(r, g, b)
      out.set([l, a / 0.8 + 0.5, bb / 0.8 + 0.5])
      return 1
    }
    case 'oklch': {
      const [l, a, bb] = oklab(r, g, b)
      const chroma = Math.hypot(a, bb)
      out.set([l, chroma / 0.4, hueOf(a, bb)])
      return r === g && g === b ? 0 : unit(chroma / 0.02)
    }
    case 'cielab': {
      const [l, a, bb] = cielab(r, g, b)
      out.set([l / 100, a / 250 + 0.5, bb / 250 + 0.5])
      return 1
    }
    case 'cielch': {
      const [l, a, bb] = cielab(r, g, b)
      const chroma = Math.hypot(a, bb)
      out.set([l / 100, chroma / 150, hueOf(a, bb)])
      return r === g && g === b ? 0 : unit(chroma / 2)
    }
  }
}

/**
 * The vectorscope's plane for a model: its own chroma plane when it has one, YCbCr's for the RGB
 * models. `scale` stretches the plane's opponent axes so the sRGB gamut nearly fills the circle.
 */
export const vectorPlane = (model: ScopeModel) => {
  switch (model) {
    case 'hsl':
    case 'hsv':
      return { model, polar: true, label: model === 'hsl' ? 'HSL' : 'HSV' } as const
    case 'oklab':
    case 'oklch':
      return { model: 'oklab', polar: false, scale: 0.8 / 0.35, label: 'OKLab a b' } as const
    case 'cielab':
    case 'cielch':
      return { model: 'cielab', polar: false, scale: 250 / 130, label: 'CIELAB a* b*' } as const
    default:
      return { model: 'ycbcr', polar: false, scale: 1 / 0.6, label: 'YCbCr Cb Cr' } as const
  }
}
export type VectorPlane = ReturnType<typeof vectorPlane>

/** A colour's position on a vectorscope plane, with the circle's edge at radius 1 and up as +y. */
export const planePoint = (
  plane: VectorPlane,
  r: number,
  g: number,
  b: number,
  scratch: Float64Array,
): readonly [number, number] => {
  coordinates(plane.model, r, g, b, scratch)
  const [first = 0, second = 0, third = 0] = scratch
  if (plane.polar) {
    const angle = first * TURN
    return [second * Math.cos(angle), second * Math.sin(angle)]
  }
  return [(second - 0.5) * plane.scale, (third - 0.5) * plane.scale]
}

/** CIE 1931 xy chromaticity of an sRGB colour, or nothing for black. */
export const chromaticity = (
  r: number,
  g: number,
  b: number,
): readonly [number, number] | undefined => {
  const [x, y, z] = xyz(r, g, b)
  const sum = x + y + z
  return sum > 0 ? [x / sum, y / sum] : undefined
}

/** The chromaticity scope's window onto xy, which holds the whole spectral locus. */
export const XY_BOUNDS = { x: 0.8, y: 0.9 } as const
export const SRGB_PRIMARIES = [
  [0.64, 0.33],
  [0.3, 0.6],
  [0.15, 0.06],
] as const
export const D65 = [0.3127, 0.329] as const

/**
 * The spectral locus: CIE 1931 2° chromaticities from 380 to 700 nm, as `[nm, x, y]`, closer
 * together where the curve bends. Joining its ends gives the line of purples.
 */
export const SPECTRAL_LOCUS: readonly (readonly [number, number, number])[] = [
  [380, 0.1741, 0.005],
  [420, 0.1714, 0.0051],
  [440, 0.1644, 0.0109],
  [450, 0.1566, 0.0177],
  [460, 0.144, 0.0297],
  [465, 0.1355, 0.0399],
  [470, 0.1241, 0.0578],
  [475, 0.1096, 0.0868],
  [480, 0.0913, 0.1327],
  [485, 0.0687, 0.2007],
  [490, 0.0454, 0.295],
  [495, 0.0235, 0.4127],
  [500, 0.0082, 0.5384],
  [505, 0.0039, 0.6548],
  [510, 0.0139, 0.7502],
  [515, 0.0389, 0.812],
  [520, 0.0743, 0.8338],
  [525, 0.1142, 0.8262],
  [530, 0.1547, 0.8059],
  [540, 0.2296, 0.7543],
  [550, 0.3016, 0.6923],
  [560, 0.3731, 0.6245],
  [570, 0.4441, 0.5547],
  [580, 0.5125, 0.4866],
  [590, 0.5752, 0.4242],
  [600, 0.627, 0.3725],
  [610, 0.6658, 0.334],
  [620, 0.6915, 0.3083],
  [640, 0.719, 0.2809],
  [660, 0.73, 0.27],
  [700, 0.7347, 0.2653],
]

/** The encoded sRGB colour to paint at chromaticity `xy`, at full brightness and clipped to gamut. */
export const chromaticityColour = ([x, y]: readonly [number, number]): Rgb => {
  const X = x / y
  const Z = (1 - x - y) / y
  const r = Math.max(0, 3.2404542 * X - 1.5371385 - 0.4985314 * Z)
  const g = Math.max(0, -0.969266 * X + 1.8760108 + 0.041556 * Z)
  const b = Math.max(0, 0.0556434 * X - 0.2040259 + 1.0572252 * Z)
  const peak = Math.max(r, g, b) || 1
  const byte = (value: number): number => Math.round(encode(value / peak) * 255)
  return [byte(r), byte(g), byte(b)]
}

/** An sRGB colour's value on a curve input, from 0 through 1, as the curve axes read it. */
export const channelValue = (
  channel: { readonly model: CurveModel; readonly channel: ChannelName },
  [r, g, b]: Rgb,
): number => {
  const out = new Float64Array(3)
  coordinates(channel.model, r, g, b, out)
  const model = CURVE_MODELS.find(({ id }) => id === channel.model)
  const index = model?.channels.findIndex(({ name }) => name === channel.channel) ?? 0
  return unit(out[index] ?? 0)
}
