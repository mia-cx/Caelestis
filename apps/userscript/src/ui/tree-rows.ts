import type { AlarmKind, TemplateSurface } from '@caelestis/shared'
import { refreshAllianceManifest } from '../alliance-server-sync.js'
import { refreshServerSnapshot } from '../application/tree-server-state.js'
import { renameLocalFolder } from '../local-folders.js'
import {
  patchTemplate,
  renameNode as renameNodeOnServer,
  renameServer as renameServerOnServer,
} from '../server-api.js'
import { serverByUrl } from '../server-connections.js'
import { getState, isScopeVisible, type ServerConnection, setScopeVisible } from '../settings.js'
import type { PlacedTemplate } from '../templates/catalog.js'
import type { TemplateColourProgress, TemplateProgress } from '../templates/progress-types.js'
import { renameLocalTemplate } from '../templates/template-edits.js'
import { loadTemplateThumbnail, templateThumbnail } from '../templates/thumbnail.js'
import { LOCAL_ROOT_KEY, parseTreeKey, serverScopeKey } from '../tree-keys.js'
import { showToast } from './notification-host.js'
import type { TreeContext, TreeRowOptions, TreeTarget } from './tree-context.js'
import { orderedTreeItems } from './tree-order.js'
import {
  type RowAction,
  type TreeItem,
  type TreeSource,
  treeMatcher,
  type VisibilitySwitch,
} from './tree-source.js'

/** The row helpers the Local, server and Wplace builders share, and the recursive level renderer. */

export const isTreeExpanded = (key: string): boolean => !getState().collapsed.includes(key)

export const reportTreeError = (message: string): void => showToast(message, 'error')

/** A row's preview art: the cached thumbnail, or a loader for one scrolled into view. */
export const previewArt = (template: PlacedTemplate) => ({
  art: templateThumbnail(template),
  loadArt: () => loadTemplateThumbnail(template),
})

/** The claim facts a row filters on, once the claims are known. */
export const claimFacts = (ctx: TreeContext, key: string) => {
  const claim = ctx.claims?.get(key)
  return claim === undefined || claim.known === false
    ? undefined
    : { mine: claim.mine, claimed: claim.people.length > 0 }
}

/** Capture selects with the claim editor, which only works over the world canvas. */
const captureActions = (ctx: TreeContext, target: TreeTarget): RowAction[] =>
  ctx.surface.kind === 'world'
    ? [
        {
          icon: 'fitScreen',
          label: 'Capture from canvas',
          returnToCanvas: true,
          run: () => ctx.callbacks.onCaptureTemplate(target),
        },
      ]
    : []

/** A folder's or category's create actions: new folder, import, and capture. */
export const createActions = (ctx: TreeContext, target: TreeTarget): RowAction[] => [
  { icon: 'createFolder', label: 'New folder', run: () => ctx.callbacks.onCreateFolder(target) },
  {
    icon: 'uploadFile',
    label: 'Import template',
    returnToCanvas: true,
    run: () => ctx.callbacks.onImportTemplate(target),
  },
  ...captureActions(ctx, target),
]

export const openTagManager = (target: TreeTarget, rerender: () => void): void => {
  void import('./tags.js')
    .then((editor) => editor.openTagManager(target, rerender))
    .catch((error) => reportTreeError(`Could not open tags: ${String(error)}`))
}

export const tagAction = (target: TreeTarget, rerender: () => void): RowAction => ({
  icon: 'tag',
  label: 'Edit tags',
  run: () => openTagManager(target, rerender),
})

const refreshCurrentSnapshot = async (
  server: ServerConnection,
  rerender: () => void,
  surface: TemplateSurface,
): Promise<void> => {
  if (surface.kind !== 'world') {
    await refreshAllianceManifest(server, surface)
    rerender()
    return
  }
  let current = serverByUrl(server.url)
  if (current === undefined) return
  let result = await refreshServerSnapshot(current, rerender, true)
  while (result.status === 'superseded') {
    current = serverByUrl(server.url)
    if (current === undefined) return
    result = await refreshServerSnapshot(current, rerender)
  }
}

/** Rename whatever the row is: a Local template or folder, a server, folder or template. */
export const renameTarget = async (
  target: TreeTarget,
  name: string,
  rerender: () => void,
  surface: TemplateSurface,
): Promise<void> => {
  const key = parseTreeKey(target.key)
  if (key?.kind === 'local-template') {
    if (!(await renameLocalTemplate(key.id, name))) {
      reportTreeError('Could not save that name. The old one is still there.')
    }
    rerender()
    return
  }
  if (target.server === null && key?.kind === 'local-folder') {
    if (!renameLocalFolder(key.id, name)) {
      reportTreeError('Could not save that folder name. Use between 1 and 256 characters.')
    }
    rerender()
    return
  }
  if (target.server !== null && target.templateId !== undefined) {
    const result = await patchTemplate(target.server, target.templateId, { name })
    if (!result.ok) reportTreeError(result.message)
    await refreshCurrentSnapshot(target.server, rerender, surface)
    return
  }
  if (target.server !== null && target.nodeId === null) {
    const result = await renameServerOnServer(target.server, name)
    if (!result.ok) reportTreeError(result.message)
    rerender()
    return
  }
  if (target.server === null || target.nodeId === null) {
    showToast('There is nothing to rename here.', 'warning')
    rerender()
    return
  }
  const result = await renameNodeOnServer(target.server, target.nodeId, name)
  if (!result.ok) reportTreeError(result.message)
  await refreshCurrentSnapshot(target.server, rerender, surface)
}

