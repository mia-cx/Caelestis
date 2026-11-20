import type { TileCoord } from '@caelestis/shared'
import type { MarkList } from './mark-list.js'

/**
 * What the pixel accounting engine (`mismatch.ts`) hands out: progress counts, marker lists and
 * colour navigation targets. Kept apart from the engine so its readers do not change with it.
 */

/**
 * Packed tile-local x/y/wanted-index marks, patched in place as pixels are painted. Empty when the
 * tile and template agree.
 */
export type Mismatches = MarkList

/** Counts for the part of a template whose Wplace tiles have actually been scanned. */
export interface TemplateProgress {
  readonly completed: number
  readonly mismatched: number
  readonly unpainted: number
  readonly known: number
  /** All non-transparent pixels the template asks for, including tiles not scanned yet. */
  readonly total: number
}

export interface TemplateColourProgress extends TemplateProgress {
  readonly index: number
}

/** A native draft's category-only correction relative to the last captured Wplace tile. */
export interface TemplateColourProgressDelta {
  readonly index: number
  readonly completed: number
  readonly mismatched: number
  readonly unpainted: number
}

/** One native draft pixel's correction, keyed so later batches can replace the same coordinate. */
export interface TemplateDraftPixelDelta extends TemplateColourProgressDelta {
  readonly key: string
  /** Identity plus per-pixel revision of the server source this correction was measured against. */
  readonly basis: string
}

export type ColourTargetKind = 'unpainted' | 'mismatched'

export interface ColourNavigationTarget {
  readonly templateId: string
  readonly x: number
  readonly y: number
  readonly kind: ColourTargetKind
}

export type ColourNavigationExclusion = Pick<
  ColourNavigationTarget,
  'kind' | 'templateId' | 'x' | 'y'
>

/** Every UI projection of one canonical template/tile classification. */
export interface TilePixelAccounting {
  /** Wrong-colour pixels only. */
  readonly mismatched: Mismatches
  /** Pixels with no server or draft colour. */
  readonly unpainted: Mismatches
  /** The configured marker projection, including unpainted only when its threshold allows it. */
  readonly markers: Mismatches
}

/** One synchronous view of the managed accounting state for a template. */
export interface TemplatePixelAccounting {
  readonly progress: TemplateProgress
  readonly colours: readonly TemplateColourProgress[]
  /** Sparse per-pixel draft corrections over captured server pixels, independent of scan coverage. */
  readonly draftPixelDeltas: readonly TemplateDraftPixelDelta[]
  /** Read or schedule one tile's canonical classification. */
  readonly tile: (tile: TileCoord) => TilePixelAccounting | null
  /** Read or schedule only the unpainted coordinates of one colour, for the selected-colour guide. */
  readonly unpainted: (tile: TileCoord, colour: number) => Mismatches | null
  /** Ensure aggregate-only accounting exists for this tile. */
  readonly ensure: (tile: TileCoord) => boolean
  /** Navigate through locations derived from this same accounting state. */
  readonly nearest: (
    index: number,
    kind: ColourTargetKind,
    reference: { readonly x: number; readonly y: number },
    exclude?: ColourNavigationExclusion,
  ) => Promise<ColourNavigationTarget | null>
}
