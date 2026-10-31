import {
  chromaticity,
  chromaticityColour,
  coordinates,
  planePoint,
  type Rgb,
  SCOPE_MODELS,
  type ScopeModel,
  SPECTRAL_LOCUS,
  type VectorPlane,
  XY_BOUNDS,
} from '../colour.js'

/**
 * Ditherette web's scopes: sampled pixels as histograms, waveforms, a vectorscope, and the CIE
 * chromaticity diagram, each painted like light on a scope's screen.
 */

/** The scopes the Scopes window offers, in its menu order. */
export const SCOPES = [
  { id: 'histogram', label: 'Histogram' },
  { id: 'waveform', label: 'Waveform' },
  { id: 'parade', label: 'Parade' },
  { id: 'vectorscope', label: 'Vectorscope' },
  { id: 'chromaticity', label: 'CIE chromaticity' },
] as const
export type ScopeKind = (typeof SCOPES)[number]['id']

/** The images the scopes inspect, in pipeline order. */
export const SCOPE_STAGES = [
  { id: 'source', label: 'Source' },
  { id: 'effects', label: 'Effects' },
  { id: 'output', label: 'Output' },
] as const
export type ScopeStage = (typeof SCOPE_STAGES)[number]['id']

/** Pixels picked from an image: where each sits across the width, and its colour. */
export interface Samples {
  readonly count: number
  readonly column: Float32Array
  readonly rgb: Uint8Array
}

export const LEVELS = 256
export const WAVE_COLUMNS = 512
export const PLANE_SIZE = 256
/** How bright the xy diagram's colour backdrop glows, so samples stand out over it. */
const BACKDROP_STRENGTH = 0.45

/** A value from a typed array the caller has already bounded. */
const read = (list: ArrayLike<number>, index: number): number => list[index] ?? 0

/**
 * Shares of the visible samples that are pure black or pure white: all three channels at 0 or at
 * 255. Undefined without samples.
 */
export const clipping = ({ count, rgb }: Samples): { black: number; white: number } | undefined => {
  if (!count) return undefined
  let black = 0
  let white = 0
  for (let sample = 0; sample < count; sample++) {
    const at = sample * 3
    const [r, g, b] = [read(rgb, at), read(rgb, at + 1), read(rgb, at + 2)]
    if (r === 0 && g === 0 && b === 0) black++
    else if (r === 255 && g === 255 && b === 255) white++
  }
  return { black: black / count, white: white / count }
}

/** A share as a short percentage: "0%", "<0.1%", "2%", "2.1%", "50%", "99.9%", ">99.9%", "100%". */
export const formatShare = (share: number): string => {
  if (share <= 0) return '0%'
  if (share >= 1) return '100%'
  if (share < 0.001) return '<0.1%'
  if (share > 0.999) return '>99.9%'
  if (share < 0.1) return `${Number((share * 100).toFixed(1))}%`
  const percent = share * 100
  // One decimal near either end, so a partial share never rounds to 0% or 100%.
  return `${Number(percent.toFixed(percent < 10 || percent >= 99.5 ? 1 : 0))}%`
}

/** Visits each sample's normalised coordinates in `model`, with how much its hue counts. */
const eachCoordinate = (
  { count, rgb }: Samples,
  model: ScopeModel,
  visit: (sample: number, point: Float64Array, hueWeight: number) => void,
): void => {
  const point = new Float64Array(3)
  for (let sample = 0; sample < count; sample++) {
    const at = sample * 3
    const hueWeight = coordinates(model, read(rgb, at), read(rgb, at + 1), read(rgb, at + 2), point)
    visit(sample, point, hueWeight)
  }
}

const hueChannel = (model: ScopeModel): number =>
  SCOPE_MODELS.find(({ id }) => id === model)?.channels.findIndex(({ name }) => name === 'hue') ??
  -1
const level = (value: number): number =>
  Math.min(LEVELS - 1, Math.max(0, Math.floor(value * LEVELS)))
export type Channels = readonly [Float32Array, Float32Array, Float32Array]
const channels = (length: number): Channels => [
  new Float32Array(length),
  new Float32Array(length),
  new Float32Array(length),
]

