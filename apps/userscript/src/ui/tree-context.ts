import type { TemplateFilters, TemplateSurface } from '@caelestis/shared'
import type {
  FavouritesModel,
  TemplateTreeIntent,
  TemplateTreeModel,
  TreeIcon,
  TreeRowModel,
} from '@caelestis/ui/elements'
import type { ServerConnection } from '../settings.js'
import type { LocalTemplate, PlacedTemplate, ServerCopy } from '../templates/catalog.js'
import type { TemplateColourProgress, TemplateProgress } from '../templates/progress-types.js'
import {
  eventTemplateKey,
  localTemplateKey,
  nativeTemplateKey,
  serverTemplateTreeKey,
} from '../tree-keys.js'
import type { DropAt, RowAction } from './tree-source.js'

/** The tree's vocabulary: what a row targets, what a build is asked for, and its context. */

export interface TreeTarget {
  readonly server: ServerConnection | null
  /** Canvas whose manifest or local catalog produced this row. */
  readonly surface: TemplateSurface
  readonly nodeId: string | null
  readonly key: string
  readonly name: string
  /**
   * Set when the row is a template published on a server, rather than a folder.
   *
   * The two need telling apart because every action means something different on each: renaming a
   * folder rewrites the paths of everything beneath it, renaming a template is one column.
   */
  readonly templateId?: string
  /** Revision shown when this destructive action became available. */
  readonly templateVersion?: string
  readonly templateUpdatedAt?: number
  /** Present on a template row listed in its folder: make it the only one that folder draws. */
  readonly showOnly?: () => Promise<boolean>
}

export interface TreeCallbacks {
  readonly onAddServer: () => void
  readonly onCreateFolder: (target: TreeTarget) => void
  readonly onImportTemplate: (target: TreeTarget) => void
  /** Select committed art on the map and add it as a template here, or download it. */
  readonly onCaptureTemplate: (target: TreeTarget) => void
  readonly onContextMenu: (target: TreeTarget, event: MouseEvent) => void
  readonly onCopyToServer: (templateId: string) => void
  /** Move one server-owned row into a Local folder. Local reparenting stays inside the tree. */
  readonly onDropInLocal: (draggedKey: string, folderId: string | null) => Promise<string | null>
  /**
   * Something was dropped into a server's folder; the tree orders it among its siblings itself.
   *
   * One callback for every journey, because they are one gesture. What happens comes from the
   * dragged key rather than from the caller: a Local template lands as an upload, a template
   * already here is refiled, one from elsewhere crosses over, a folder is re-parented. `null` for
   * the folder means the server's top level, which only a folder may occupy.
   */
  readonly onDropInServer: (
    server: ServerConnection,
    nodeId: string | null,
    draggedKey: string,
  ) => Promise<string | null>
}

export interface TemplateTreeAdapter {
  readonly model: TemplateTreeModel
  readonly handle: (intent: TemplateTreeIntent) => void
  /**
   * Re-read every row's pixel progress into `model` without rebuilding the tree's structure.
   * Rows whose counts are unchanged keep their entry. Returns whether anything changed.
   */
  readonly refreshProgress: () => boolean
}

export interface SiblingLevel {
  readonly visible: readonly string[]
  readonly all: () => readonly string[]
}

