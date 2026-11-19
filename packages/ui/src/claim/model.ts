import {
  MAX_REGION_SHAPE_CORNERS,
  MAX_STROKE_WIDTH,
  MIN_REGION_SHAPE_CORNERS,
} from '@caelestis/shared'
import type { IconName } from '../foundations/icons.svelte.js'

/**
 * Claim mode's vocabulary: its tools and their groups, keys, options and hints. The userscript's
 * editor and `ClaimMode.svelte` both read it, so a tool or key changes in one place.
 *
 * Claim mode is a tool drawer on the left and a cancel-or-confirm bar at the top. Capture mode is
 * the same editor selecting committed art to download or add as a template instead of claiming
 * it. Update mode selects the parts of an existing template to replace with committed art.
 */

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

export type ClaimOption = 'sides' | 'points' | 'inner' | 'width'

export interface ClaimToolEntry {
  readonly tool: ClaimTool
  readonly group: ClaimToolGroupId
  readonly label: string
  /** The key as the drawer shows it; empty for a tool without one. */
  readonly key: string
  /** `KeyboardEvent.key` values, lowercased, that pick the tool; `shift+` requires Shift. */
  readonly keys: readonly string[]
  readonly icon: IconName
  /** The options the tool takes, in bar order. */
  readonly options: readonly ClaimOption[]
  /** Whether the tool's shapes can cut out of the claim instead of adding to it. */
  readonly subtracts: boolean
  readonly hint: string
}

const tool = (
  entry: Omit<ClaimToolEntry, 'keys' | 'options' | 'subtracts' | 'hint'> &
    Partial<Pick<ClaimToolEntry, 'keys' | 'options' | 'subtracts' | 'hint'>>,
): ClaimToolEntry => ({
  keys: entry.key === '' ? [] : [entry.key.toLowerCase()],
  options: [],
  subtracts: false,
  hint: '',
  ...entry,
})

/** Illustrator's keys where it has them: V, A, Q, P, N, B, M, L. */
const CLAIM_TOOLS: readonly ClaimToolEntry[] = [
  tool({
    tool: 'select',
    group: 'selection',
    label: 'Selection',
    key: 'V',
    icon: 'toolSelect',
    hint: 'Shift-click adds to the selection. Drag empty canvas to select several.',
  }),
  tool({
    tool: 'direct',
    group: 'selection',
    label: 'Direct selection',
    key: 'A',
    icon: 'toolDirect',
  }),
  tool({
    tool: 'lasso',
    group: 'selection',
    label: 'Lasso',
    key: 'Q',
    icon: 'toolLasso',
    hint: 'Shift adds to the selection.',
  }),
  tool({
    tool: 'pen',
    group: 'pen',
    label: 'Pen',
    key: 'P',
    icon: 'toolPen',
    options: ['width'],
    subtracts: true,
    hint: 'Click the first anchor to close. Enter finishes an open path.',
  }),
  tool({
    tool: 'add-anchor',
    group: 'pen',
    label: 'Add anchor',
    key: '+',
    keys: ['+', '='],
    icon: 'toolAddAnchor',
  }),
  tool({
    tool: 'delete-anchor',
    group: 'pen',
    label: 'Delete anchor',
    key: '−',
    keys: ['-', '_'],
    icon: 'toolDeleteAnchor',
  }),
  tool({
    tool: 'anchor',
    group: 'pen',
    label: 'Anchor point',
    key: 'Shift+C',
    icon: 'toolAnchor',
    hint: 'Drag out of a corner for handles. Click a smooth anchor for a corner.',
  }),
  tool({
    tool: 'pencil',
    group: 'pencil',
    label: 'Pencil',
    key: 'N',
    icon: 'toolPencil',
    options: ['width'],
    subtracts: true,
    hint: 'Strokes join the selected drawing.',
  }),
  tool({
    tool: 'brush',
    group: 'pencil',
    label: 'Paintbrush',
    key: 'B',
    icon: 'toolBrush',
    options: ['width'],
    subtracts: true,
  }),
  tool({
    tool: 'eraser',
    group: 'pencil',
    label: 'Eraser',
    key: 'E',
    icon: 'toolEraser',
    options: ['width'],
    hint: 'Cuts vector shapes into separate pieces.',
  }),
  tool({
    tool: 'rectangle',
    group: 'shape',
    label: 'Rectangle',
    key: 'M',
    icon: 'toolRectangle',
    subtracts: true,
  }),
  tool({
    tool: 'ellipse',
    group: 'shape',
    label: 'Ellipse',
    key: 'L',
    icon: 'toolEllipse',
    subtracts: true,
  }),
  tool({
    tool: 'polygon',
    group: 'shape',
    label: 'Polygon',
    key: '',
    icon: 'toolPolygon',
    options: ['sides'],
    subtracts: true,
  }),
  tool({
    tool: 'star',
    group: 'shape',
    label: 'Star',
    key: '',
    icon: 'toolStar',
    options: ['points', 'inner'],
    subtracts: true,
  }),
  tool({
    tool: 'hand',
    group: 'navigate',
    label: 'Hand',
    key: 'H',
    icon: 'toolHand',
    hint: 'Hold Space for the hand from any tool.',
  }),
]

