import type { EffectLayer } from './effects/layers.js'
import type {
  AlphaMode,
  ColorSpaceId,
  DitherId,
  DitherPlacement,
  ResizeAnchor,
  ResizeId,
} from './options.js'
import type { Samples, ScopeStage } from './scopes/scopes.js'

/** The studio's tool windows, in Windows-menu order, with the edge each docks to by default. */
export const STUDIO_WINDOWS = [
  { id: 'source', title: 'Source', dock: 'start' },
  { id: 'dimensions', title: 'Dimensions', dock: 'start' },
  { id: 'palette', title: 'Palette', dock: 'end' },
  { id: 'color-space', title: 'Colour space', dock: 'end' },
  { id: 'dither', title: 'Dither', dock: 'end' },
  { id: 'effects', title: 'Effects', dock: 'start' },
  { id: 'scopes', title: 'Scopes', dock: 'end', closed: true },
] as const

export type StudioWindowId = (typeof STUDIO_WINDOWS)[number]['id']

/**
 * Where a window sits. A docked window stacks in the column along its screen edge, in `order`;
 * a floating one sits at `x`, `y` in viewport pixels, measured from the edge it is nearer to.
 */
export type StudioWindowPlacement =
  | {
      readonly open: boolean
      readonly collapsed: boolean
      readonly dock: 'start' | 'end'
      readonly order: number
    }
  | {
      readonly open: boolean
      readonly collapsed: boolean
      readonly dock: null
      readonly edge: 'start' | 'end'
      readonly x: number
      readonly y: number
    }

/** Saved per browser. A window missing here takes its default place. */
export type StudioLayout = Partial<Record<StudioWindowId, StudioWindowPlacement>>

export type StudioPaletteScope = 'all' | 'free' | 'premium' | 'owned'

/** Ditherette web's dither settings. */
export interface StudioDither {
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
  /** Perturb and diffuse error in the matching space rather than in sRGB bytes. */
  readonly useColorSpace: boolean
}

/** One drawable Wplace colour, whether the template may use it, and how much the result does. */
export interface StudioColour {
  readonly index: number
  readonly name: string
  readonly hex: string
  readonly kind: 'free' | 'premium'
  readonly selected: boolean
  /** Pixels of this colour in the current result. */
  readonly pixels: number
}

export interface StudioRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The template studio: Ditherette web's controls in floating windows over the live map, which
 * draws the result as an unsaved draft. Every value stays editable until Save or Cancel.
 */
export interface TemplateStudioModel {
  /** Saving creates a new template, or a new version of the named template. */
  readonly target:
    | { readonly kind: 'create'; readonly destination: string }
    | { readonly kind: 'replace'; readonly template: string }
  readonly name: string
  /** The decoded image, with an object URL the Source window draws. Null until one loads. */
  readonly source: {
    readonly name: string
    readonly width: number
    readonly height: number
    readonly url: string
  } | null
  readonly loadingSource: boolean
  readonly crop: StudioRect
  readonly output: {
    readonly width: number
    readonly height: number
    /** Output size over crop size, on the crop's longer side. */
    readonly scale: number
    readonly resize: ResizeId
    readonly anchor: ResizeAnchor
    /** A replacement keeps its template's size. */
    readonly locked: boolean
  }
  /** Top-left corner on the canvas. */
  readonly origin: { readonly x: number; readonly y: number }
  readonly palette: {
    /** The preset the chosen colours match, if any. Owned is unavailable until the account loads. */
    readonly scope: StudioPaletteScope | null
    readonly ownedKnown: boolean
    readonly colours: readonly StudioColour[]
  }
  readonly alpha: {
    readonly mode: AlphaMode
    /** Alpha below this becomes transparent, from 0 to 255. */
    readonly threshold: number
    /** The palette index transparency blends onto in matte mode. */
    readonly matte: number
  }
  readonly colorSpace: ColorSpaceId
  readonly dither: StudioDither
  /** The effect pipeline, run on the cropped source before resizing, in order. */
  readonly effects: readonly EffectLayer[]
  /** The palette-fit layer whose curves are being analysed for editing. */
  readonly analysingFit: string | null
  /** Samples of the stages the Scopes window shows; none while it is closed. */
  readonly scopes: {
    /** One or two, in pipeline order. */
    readonly stages: readonly ScopeStage[]
    readonly samples: Partial<Record<ScopeStage, Samples>>
    /** Settings changed since the samples were taken. */
    readonly pending: boolean
  }
  /** Where the last result was processed. Null until one has been. */
  readonly engine: 'gpu' | 'cpu' | null
  readonly processing:
    | { readonly state: 'idle' }
    | { readonly state: 'working'; readonly progress: number | null }
    | { readonly state: 'ready'; readonly pixels: number; readonly colours: number }
    | { readonly state: 'failed'; readonly message: string }
  /** Whether there are edits to step back or forward through. A new image starts a fresh history. */
  readonly history: { readonly undo: boolean; readonly redo: boolean }
  /** Saving. Every control waits for it. */
  readonly pending: boolean
  readonly message?: string
  readonly layout: StudioLayout
}

export type TemplateStudioIntent =
  | { readonly type: 'name'; readonly name: string }
  | { readonly type: 'file'; readonly file: File }
  | { readonly type: 'paste' }
  | { readonly type: 'url'; readonly url: string }
  | { readonly type: 'crop'; readonly crop: StudioRect }
  | { readonly type: 'reset-crop' }
  | { readonly type: 'scale'; readonly scale: number }
  /** One side in output pixels; the other follows the crop's proportions. */
  | { readonly type: 'size'; readonly side: 'width' | 'height'; readonly pixels: number }
  | { readonly type: 'resize'; readonly resize: ResizeId }
  | { readonly type: 'anchor'; readonly anchor: ResizeAnchor }
  | { readonly type: 'scope'; readonly scope: StudioPaletteScope }
  | { readonly type: 'colour'; readonly index: number; readonly selected: boolean }
  | { readonly type: 'alpha'; readonly alpha: Partial<TemplateStudioModel['alpha']> }
  | { readonly type: 'color-space'; readonly colorSpace: ColorSpaceId }
  | { readonly type: 'dither'; readonly dither: Partial<StudioDither> }
  | { readonly type: 'effects'; readonly effects: readonly EffectLayer[] }
  /** Resolve a palette-fit layer's curves into its step, so they can be edited. */
  | { readonly type: 'analyse-fit'; readonly layer: string }
  | { readonly type: 'scope-stages'; readonly stages: readonly ScopeStage[] }
  /** The Scopes window came on or off screen, as a window or a phone sheet; it samples while on. */
  | { readonly type: 'scopes-shown'; readonly shown: boolean }
  | { readonly type: 'origin'; readonly x: number; readonly y: number }
  | { readonly type: 'centre' }
  | { readonly type: 'layout'; readonly layout: StudioLayout }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  | { readonly type: 'save' }
  | { readonly type: 'cancel' }
