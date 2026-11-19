import type { AlarmKind, Progress } from '@caelestis/shared'
import type { IconName } from '../foundations/icons.svelte.js'

export type TreeIcon = Extract<
  IconName,
  | 'tag'
  | 'folder'
  | 'image'
  | 'server'
  | 'search'
  | 'createFolder'
  | 'uploadFile'
  | 'extension'
  | 'kebab'
  | 'palette'
  | 'check'
  | 'rename'
  | 'move'
  | 'trash'
  | 'eye'
  | 'eyeOff'
  | 'expandMore'
  | 'expandLess'
  | 'reset'
  | 'download'
  | 'fitScreen'
  | 'flag'
  | 'snowflake'
  | 'taskAlt'
  | 'tune'
>

export interface TreeColourProgressModel extends Progress {
  readonly index: number
  readonly name: string
  readonly hex: string
}

export interface TreeActionModel {
  readonly id: string
  readonly label: string
  readonly icon: TreeIcon
  /** Return from the popout before opening the canvas or native file picker. */
  readonly returnToCanvas?: boolean
}

/** Palette indices for a template preview, at whatever resolution the caller has. */
export interface TreePreviewArt {
  readonly width: number
  readonly height: number
  readonly indices: Uint8Array
}

export interface TreeRowModel {
  readonly favourites?: FavouritesModel
  readonly type: 'row'
  readonly key: string
  readonly name: string
  readonly icon: Extract<TreeIcon, 'folder' | 'image' | 'server'>
  readonly depth: number
  readonly branches?: readonly boolean[]
  readonly parentKey: string | null
  readonly container: boolean
  readonly expanded: boolean
  readonly forceExpanded?: boolean
  readonly visible: boolean
  readonly muted?: boolean
  readonly meta?: string
  readonly preview?: {
    /** The template's size, for the caption and aspect ratio. */
    readonly width: number
    readonly height: number
    /** Pixels to draw: the artwork or a smaller copy of it. */
    readonly art?: TreePreviewArt | undefined
    /** Fetch `art` when it is absent and the preview scrolls into view. */
    readonly loadArt?: (() => Promise<TreePreviewArt | undefined>) | undefined
    readonly ownership: string
  }
  /** Includes descendants hidden by collapsed folders or search. */
  readonly descendantAlarmKind?: AlarmKind | undefined
  readonly lifecycle?: {
    readonly finished: boolean
    readonly frozen: boolean
    readonly griefed: boolean
    readonly alarmKind?: AlarmKind | undefined
    readonly pixelsLost?: number | undefined
  }
  readonly progress?: Progress
  readonly colourProgress?: readonly TreeColourProgressModel[]
  readonly leadingActions?: readonly TreeActionModel[]
  readonly actions?: readonly TreeActionModel[]
  readonly renamable?: boolean
  readonly contextMenu?: boolean
  readonly draggable?: boolean
  readonly canReparent?: boolean
  readonly setSize: number
  readonly positionInSet: number
}

/** Who keeps a template among their favourites, and what the current painter may change. */
export interface FavouritesModel {
  /** False until an authoritative collection has arrived. */
  readonly known?: boolean
  readonly people: readonly import('@caelestis/shared').PainterIdentity[]
  readonly mine: boolean
  readonly canAssign: boolean
  readonly canClaim: boolean
}

export interface TreeNoticeModel {
  readonly type: 'notice'
  readonly key: string
  readonly depth: number
  readonly branches?: readonly boolean[]
  readonly text: string
  readonly action?: TreeActionModel
}

export interface TreeStandaloneActionModel {
  readonly type: 'action'
  readonly key: string
  readonly depth: number
  readonly action: TreeActionModel
  readonly variant: 'compact' | 'ghost'
  readonly showIcon?: boolean
  readonly title: string
}

export type TreeEntryModel = TreeRowModel | TreeNoticeModel | TreeStandaloneActionModel

export type TreeSortModel = import('@caelestis/shared').TemplateSortOrder

export interface TemplateTreeModel {
  readonly query: string
  readonly sort: TreeSortModel
  readonly displayMode?: 'tree' | 'grid'
  readonly filters?: import('@caelestis/shared').TemplateFilters
  readonly serverFiltersAvailable?: boolean
  readonly tagOptions?: readonly {
    readonly id: string
    readonly name: string
    readonly owner: string
  }[]
  readonly entries: readonly TreeEntryModel[]
  /** The template row at the centre of the active canvas. */
  readonly focusedKey?: string
  readonly renamingKey?: string
  readonly contextMenu?: TreeContextMenuModel
  readonly operation?: TreeOperationModel
}

export interface TreeContextMenuItemModel {
  readonly id: string
  readonly label: string
  readonly icon: TreeIcon
  /** Consecutive items sharing a group sit together; a hairline separates one group from the next. */
  readonly group?: string
  readonly danger?: boolean
  readonly returnToCanvas?: boolean
  /** Present on a `menuitemcheckbox` row, carrying the state the action toggles. */
  readonly checked?: boolean
  /** A submenu the row opens on hover, tap, Enter, or ArrowRight instead of running an action. */
  readonly children?: readonly TreeContextMenuItemModel[]
}

export interface TreeContextMenuModel {
  readonly id: string
  /** The row whose actions this menu presents. */
  readonly rowKey: string
  readonly x: number
  readonly y: number
  readonly items: readonly TreeContextMenuItemModel[]
}

export interface TreeOperationOptionModel {
  readonly value: string
  readonly label: string
}

export interface TreeOperationModel {
  readonly id: string
  readonly label: string
  readonly options?: readonly TreeOperationOptionModel[]
  readonly note?: string
  readonly confirmLabel?: string
  readonly pending?: boolean
  readonly cancellable?: boolean
}

export type TemplateTreeIntent =
  | {
      /** Add (`release: false`) or remove a favourite; `person` names someone other than the current painter. */
      readonly type: 'favourite'
      readonly key: string
      readonly release: boolean
      readonly person?: import('@caelestis/shared').PainterIdentity
    }
  | { readonly type: 'display-mode'; readonly mode: 'tree' | 'grid' }
  | { readonly type: 'search'; readonly query: string }
  | { readonly type: 'sort'; readonly sort: TreeSortModel }
  | { readonly type: 'filter'; readonly filters: import('@caelestis/shared').TemplateFilters }
  | { readonly type: 'toggle-expanded'; readonly key: string }
  | { readonly type: 'toggle-visible'; readonly key: string; readonly visible: boolean }
  | { readonly type: 'action'; readonly key: string; readonly actionId: string }
  | { readonly type: 'context-menu'; readonly key: string; readonly x: number; readonly y: number }
  | { readonly type: 'rename'; readonly key: string; readonly name: string }
  | { readonly type: 'cancel-rename'; readonly key: string }
  | { readonly type: 'drag-state'; readonly active: boolean }
  | { readonly type: 'context-menu-action'; readonly menuId: string; readonly actionId: string }
  | { readonly type: 'dismiss-context-menu'; readonly menuId: string }
  | {
      readonly type: 'tree-operation-confirm'
      readonly operationId: string
      readonly value: string
    }
  | { readonly type: 'tree-operation-cancel'; readonly operationId: string }
  | {
      readonly type: 'drop'
      readonly draggedKey: string
      readonly targetKey: string
      readonly position: 'before' | 'inside' | 'after'
    }
