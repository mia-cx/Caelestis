import type { ResizeAnchor, ResizeId } from './options.js'

/** The studio's tool windows, in Windows-menu order. */
export const STUDIO_WINDOWS = [
  { id: 'source', title: 'Source' },
  { id: 'dimensions', title: 'Dimensions' },
] as const

export type StudioWindowId = (typeof STUDIO_WINDOWS)[number]['id']

/**
 * Where a window sits. A docked window stacks in the column along its screen edge, in `order`;
 * a floating one sits at `x`, `y` in viewport pixels, measured from the edge it is nearer to.
 */
export type StudioWindowPlacement =
  | { readonly open: boolean; readonly collapsed: boolean; readonly dock: 'start' | 'end'; readonly order: number }
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
  /** The map shows the unprocessed source in the draft's place. */
  readonly original: boolean
  /** Where processing runs. Null until Ditherette has loaded. */
  readonly engine: 'gpu' | 'cpu' | null
  readonly processing:
    | { readonly state: 'idle' }
    | { readonly state: 'working'; readonly progress: number | null }
    | { readonly state: 'ready'; readonly pixels: number; readonly colours: number }
    | { readonly state: 'failed'; readonly message: string }
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
  | { readonly type: 'origin'; readonly x: number; readonly y: number }
  | { readonly type: 'centre' }
  | { readonly type: 'original'; readonly original: boolean }
  | { readonly type: 'layout'; readonly layout: StudioLayout }
  | { readonly type: 'save' }
  | { readonly type: 'cancel' }