export interface TreeRowOptions {
  readonly key: string
  readonly name: string
  readonly kind: Extract<TreeIcon, 'folder' | 'image' | 'server'>
  readonly depth: number
  readonly branches?: readonly boolean[] | undefined
  readonly meta?: string | undefined
  readonly preview?: TreeRowModel['preview']
  readonly descendantAlarmKind?: TreeRowModel['descendantAlarmKind']
  readonly lifecycle?: TreeRowModel['lifecycle']
  readonly progress?: TemplateProgress | undefined
  readonly progressReader?: (() => TemplateProgress) | undefined
  readonly colourProgress?: (() => readonly TemplateColourProgress[] | undefined) | undefined
  readonly leadingActions?: readonly RowAction[] | undefined
  readonly container: boolean
  readonly parentKey?: string | null | undefined
  readonly canReparent?: boolean | undefined
  readonly forceExpanded?: boolean | undefined
  readonly muted?: boolean | undefined
  readonly actions?: readonly RowAction[] | undefined
  readonly onRename?: ((name: string) => void) | undefined
  readonly onContextMenu?: ((event: MouseEvent) => void) | undefined
  readonly siblings: readonly string[]
  readonly orderingSiblings?: (() => readonly string[]) | undefined
  readonly destinationSiblings?:
    | ((parentKey: string | null) => SiblingLevel | undefined)
    | undefined
  readonly rerender: () => void
  readonly onError: (message: string) => void
  readonly onDropAt?: DropAt | undefined
  readonly checked?: boolean | undefined
  readonly onToggleChecked?: ((on: boolean) => void) | undefined
}

/** Where a build writes its rows, in display order. */
export interface TreeOutput {
  readonly row: (options: TreeRowOptions) => void
  readonly notice: (
    text: string,
    depth: number,
    branches?: readonly boolean[],
    action?: { readonly label: string; readonly run: () => void },
  ) => void
  readonly action: (
    key: string,
    depth: number,
    label: string,
    title: string,
    run: () => void,
  ) => void
}

/** What a caller asks one tree build for. */
export interface TreeOptions {
  readonly surface: TemplateSurface
  readonly query?: string
  /** Build every row, expanded or not: the claimed list is flat and ignores expansion. */
  readonly includeCollapsed?: boolean
  /** List only these template rows, flat: the claimed list. */
  readonly templateKeys?: ReadonlySet<string> | undefined
  readonly claims?: ReadonlyMap<string, FavouritesModel> | undefined
}

/** Progress of drawn and server templates, read once per build. */
export interface TreeFacts {
  readonly servers: readonly ServerConnection[]
  /** Templates drawn on this build's surface and listed in it. */
  readonly drawn: readonly PlacedTemplate[]
  /** Drawn templates no server publishes. */
  readonly localOnly: readonly LocalTemplate[]
  readonly drawnServerTemplate: (server: ServerConnection, id: string) => ServerCopy | undefined
  readonly progress: (template: PlacedTemplate) => TemplateProgress
  readonly colourProgress: (template: PlacedTemplate) => readonly TemplateColourProgress[]
}

/** One build: what it was asked for, its shared output, and the facts read for it. */
export interface TreeContext {
  readonly output: TreeOutput
  readonly callbacks: TreeCallbacks
  readonly rerender: () => void
  readonly surface: TemplateSurface
  readonly needle: string
  readonly filters: TemplateFilters
  readonly filtering: boolean
  /** Search or filters show every match, whatever is collapsed. */
  readonly reveal: boolean
  readonly includeCollapsed: boolean
  readonly templateKeys: ReadonlySet<string> | undefined
  readonly claims: ReadonlyMap<string, FavouritesModel> | undefined
  /** Category keys in display order, Local first. */
  readonly categories: readonly string[]
  readonly rank: ReadonlyMap<string, number>
  readonly budget: { remaining: number; truncated: boolean }
  readonly siblingLevels: Map<string, SiblingLevel>
  readonly facts: TreeFacts
}

/** Resolve a drawn template to the stable key used by its main-menu row. */
export const templateTreeKeyFor = (
  template: PlacedTemplate | null,
  servers: readonly ServerConnection[],
): string | undefined => {
  if (template === null) return undefined
  switch (template.origin) {
    case 'local':
      return localTemplateKey(template.id)
    case 'wplace':
      return template.owner === 'event'
        ? eventTemplateKey(template.id)
        : nativeTemplateKey(template.id)
    case 'server': {
      const { url } = template.server
      const server = servers.find((candidate) => candidate.url === url)
      return server === undefined
        ? undefined
        : serverTemplateTreeKey(server, template.serverTemplateId)
    }
  }
}