/**
 * One level of a tree, and every level below it.
 *
 * Ordered and interleaved: folders and templates go into one list and come out in whatever order
 * the user dragged them into. Not folders-first — sorting by kind means a template can never be put
 * above a folder, and a rule that quietly overrides a custom order makes the drag look broken
 * rather than constrained.
 */
export const renderLevel = (
  ctx: TreeContext,
  source: TreeSource,
  parentId: string | null,
  depth: number,
  parentKey: string,
  ancestorBranches: readonly boolean[],
  matches: (item: TreeItem) => boolean,
): void => {
  const { output, rank, budget, siblingLevels, rerender, reveal } = ctx
  const allSiblings = source.children(parentId)
  const matching = allSiblings.filter(matches)
  const items = orderedTreeItems(matching, rank, budget.remaining)
  if (items.length < matching.length) budget.truncated = true
  const keys = items.map((item) => item.key)
  siblingLevels.set(parentKey, {
    visible: keys,
    all: () => orderedTreeItems(allSiblings, rank).map((sibling) => sibling.key),
  })

  for (const [index, item] of items.entries()) {
    if (budget.remaining <= 0) {
      budget.truncated = true
      break
    }
    const key = item.key
    const branches = [...ancestorBranches, index < items.length - 1]
    output.row({
      key,
      name: item.name,
      kind: item.kind,
      depth,
      branches,
      container: item.childrenOf !== null,
      siblings: keys,
      orderingSiblings: () => orderedTreeItems(allSiblings, rank).map((sibling) => sibling.key),
      destinationSiblings: (destinationParentKey) =>
        destinationParentKey === null ? undefined : siblingLevels.get(destinationParentKey),
      parentKey,
      canReparent: item.canReparent,
      forceExpanded: reveal,
      rerender,
      onError: reportTreeError,
      checked: item.visible,
      onToggleChecked: (on) => {
        void Promise.resolve(item.setVisible(on)).then(
          (changed) => {
            if (!changed) reportTreeError(`Could not change visibility for “${item.name}”.`)
            rerender()
          },
          (error: unknown) => {
            reportTreeError(`Could not change visibility for “${item.name}”. ${String(error)}`)
            rerender()
          },
        )
      },
      ...(item.meta === undefined ? {} : { meta: item.meta }),
      ...(item.preview === undefined ? {} : { preview: item.preview }),
      descendantAlarmKind: item.descendantAlarmKind,
      ...(item.lifecycle === undefined ? {} : { lifecycle: item.lifecycle }),
      ...(item.progress === undefined ? {} : { progress: item.progress }),
      ...(item.progressReader === undefined ? {} : { progressReader: item.progressReader }),
      ...(item.colourProgress === undefined ? {} : { colourProgress: item.colourProgress }),
      ...(item.leadingActions === undefined ? {} : { leadingActions: item.leadingActions }),
      ...(item.muted === undefined ? {} : { muted: item.muted }),
      ...(item.actions === undefined ? {} : { actions: item.actions }),
      ...(item.onRename === undefined ? {} : { onRename: item.onRename }),
      ...(item.onContextMenu === undefined ? {} : { onContextMenu: item.onContextMenu }),
      ...(item.onDropAt === undefined ? {} : { onDropAt: item.onDropAt }),
    })
    budget.remaining--
    if (item.childrenOf === null) continue
    if (!ctx.includeCollapsed && !reveal && !isTreeExpanded(key)) {
      const childSiblings = source.children(item.childrenOf)
      const visibleChildren = orderedTreeItems(childSiblings.filter(matches), rank).map(
        (child) => child.key,
      )
      siblingLevels.set(key, {
        visible: visibleChildren,
        all: () => orderedTreeItems(childSiblings, rank).map((child) => child.key),
      })
      continue
    }
    renderLevel(ctx, source, item.childrenOf, depth + 1, key, branches, matches)
  }

  // Only inside something. "Nothing here" is worth saying about a folder you have just opened; at
  // the top of a source it is the source's own empty state, which says more than this can.
  if (parentId !== null && matching.length === 0) {
    output.notice('Empty.', depth, [...ancestorBranches, false])
  }
}

/** A category's root row, rendered when it has something to show. */
export interface CategoryRoot {
  readonly key: string
  /** The category's own switch, which `showOnly` turns on along the way. */
  readonly switch: VisibilitySwitch
  readonly render: () => void
}

