import { PALETTE_RGB } from '@caelestis/shared'
import type {
  AlphaMode,
  ColorSpaceId,
  DitherId,
  DitherPlacement,
  ResizeAnchor,
  ResizeId,
} from '@caelestis/ui/elements'
import type { Field, Matching, Placement, RecipeV2, WorkingSpace } from 'ditherette'

/**
 * The template studio's settings, as Ditherette web keeps them, and the Ditherette recipe they
 * describe. The translation is Ditherette web's own, so a template matches what its editor shows.
 */
export interface StudioSettings {
  readonly output: {
    readonly width: number
    readonly height: number
    readonly resize: ResizeId
    readonly anchor: ResizeAnchor
  }
  readonly alpha: {
    readonly mode: AlphaMode
    /** Alpha below this becomes transparent, from 0 to 255. */
    readonly threshold: number
    /** The Wplace colour transparency blends onto in matte mode. */
    readonly matte: number
  }
  readonly colorSpace: ColorSpaceId
  readonly dither: {
    readonly algorithm: DitherId
    /** Percent; 0 turns dithering off. Yliluoma has no strength. */
    readonly strength: number
    readonly placement: DitherPlacement
    /** Side of the square area Adaptive samples, in output pixels. */
    readonly placementSampleSize: number
    /** Highest local sharpness, in percent, that Adaptive still treats as smooth. */
    readonly placementContrastThreshold: number
    readonly serpentine: boolean
    readonly seed: number
    /** Spread error, or offset thresholds, in the matching space rather than sRGB bytes. */
    readonly useColorSpace: boolean
  }
  readonly effects: RecipeV2['effects']
}

/** Ditherette web's defaults. Output size and the matte colour follow the image and palette. */
export const DEFAULT_STUDIO_SETTINGS: Pick<StudioSettings, 'colorSpace' | 'dither' | 'effects'> = {
  colorSpace: 'oklab',
  dither: {
    algorithm: 'none',
    strength: 100,
    placement: 'everywhere',
    placementSampleSize: 64,
    placementContrastThreshold: 12,
    serpentine: true,
    seed: 0xc0ffee42,
    useColorSpace: false,
  },
  effects: [],
}

const MAX_ADAPTIVE_SAMPLE_SIZE = 100

const MATCHING = {
  srgb: 'srgb-euclidean',
  'linear-rgb': 'linear-rgb-euclidean',
  oklab: 'oklab-euclidean',
  cielab: 'cielab-euclidean',
  'cielab-ciede2000': 'cielab-ciede2000',
  oklch: 'oklch-hue-arc',
  'oklch-euclidean': 'oklch-euclidean',
  'oklch-circular-hue': 'oklch-circular-hue',
  cielch: 'cielch-hue-arc',
  'cielch-euclidean': 'cielch-euclidean',
  'cielch-circular-hue': 'cielch-circular-hue',
  ycbcr: 'ycbcr-euclidean',
  'weighted-rgb': 'srgb-compuphase',
  'weighted-rgb-601': 'srgb-rec601',
  'weighted-rgb-709': 'srgb-rec709',
} as const satisfies Record<ColorSpaceId, Matching>

const WORKING_SPACE = {
  srgb: 'srgb',
  'linear-rgb': 'linear-rgb',
  oklab: 'oklab',
  cielab: 'cielab',
  'cielab-ciede2000': 'cielab',
  oklch: 'oklch',
  'oklch-euclidean': 'oklch',
  'oklch-circular-hue': 'oklch',
  cielch: 'cielch',
  'cielch-euclidean': 'cielch',
  'cielch-circular-hue': 'cielch',
  ycbcr: 'ycbcr',
  'weighted-rgb': 'srgb',
  'weighted-rgb-601': 'srgb',
  'weighted-rgb-709': 'srgb',
} as const satisfies Record<ColorSpaceId, WorkingSpace>

const resizePolicy = (resize: ResizeId, anchor: ResizeAnchor): RecipeV2['output']['resize'] => {
  switch (resize) {
    case 'nearest':
    case 'bilinear':
    case 'trilinear':
      return { algorithm: resize, anchor }
    case 'bicubic':
    case 'lanczos2':
    case 'lanczos3':
      return { algorithm: resize, anchor, support: 'fixed' }
    case 'bicubic-scale-aware':
      return { algorithm: 'bicubic', anchor, support: 'scale-aware' }
    case 'lanczos2-scale-aware':
      return { algorithm: 'lanczos2', anchor, support: 'scale-aware' }
    case 'lanczos3-scale-aware':
      return { algorithm: 'lanczos3', anchor, support: 'scale-aware' }
    case 'area':
      return { algorithm: 'area' }
  }
}

