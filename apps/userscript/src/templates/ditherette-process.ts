import {
  type DitheretteEngine,
  type DitheretteTemplateRecipe,
  PALETTE_RGB,
  TRANSPARENT_INDEX,
} from '@caelestis/shared'
import {
  createDitherette,
  type Ditherette,
  type GpuDither,
  type PaletteEntry,
  type Progress,
  type Rgba8Image,
} from 'ditherette'

/**
 * One Ditherette recipe run: crop, then Ditherette's effects, resize, matching, and dither.
 *
 * The worker and the in-process fallback both call this, so a template rebuilt from its recipe on
 * either path is the artwork the studio showed.
 */

/** Processed artwork in Wplace's palette indices, and the engine that produced it. */
export interface DitheretteArtwork {
  readonly indices: Uint8Array
  readonly opaque: number
  readonly engine: DitheretteEngine
}

export type DitheretteProcessor = Ditherette | GpuDither

/**
 * Ditherette's processors for one context, each started on first use. The GPU engine diffuses
 * error in parallel, as Ditherette web's editor does; without WebGPU it is null.
 */
export const processors = (wasm: WebAssembly.Module, gpuWasm: WebAssembly.Module | null) => {
  let cpu: Promise<Ditherette> | null = null
  let gpu: Promise<GpuDither | null> | null = null
  const startGpu = async (): Promise<GpuDither | null> => {
    if (gpuWasm === null || typeof navigator === 'undefined' || !('gpu' in navigator)) return null
    try {
      return await createDitherette({
        engine: 'gpu',
        wasm,
        gpuWasm,
        diffusionBackend: 'gpu-approximate',
      })
    } catch {
      // No adapter, or the device refused: the CPU engine still processes everything.
      return null
    }
  }
  /** The processor for `engine`. A GPU request runs on the CPU where there is no GPU engine. */
  return async (engine: DitheretteEngine): Promise<DitheretteProcessor> => {
    if (engine === 'gpu') {
      gpu ??= startGpu()
      const started = await gpu
      if (started !== null) return started
    }
    cpu ??= createDitherette({ wasm })
    return await cpu
  }
}

/** The crop's pixels as packed RGBA8. A crop covering the whole source returns the source itself. */
export const cropRgba = (
  source: Rgba8Image,
  crop: DitheretteTemplateRecipe['crop'],
): Rgba8Image => {
  if (crop.x === 0 && crop.y === 0 && crop.width === source.width && crop.height === source.height)
    return source
  const data = new Uint8Array(crop.width * crop.height * 4)
  const row = crop.width * 4
  for (let y = 0; y < crop.height; y++) {
    const start = ((crop.y + y) * source.width + crop.x) * 4
    data.set(source.data.subarray(start, start + row), y * row)
  }
  return { width: crop.width, height: crop.height, data }
}

/** The recipe's colours in its order, then transparency, so thresholded alpha has a slot. */
const paletteEntries = (palette: readonly number[]): PaletteEntry[] => [
  ...palette.map((index): PaletteEntry => {
    const rgb = PALETTE_RGB[index]
    if (rgb === undefined) throw new RangeError(`palette index ${index} is not a Wplace colour`)
    return { kind: 'color', rgb }
  }),
  { kind: 'transparent' },
]

/**
 * Run a recipe on its decoded source. Throws Ditherette's own errors for refused settings, and an
 * AbortError when `signal` stops a GPU run; CPU runs are synchronous and always finish.
 */
export const processDitherette = async (
  processor: DitheretteProcessor,
  source: Rgba8Image,
  recipe: DitheretteTemplateRecipe,
  onProgress?: (progress: Progress) => void,
  signal?: AbortSignal,
): Promise<DitheretteArtwork> => {
  if (source.width !== recipe.source.width || source.height !== recipe.source.height)
    throw new Error('the decoded source is not the size its recipe names')
  const request = {
    source: cropRgba(source, recipe.crop),
    palette: paletteEntries(recipe.palette),
    recipe: recipe.ditherette,
    ...(onProgress === undefined ? {} : { onProgress }),
  }
  const gpu = 'execution' in processor
  const result = gpu ? await processor.process(request, signal) : processor.process(request)
  // Ditherette's GPU engine falls back to the CPU for stages it cannot run.
  const engine: DitheretteEngine = gpu && processor.execution?.backend !== 'cpu' ? 'gpu' : 'cpu'
  if (result.width !== recipe.width || result.height !== recipe.height)
    throw new Error('Ditherette returned unexpected template dimensions')
  // Ditherette indexes the entries above; the last one is transparency.
  const indices = new Uint8Array(result.indices.length)
  let opaque = 0
  for (let pixel = 0; pixel < indices.length; pixel++) {
    const index = recipe.palette[result.indices[pixel] ?? recipe.palette.length]
    if (index === undefined) {
      indices[pixel] = TRANSPARENT_INDEX
      continue
    }
    indices[pixel] = index
    opaque++
  }
  return { indices, opaque, engine }
}