/** Samples per level for each of the model's channels. Greys count toward hue by its confidence. */
export const histogram = (samples: Samples, model: ScopeModel): Channels => {
  const bins = channels(LEVELS)
  const hue = hueChannel(model)
  eachCoordinate(samples, model, (_, point, hueWeight) => {
    bins.forEach((bin, channel) => {
      const at = level(read(point, channel))
      bin[at] = read(bin, at) + (channel === hue ? hueWeight : 1)
    })
  })
  return bins
}

/**
 * Samples per level and image column for each channel, as `WAVE_COLUMNS`-wide rows with the top
 * level first, ready to paint.
 */
export const waveform = (samples: Samples, model: ScopeModel): Channels => {
  const grid = channels(WAVE_COLUMNS * LEVELS)
  const hue = hueChannel(model)
  eachCoordinate(samples, model, (sample, point, hueWeight) => {
    const column = Math.min(
      WAVE_COLUMNS - 1,
      Math.floor(read(samples.column, sample) * WAVE_COLUMNS),
    )
    grid.forEach((plane, channel) => {
      const at = (LEVELS - 1 - level(read(point, channel))) * WAVE_COLUMNS + column
      plane[at] = read(plane, at) + (channel === hue ? hueWeight : 1)
    })
  })
  return grid
}

/** Samples per cell of a square plot, plus the sum of their colours, for a colourised trace. */
export interface Scatter {
  readonly density: Float32Array
  readonly sums: Float32Array
}

const scatter = (
  { count, rgb }: Samples,
  place: (r: number, g: number, b: number) => readonly [number, number] | undefined,
): Scatter => {
  const density = new Float32Array(PLANE_SIZE * PLANE_SIZE)
  const sums = new Float32Array(PLANE_SIZE * PLANE_SIZE * 3)
  for (let sample = 0; sample < count; sample++) {
    const at = sample * 3
    const [r, g, b] = [read(rgb, at), read(rgb, at + 1), read(rgb, at + 2)]
    const point = place(r, g, b)
    if (!point) continue
    const x = Math.floor(point[0] * PLANE_SIZE)
    const y = Math.floor((1 - point[1]) * PLANE_SIZE)
    if (x < 0 || y < 0 || x >= PLANE_SIZE || y >= PLANE_SIZE) continue
    const cell = y * PLANE_SIZE + x
    density[cell] = read(density, cell) + 1
    sums[cell * 3] = read(sums, cell * 3) + r
    sums[cell * 3 + 1] = read(sums, cell * 3 + 1) + g
    sums[cell * 3 + 2] = read(sums, cell * 3 + 2) + b
  }
  return { density, sums }
}

/** How far the vectorscope's square reaches past its unit circle, leaving room for target labels. */
export const VECTOR_EXTENT = 1.25

/**
 * The vectorscope: each sample's position on `plane`, magnified `zoom` times, in a square
 * reaching `VECTOR_EXTENT`.
 */
export const vectorscope = (samples: Samples, plane: VectorPlane, zoom = 1): Scatter => {
  const scratch = new Float64Array(3)
  const scale = zoom / VECTOR_EXTENT
  return scatter(samples, (r, g, b) => {
    const [u, v] = planePoint(plane, r, g, b, scratch)
    return [(u * scale + 1) / 2, (v * scale + 1) / 2]
  })
}

/** The CIE 1931 chromaticity scope, over `XY_BOUNDS`. */
export const chromaticityScope = (samples: Samples): Scatter =>
  scatter(samples, (r, g, b) => {
    const xy = chromaticity(r, g, b)
    return xy && [xy[0] / XY_BOUNDS.x, xy[1] / XY_BOUNDS.y]
  })

/**
 * A density layer to paint: in one colour, or in the average colour of each cell's samples, at
 * `strength` of full brightness.
 */
export interface Layer {
  readonly density: Float32Array
  readonly colour: Rgb | Float32Array
  readonly strength?: number
}

const inLocus = (x: number, y: number): boolean => {
  let crossings = 0
  SPECTRAL_LOCUS.forEach(([, x1, y1], index) => {
    const [, x2, y2] = SPECTRAL_LOCUS[(index + 1) % SPECTRAL_LOCUS.length] ?? [0, x1, y1]
    if (y1 > y !== y2 > y && x < x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)) crossings++
  })
  return crossings % 2 === 1
}