type MatrixSize = '2' | '4' | '8' | '16'
const YLILUOMA_SIZE: Partial<Record<DitherId, MatrixSize>> = {
  'yliluoma-2': '2',
  'yliluoma-4': '4',
  'yliluoma-8': '8',
  'yliluoma-16': '16',
}
const BAYER_SIZE: Partial<Record<DitherId, MatrixSize>> = {
  'bayer-2': '2',
  'bayer-4': '4',
  'bayer-8': '8',
  'bayer-16': '16',
}
const ORDERED_TILE: Partial<Record<DitherId, Extract<Field, { algorithm: 'ordered' }>['tile']>> = {
  'ordered-3x1': '3x1',
  'ordered-4x1': '4x1',
  'ordered-4x2': '4x2',
  'ordered-5x3': '5x3',
}

/** Ditherette web's byte-space 100% is 96/63.75 of the package's normalised field strength. */
const BYTE_FIELD_STRENGTH_RATIO = 96 / 63.75

const fieldFor = (algorithm: DitherId, seed: number): Field => {
  const size = BAYER_SIZE[algorithm]
  if (size !== undefined) return { algorithm: 'bayer', size }
  const tile = ORDERED_TILE[algorithm]
  if (tile !== undefined) return { algorithm: 'ordered', tile }
  if (algorithm === 'blue-noise') return { algorithm: 'blue-noise' }
  return { algorithm: 'random', seed: seed >>> 0 }
}

const ditherPolicy = (settings: StudioSettings): RecipeV2['dither'] => {
  const { dither } = settings
  const placement: Placement =
    dither.placement === 'everywhere'
      ? { mode: 'everywhere' }
      : {
          mode: 'smooth-area-v1',
          sampleSize: Math.min(
            MAX_ADAPTIVE_SAMPLE_SIZE,
            Math.max(4, Math.round(dither.placementSampleSize)),
          ),
          contrastThreshold: Math.min(1, Math.max(0, dither.placementContrastThreshold / 100)),
        }
  const { algorithm } = dither
  // Yliluoma places whole palette colours, so it has no strength to turn down.
  const mixing = YLILUOMA_SIZE[algorithm]
  if (mixing !== undefined) return { family: 'yliluoma', size: mixing, placement }
  const strength = dither.strength / 100
  if (algorithm === 'none' || strength === 0) return { family: 'none' }
  const vector = dither.useColorSpace && settings.colorSpace !== 'weighted-rgb'
  switch (algorithm) {
    case 'floyd-steinberg':
    case 'sierra':
    case 'sierra-lite':
    case 'atkinson':
    case 'jarvis-judice-ninke':
    case 'stucki':
    case 'burkes':
    case 'two-row-sierra':
    case 'fan':
    case 'shiau-fan':
    case 'shiau-fan-2':
    case 'simple-2d':
      return {
        family: 'diffusion',
        kernel: algorithm,
        feedback: vector ? 'matching' : 'srgb-bytes',
        strength,
        serpentine: dither.serpentine,
        placement,
      }
    default:
      return {
        family: 'separable',
        perturb: {
          field: fieldFor(algorithm, dither.seed),
          space: vector ? WORKING_SPACE[settings.colorSpace] : 'srgb',
          strength: strength * (vector ? 1 : BYTE_FIELD_STRENGTH_RATIO),
          placement,
        },
      }
  }
}

/** The Ditherette recipe the settings describe. Always version 2: it resizes weighted by coverage. */
export const studioRecipe = (settings: StudioSettings): RecipeV2 => {
  const { alpha, output } = settings
  const matte = PALETTE_RGB[alpha.matte] ?? [0, 0, 0]
  return {
    version: 2,
    effects: settings.effects,
    output: {
      width: output.width,
      height: output.height,
      resize: resizePolicy(output.resize, output.anchor),
    },
    alpha:
      alpha.mode === 'preserve'
        ? { mode: 'preserve', threshold: alpha.threshold }
        : alpha.mode === 'matte'
          ? { mode: 'matte', rgb: [matte[0], matte[1], matte[2]] }
          : { mode: 'premultiplied' },
    match: MATCHING[settings.colorSpace],
    dither: ditherPolicy(settings),
  }
}