const openServerDetails = (server: ServerConnection, rerender: () => void): void => {
  void import('./server-details.js')
    .then((editor) => editor.openServerDetails(server, rerender))
    .catch((error: unknown) => reportTreeError(String(error)))
}

interface CategoryRootOptions {
  /** Absent for Local. */
  readonly server?: ServerConnection | undefined
  readonly descendantAlarmKind?: AlarmKind | undefined
  readonly readProgress: () => TemplateProgress | undefined
  readonly colourProgress?: (() => readonly TemplateColourProgress[] | undefined) | undefined
}

/** Local's or a server's root row: its switch, rollup progress, and what can be done there. */
export const categoryRoot = (
  ctx: TreeContext,
  { server, descendantAlarmKind, readProgress, colourProgress }: CategoryRootOptions,
): CategoryRoot => {
  const isLocal = server === undefined
  const key = isLocal ? LOCAL_ROOT_KEY : serverScopeKey(server.url)
  const target: TreeTarget = {
    server: server ?? null,
    surface: ctx.surface,
    nodeId: null,
    key,
    name: isLocal ? 'Local' : (server.info?.name ?? server.url),
  }
  // Only where the code can actually act. Offering create to someone who will only ever get a
  // 403 is worse than not offering it — Local always can, since nothing gates it.
  const canCreate = isLocal || server.isAdmin
  const progress = readProgress()
  const servers = ctx.categories.filter((category) => category !== LOCAL_ROOT_KEY)
  const row: TreeRowOptions = {
    key,
    name: target.name,
    // A rack and a folder are different things and read differently at a glance.
    kind: isLocal ? 'folder' : 'server',
    descendantAlarmKind,
    depth: 0,
    container: true,
    forceExpanded: ctx.reveal,
    siblings: isLocal ? [] : servers,
    orderingSiblings: () => servers,
    destinationSiblings: (destinationParentKey) =>
      destinationParentKey === null ? undefined : ctx.siblingLevels.get(destinationParentKey),
    parentKey: null,
    ...(progress === undefined
      ? {}
      : { progress, progressReader: () => readProgress() ?? progress }),
    ...(colourProgress === undefined ? {} : { colourProgress }),
    rerender: ctx.rerender,
    onError: reportTreeError,
    /**
     * Categories reorder among themselves, and only among themselves.
     *
     * Without a position handler a category could only be dropped *onto* another row, so the
     * gap above the first row — the only way to reach first place — would silently do nothing.
     * `canReparent` stays off for Local, so nothing can be filed *inside* it by dragging.
     */
    onDropAt: async (draggedKey, parentKey) => {
      // Another category, reordering among its own kind.
      if (parentKey === null && ctx.categories.includes(draggedKey)) return null
      // Landing just under a server's own row means its top level, which is otherwise
      // unreachable: every other destination is a folder, and "no folder" has no other row.
      if (parentKey === key && server !== undefined && canCreate) {
        return await ctx.callbacks.onDropInServer(server, null, draggedKey)
      }
      return null
    },
    canReparent: canCreate && !isLocal,
    // A category is a group like a folder is: switching it off takes everything under it off
    // the canvas, and leaves every row inside saying exactly what it said before.
    checked: isScopeVisible(key),
    onToggleChecked: (on) => {
      if (!setScopeVisible(key, on)) {
        reportTreeError(`Could not change visibility for “${target.name}”.`)
      }
      ctx.rerender()
    },
    onContextMenu:
      canCreate || server !== undefined
        ? (event) => ctx.callbacks.onContextMenu(target, event)
        : undefined,
    onRename: canCreate
      ? (value) => void renameTarget(target, value, ctx.rerender, ctx.surface)
      : undefined,
    actions: canCreate
      ? [
          // Beside rename, because rename is the one server-level edit that already exists and
          // this is where the rest of the public presentation lives.
          ...(server === undefined
            ? []
            : [
                {
                  icon: 'tune' as const,
                  label: 'Edit server details',
                  run: () => openServerDetails(server, ctx.rerender),
                },
              ]),
          {
            icon: 'tag',
            label: 'Manage tags',
            run: () => openTagManager(target, ctx.rerender),
          },
          ...createActions(ctx, target),
        ]
      : undefined,
  }
  return {
    key,
    switch: { visible: isScopeVisible(key), setVisible: (on) => setScopeVisible(key, on) },
    render: () => ctx.output.row(row),
  }
}

/**
 * List a category's rows under its root; with filters on, the root shows only beside a match.
 * Returns whether any row matched, or null when filters hide the whole category, so the caller
 * adds nothing more under it.
 */
export const renderCategoryRows = (
  ctx: TreeContext,
  root: CategoryRoot,
  source: TreeSource,
): boolean | null => {
  const matches = treeMatcher(source, ctx.needle, ctx.filters)
  const hasMatches = source.children(null).some(matches)
  if (ctx.filtering && !hasMatches) return null
  if (ctx.filtering) root.render()
  renderLevel(ctx, source, null, 1, root.key, [], matches)
  return hasMatches
}
