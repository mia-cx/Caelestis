import type { TemplateSurface } from '@caelestis/shared'
import type { PanelModel, TemplateTreeIntent } from '@caelestis/ui/elements'
import { copyToServer } from '../application/tree-copy.js'
import {
  copyServerTemplateToLocal,
  dropOnServerNode,
  moveBranch,
} from '../application/tree-drop.js'
import { createFolder } from '../application/tree-folders.js'
import { captureTemplate, importTemplate } from '../application/tree-import.js'
import { openContextMenu } from '../application/tree-menu.js'
import {
  handleTreeActionPresentationIntent,
  treeActionPresentation,
} from '../application/tree-presentation.js'
import { getState, setState } from '../settings.js'
import { focusedTemplate } from '../templates/nearest.js'
import { parseTreeKey } from '../tree-keys.js'
import { setTemplateDisplayMode } from './display-mode.js'
import { showToast } from './notification-host.js'
import { presenceSummaryModel } from './presence-actions.js'
import { templateTreeAdapter } from './tree.js'
import { type TemplateTreeAdapter, type TreeCallbacks, templateTreeKeyFor } from './tree-context.js'
import { changeTemplateClaim, withTemplateClaims, workSectionModel } from './work.js'

/**
 * The panel's tree view: the main tree, the claimed list beside it, and what they are showing —
 * the search, whether others' claims are listed, and each list's last build.
 */

/** What the tree view asks of the panel it lives in. */
export interface TreeViewHost {
  readonly surface: () => TemplateSurface
  /**
   * Whichever tree is currently on screen.
   *
   * Every row callback would otherwise close over the build that created it, and `setState`
   * notifies synchronously — so an action that writes state before it redraws has had the whole
   * view replaced underneath it. Routing through this makes a stale closure redraw the live tree.
   */
  readonly rerender: () => void
  /** Rebuild the main tree only, for inputs the claimed list ignores, such as the search. */
  readonly render: () => void
  readonly addServer: () => void
}

let host: TreeViewHost | null = null
let searchQuery = ''
let showOtherClaims = false
let active: {
  readonly adapter: TemplateTreeAdapter
  /** The claims the main tree was built with, reused by every panel model until the next build. */
  readonly claims: ReturnType<typeof workSectionModel>
} | null = null
let claimed: { readonly adapter: TemplateTreeAdapter; readonly keys: readonly string[] } | null =
  null
/**
 * Whether the claimed list's inputs may have changed since it was built: templates, servers,
 * claims, state. The search and folder expansion never set it, since the flat list ignores both,
 * and progress ticks update both trees in place.
 */
let claimedStale = true

export const installTreeView = (owner: TreeViewHost): void => {
  host = owner
}

/** Row actions, run against the panel's canvas at the time they run. */
const callbacks = ({ surface, rerender, addServer }: TreeViewHost): TreeCallbacks => ({
  onAddServer: addServer,
  onCreateFolder: (target) => void createFolder(target, rerender, surface()),
  onImportTemplate: (target) => void importTemplate(target, rerender, surface()),
  onCaptureTemplate: (target) => captureTemplate(target, rerender),
  onContextMenu: (target, event) => openContextMenu(target, event, rerender, surface()),
  onCopyToServer: (id) => void copyToServer(id, rerender),
  onDropInServer: (server, nodeId, draggedKey) =>
    dropOnServerNode(server, nodeId, draggedKey, rerender, surface()),
  onDropInLocal: async (draggedKey, folderId) => {
    switch (parseTreeKey(draggedKey)?.kind) {
      case 'server-node':
        return await moveBranch(draggedKey, { kind: 'local', folderId }, rerender, surface())
      case 'server-template':
        return await copyServerTemplateToLocal(draggedKey, folderId, rerender, surface())
      default:
        return null
    }
  },
})

/** Build the main tree with one pass over the claims, which every panel model then reuses. */
export const buildTreeView = (): void => {
  if (host === null) return
  const claims = workSectionModel(host.surface(), host.rerender)
  active = {
    claims,
    adapter: templateTreeAdapter(callbacks(host), host.rerender, {
      surface: host.surface(),
      query: searchQuery,
      claims: claims.templates,
    }),
  }
}