let backdrop: Layer | undefined
/**
 * The xy diagram's backdrop: every chromaticity inside the spectral locus in its own colour, as a
 * faint layer to paint under the samples. Built once.
 */
export const chromaticityBackdrop = (): Layer => {
  if (backdrop !== undefined) return backdrop
  const density = new Float32Array(PLANE_SIZE * PLANE_SIZE)
  const colour = new Float32Array(PLANE_SIZE * PLANE_SIZE * 3)
  for (let row = 0; row < PLANE_SIZE; row++) {
    for (let column = 0; column < PLANE_SIZE; column++) {
      const xy = [
        ((column + 0.5) / PLANE_SIZE) * XY_BOUNDS.x,
        (1 - (row + 0.5) / PLANE_SIZE) * XY_BOUNDS.y,
      ] as const
      if (!inLocus(...xy)) continue
      const cell = row * PLANE_SIZE + column
      density[cell] = 1
      colour.set(chromaticityColour(xy), cell * 3)
    }
  }
  backdrop = { density, colour, strength: BACKDROP_STRENGTH }
  return backdrop
}

const NEUTRAL: Rgb = [200, 200, 208]
/** How bright the source glows under the output, so the output's colours read on top. */
const UNDER = 0.6

/** An earlier stage's samples drawn dim and neutral under the later one's colours. */
export const underLayer = (density: Float32Array): Layer => ({
  density,
  colour: NEUTRAL,
  strength: UNDER,
})

/** Adds each channel's density into one, for an earlier stage drawn neutral under a later one. */
export const combined = (grids: readonly Float32Array[]): Float32Array => {
  const sum = new Float32Array(grids[0]?.length ?? 0)
  for (const grid of grids)
    for (let cell = 0; cell < sum.length; cell++) sum[cell] = read(sum, cell) + read(grid, cell)
  return sum
}

/** The density at which a cell glows at about two thirds of full: twice the typical busy cell. */
const exposure = (density: Float32Array): number => {
  let total = 0
  let filled = 0
  for (const value of density) {
    if (!value) continue
    total += value
    filled++
  }
  return filled ? (2 * total) / filled : 1
}

/**
 * Adds the layers into one RGBA image, like light on a scope's screen. Each layer's brightness
 * rises smoothly with density, so sparse detail stays visible next to a crowded level.
 */
export const paint = (width: number, height: number, layers: readonly Layer[]): ImageData => {
  const light = new Float32Array(width * height * 3)
  for (const { density, colour, strength = 1 } of layers) {
    const scale = exposure(density)
    const perCell = colour.length !== 3
    for (let cell = 0; cell < density.length; cell++) {
      const value = read(density, cell)
      if (!value) continue
      const glow = strength * (1 - Math.exp(-value / scale))
      const at = cell * 3
      // A colourised layer lifts each cell's average colour to full brightness, so dark
      // samples still show their hue; black has none, so it glows white like the other
      // greys. Density alone sets how bright it glows.
      const peak = perCell
        ? Math.max(read(colour, at), read(colour, at + 1), read(colour, at + 2))
        : 0
      for (let channel = 0; channel < 3; channel++) {
        const tone = !perCell
          ? read(colour, channel)
          : peak === 0
            ? 255
            : (read(colour, at + channel) * 255) / peak
        light[at + channel] = read(light, at + channel) + tone * glow
      }
    }
  }
  // Opaque, on black: the scope's screen.
  const image = new ImageData(width, height)
  for (let cell = 0; cell < width * height; cell++) {
    image.data.set(light.subarray(cell * 3, cell * 3 + 3), cell * 4)
    image.data[cell * 4 + 3] = 255
  }
  return image
}

/** Keeps at most two stages, in pipeline order, dropping the one turned on longest ago. */
export const pickStages = (
  next: readonly ScopeStage[],
  recent: readonly ScopeStage[],
): ScopeStage[] => {
  const shown = SCOPE_STAGES.map(({ id }) => id).filter((id) => next.includes(id))
  if (shown.length <= 2) return shown
  const dropped = recent.find((stage) => shown.includes(stage)) ?? shown[0]
  return shown.filter((stage) => stage !== dropped)
}
