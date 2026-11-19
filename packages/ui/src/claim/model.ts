import type { IconName } from '../foundations/icons.svelte.js'

/** The tools of claim mode, in drawer order. */
export type ClaimTool =
  | 'select'
  | 'direct'
  | 'lasso'
  | 'pen'
  | 'add-anchor'
  | 'delete-anchor'
  | 'anchor'
  | 'pencil'
  | 'brush'
  | 'eraser'
  | 'rectangle'
  | 'ellipse'
  | 'polygon'
  | 'star'
  | 'hand'

/** Tools sit in groups, Illustrator-style: one drawer button per group with a flyout to switch. */
export type ClaimToolGroupId = 'selection' | 'pen' | 'pencil' | 'shape' | 'navigate'

export interface ClaimToolEntry {
  readonly tool: ClaimTool
  readonly group: ClaimToolGroupId
  readonly label: string
  readonly key: string
  readonly icon: IconName
}

export interface ClaimToolGroup {
  readonly id: ClaimToolGroupId
  readonly label: string
  readonly tools: readonly ClaimToolEntry[]
  /** The tool the group's button shows: the one last used from it. */
  readonly shown: ClaimTool
}

/** Options for the tool in hand; only the ones that apply are set. */
export interface ClaimToolOptions {
  readonly sides?: number
  readonly points?: number
  /** Inner radius as a percentage of the outer radius. */
  readonly inner?: number
  /** Stroke width in pixels, for pen, pencil, and brush. */
  readonly width?: number
  readonly minCorners: number
  readonly maxCorners: number
  readonly maxWidth: number
}

/**
 * Claim mode: a tool drawer on the left, a cancel-or-confirm bar at the top. Capture mode is the
 * same editor selecting committed art to download or add as a template instead of claiming it.
 * Update mode selects the parts of an existing template to replace with committed art.
 */
export interface ClaimModeModel {
  readonly purpose: 'claim' | 'capture' | 'update'
  readonly tool: ClaimTool
  readonly tools: readonly ClaimToolEntry[]
  readonly groups: readonly ClaimToolGroup[]
  readonly options: ClaimToolOptions
  /** Whether the next shape drawn cuts out of the claim instead of adding to it. */
  readonly subtract: boolean
  /** Items in the document, and how many are selected. */
  readonly items: number
  readonly selected: boolean
  readonly selectedCount: number
  /** Whether anything differs from what is saved: what Save writes and Cancel discards. */
  readonly dirty: boolean
  /** The template the claim overlaps, or null. Shown for context; a claim needs no template. */
  readonly template: string | null
  /** Pixels the claim covers. */
  readonly pixels: number
  readonly pending: boolean
  readonly message?: string
}

export type ClaimModeIntent =
  | { readonly type: 'set-tool'; readonly tool: ClaimTool }
  | {
      readonly type: 'set-option'
      readonly option: 'sides' | 'points' | 'inner' | 'width'
      readonly value: number
    }
  | { readonly type: 'set-subtract'; readonly subtract: boolean }
  | { readonly type: 'delete-item' }
  | { readonly type: 'confirm' }
  | { readonly type: 'capture'; readonly action: CaptureAction }
  | { readonly type: 'cancel' }

/** What capture or update mode does with the selected art. */
export type CaptureAction = 'download' | 'template' | 'update'