/** Drop both builds, for a view that is not the tree. */
export const clearTreeView = (): void => {
  active = null
  claimed = null
}

export const hasTreeView = (): boolean => active !== null

/** Rebuild the claimed list on its next model, whatever it was built from. */
export const markClaimedTreeStale = (): void => {
  claimedStale = true
}

export const focusedTreeKey = (): string | undefined =>
  templateTreeKeyFor(focusedTemplate(), getState().servers)

const focusedTreeModel = (): { readonly focusedKey?: string } => {
  const focusedKey = focusedTreeKey()
  return focusedKey === undefined ? {} : { focusedKey }
}

/** The Painters drawer's model, which only the world canvas has. */
export const presenceField = (): Pick<NonNullable<PanelModel['work']>, 'presence'> => {
  if (host?.surface().kind !== 'world') return {}
  const presence = presenceSummaryModel()
  return presence === undefined ? {} : { presence }
}

/** Both trees' part of the panel model, rebuilding the claimed list only when its rows moved. */
export const treeViewModel = (): Pick<PanelModel, 'tree' | 'work' | 'showOtherClaims'> => {
  if (active === null || host === null) return {}
  const { adapter, claims } = active
  const keys = [...claims.templates]
    .filter(
      ([, claim]) => claim.mine || (showOtherClaims && claim.canAssign && claim.people.length > 0),
    )
    .map(([key]) => key)
  if (
    claimed === null ||
    claimedStale ||
    keys.length !== claimed.keys.length ||
    keys.some((key, index) => key !== claimed?.keys[index])
  ) {
    claimed = {
      keys,
      adapter: templateTreeAdapter(callbacks(host), host.rerender, {
        surface: host.surface(),
        includeCollapsed: true,
        templateKeys: new Set(keys),
        claims: claims.templates,
      }),
    }
    claimedStale = false
  }
  return {
    showOtherClaims,
    tree: {
      ...withTemplateClaims(adapter.model, claims),
      ...focusedTreeModel(),
      ...treeActionPresentation(),
    },
    work: {
      tree: {
        ...withTemplateClaims(claimed.adapter.model, claims, showOtherClaims),
        ...focusedTreeModel(),
      },
      canShowOthers: claims.canShowOthers,
      error: claims.error,
      ...presenceField(),
    },
  }
}

/** Re-read row progress into both trees in place; whether either changed. */
export const refreshTreeViewProgress = (): boolean => {
  const tree = active?.adapter.refreshProgress() ?? false
  const claimedChanged = claimed?.adapter.refreshProgress() ?? false
  return tree || claimedChanged
}

/** Whether the main tree lists this row after search, filters, and collapse. */
export const treeViewPresents = (key: string): boolean =>
  active?.adapter.model.entries.some((entry) => entry.type === 'row' && entry.key === key) ?? false

export const setShowOtherClaims = (show: boolean): void => {
  showOtherClaims = show
  host?.rerender()
}

/** The main tree's toolbar: search, sort, view and filters. False for any other intent. */
const applyToolbarIntent = (intent: TemplateTreeIntent, view: TreeViewHost): boolean => {
  switch (intent.type) {
    case 'search':
      searchQuery = intent.query
      view.render()
      return true
    case 'sort':
      setState({ sort: intent.sort })
      view.rerender()
      return true
    case 'display-mode':
      if (!setTemplateDisplayMode(intent.mode))
        showToast('Could not save the template view.', 'error')
      view.rerender()
      return true
    case 'filter':
      setState({ filters: intent.filters })
      view.rerender()
      return true
    default:
      return false
  }
}

/** One tree intent, from the main tree or the claimed list; only the main tree has a toolbar. */
export const handleTreeIntent = (intent: TemplateTreeIntent, from: 'tree' | 'claimed'): void => {
  if (host === null) return
  if (intent.type === 'template-claim') {
    changeTemplateClaim(intent.key, host.surface(), host.rerender, intent.release, intent.person)
    return
  }
  if (handleTreeActionPresentationIntent(intent)) return
  if (from === 'tree') {
    if (!applyToolbarIntent(intent, host)) active?.adapter.handle(intent)
  } else claimed?.adapter.handle(intent)
}