export interface ClaimToolGroup {
  readonly id: ClaimToolGroupId
  readonly label: string
  readonly tools: readonly ClaimToolEntry[]
  /** The tool the group's button shows until another from the group is used. */
  readonly first: ClaimTool
}

const group = (id: ClaimToolGroupId, label: string, first: ClaimTool): ClaimToolGroup => ({
  id,
  label,
  tools: CLAIM_TOOLS.filter((entry) => entry.group === id),
  first,
})

export const CLAIM_TOOL_GROUPS: readonly ClaimToolGroup[] = [
  group('selection', 'Selection tools', 'select'),
  group('pen', 'Pen tools', 'pen'),
  group('pencil', 'Drawing tools', 'pencil'),
  group('shape', 'Shape tools', 'rectangle'),
  group('navigate', 'Navigation tools', 'hand'),
]

export const claimToolEntry = (of: ClaimTool): ClaimToolEntry =>
  CLAIM_TOOLS.find((entry) => entry.tool === of) as ClaimToolEntry

/** The tool a key picks, or null. Letters pick their tool with or without Shift. */
export const claimToolForKey = (key: string, shift: boolean): ClaimTool | null => {
  const pressed = key.toLowerCase()
  const strokes = shift ? [`shift+${pressed}`, pressed] : [pressed]
  for (const stroke of strokes) {
    const entry = CLAIM_TOOLS.find((held) => held.keys.includes(stroke))
    if (entry !== undefined) return entry.tool
  }
  return null
}

/** The range an option accepts for a tool. A pen path may be fill only; nothing else may. */
export const claimOptionRange = (
  option: ClaimOption,
  of: ClaimTool,
): { readonly min: number; readonly max: number } => {
  switch (option) {
    case 'sides':
    case 'points':
      return { min: MIN_REGION_SHAPE_CORNERS, max: MAX_REGION_SHAPE_CORNERS }
    case 'inner':
      return { min: 5, max: 95 }
    case 'width':
      return { min: of === 'pen' ? 0 : 1, max: MAX_STROKE_WIDTH }
  }
}

/** An option value as a whole number in the tool's range. */
export const clampClaimOption = (option: ClaimOption, of: ClaimTool, value: number): number => {
  const { min, max } = claimOptionRange(option, of)
  return Math.min(max, Math.max(min, Math.round(value)))
}

export type ClaimPurpose = 'claim' | 'capture' | 'update'

/** The line under the bar when nothing more pressing is said. */
export const claimModeHint = (purpose: ClaimPurpose, items: number, of: ClaimTool): string => {
  if (purpose === 'capture' && items === 0)
    return 'Draw around the art to capture. Enter adds it as a template.'
  if (purpose === 'update' && items === 0)
    return 'Draw around the parts to take from the canvas. Enter updates the template.'
  return claimToolEntry(of).hint
}

/** What capture or update mode does with the selected art. */
export type CaptureAction = 'download' | 'template' | 'update'

/** Values of the options the tool in hand takes; only those are set. */
export type ClaimToolOptions = Partial<Record<ClaimOption, number>>

export interface ClaimModeModel {
  readonly purpose: ClaimPurpose
  readonly tool: ClaimTool
  /** The tool each drawer group shows: the one last used from it. */
  readonly shown: Readonly<Record<ClaimToolGroupId, ClaimTool>>
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
  | { readonly type: 'set-option'; readonly option: ClaimOption; readonly value: number }
  | { readonly type: 'set-subtract'; readonly subtract: boolean }
  | { readonly type: 'delete-item' }
  | { readonly type: 'confirm' }
  | { readonly type: 'capture'; readonly action: CaptureAction }
  | { readonly type: 'cancel' }
