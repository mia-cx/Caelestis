import { defaultTemplateSort, templateFilterCount, WPLACE_PALETTE } from '@caelestis/shared'
import type {
  TemplateTreeModel,
  TreeActionModel,
  TreeColourProgressModel,
  TreeEntryModel,
  TreeProgressModel,
  TreeRowModel,
} from '@caelestis/ui/elements'
import { isSameServerPlacement } from '../application/tree-server-state.js'
import { measureProfileDetail } from '../profile.js'
import { manifestRows as rowsForSurface } from '../server-manifests.js'
import { getState, setState } from '../settings.js'
import { localTagCatalog } from '../templates/tags.js'
import { LOCAL_ROOT_KEY, serverScopeKey } from '../tree-keys.js'
import { templateDisplayMode } from './display-mode.js'
import type {
  SiblingLevel,
  TemplateTreeAdapter,
  TreeCallbacks,
  TreeContext,
  TreeOptions,
  TreeOutput,
  TreeRowOptions,
} from './tree-context.js'
import { treeFacts } from './tree-facts.js'
import { renderLocalCategory } from './tree-local-rows.js'
import { MAX_RENDERED_ROWS, orderedTreeItems, placeTreeKey } from './tree-order.js'
import { isTreeExpanded } from './tree-rows.js'
import { renderServerCategory } from './tree-server-rows.js'
import type { RowAction } from './tree-source.js'
import { currentRenamingKey, finishRenaming, setTreeDragActive } from './tree-view-state.js'
import { renderEventRows, renderNativeRows } from './tree-wplace-rows.js'

/** One build's context: what was asked for, read once, with the facts every row builder shares. */
const treeContext = (
  output: TreeOutput,
  callbacks: TreeCallbacks,
  rerender: () => void,
  { surface, query = '', includeCollapsed = false, templateKeys, claims }: TreeOptions,
): TreeContext => {
  const facts = treeFacts(surface, templateKeys)
  const { customOrder, filters } = getState()
  const rank = new Map(customOrder.map((key, index) => [key, index]))
  const servers = facts.servers.map((server) => ({
    key: serverScopeKey(server.url),
    name: server.info?.name ?? server.url,
  }))
  const needle = query.trim().toLocaleLowerCase()
  const filtering = templateFilterCount(filters) > 0
  return {
    output,
    callbacks,
    rerender,
    surface,
    needle,
    filters,
    filtering,
    reveal: needle !== '' || filtering,
    includeCollapsed,
    templateKeys,
    claims,
    categories: [
      LOCAL_ROOT_KEY,
      ...orderedTreeItems(servers, rank, undefined, defaultTemplateSort('custom')).map(
        (item) => item.key,
      ),
    ],
    rank,
    budget: { remaining: MAX_RENDERED_ROWS, truncated: false },
    siblingLevels: new Map<string, SiblingLevel>(),
    facts,
  }
}

/**
 * The tree: one root per source, plus `Local`.
 *
 * Row anatomy, left to right: **optional caret, kind icon, persistent navigation, name, meta, row
 * actions, checkbox**. Expandable rows earn the caret's space; leaves rely on their depth indent
 * rather than carrying an empty control slot. The checkbox trails because it is what you act on
 * once you have found the row. Secondary actions sit just inside it and appear on hover, while
 * navigation stays visible at the row's leading edge.
 *
 * The whole row is the expand target — a caret is a 24px hit area on a 300px row, and everything
 * between them is dead space otherwise.
 */
const buildTree = (ctx: TreeContext): void => {
  const { output, filters, facts } = ctx
  let matched = false
  for (const key of ctx.categories) {
    const isLocal = key === LOCAL_ROOT_KEY
    const server = facts.servers.find((candidate) => serverScopeKey(candidate.url) === key)
    if (!isLocal && server === undefined) continue
    if (filters.source.length > 0 && !filters.source.includes(isLocal ? 'local' : 'server'))
      continue
    const listed =
      server === undefined ? renderLocalCategory(ctx) : renderServerCategory(ctx, server)
    matched = listed || matched
  }
  matched = renderEventRows(ctx) || matched
  matched = renderNativeRows(ctx) || matched

  if (ctx.filtering && !matched) output.notice('No templates match your search and filters.', 0)
  if (ctx.budget.truncated) {
    output.notice(
      `Showing the first ${MAX_RENDERED_ROWS.toLocaleString()} rows. Refine the search to see others.`,
      1,
    )
  }
  if (ctx.surface.kind === 'world') {
    const label = facts.servers.length === 0 ? 'Add a server' : 'Add another server'
    output.action('add-server', 0, label, label, ctx.callbacks.onAddServer)
  }
}

const sameCounts = (a: TreeProgressModel | undefined, b: TreeProgressModel | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.completed === b.completed &&
    a.mismatched === b.mismatched &&
    a.unpainted === b.unpainted &&
    a.known === b.known &&
    a.total === b.total)

const sameColourCounts = (
  a: readonly TreeColourProgressModel[] | undefined,
  b: readonly TreeColourProgressModel[] | undefined,
): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((colour, index) => colour.index === b[index]?.index && sameCounts(colour, b[index])))

/** A row's progress fields, read now from its live progress sources. */
const rowProgress = (
  options: TreeRowOptions,
): Pick<TreeRowModel, 'progress' | 'colourProgress'> => {
  const progress = options.progressReader?.() ?? options.progress
  const colours = options.colourProgress?.()
  return {
    ...(progress === undefined ? {} : { progress }),
    ...(colours === undefined
      ? {}
      : {
          colourProgress: colours.flatMap((colour) => {
            const palette = WPLACE_PALETTE[colour.index]
            return palette === undefined
              ? []
              : [{ ...colour, name: palette.name, hex: palette.hex }]
          }),
        }),
  }
}

const treeIcon = (name: TreeRowOptions['kind']): TreeRowModel['icon'] =>
  name === 'folder' || name === 'server' ? name : 'image'

const canReorderRow = (row: TreeRowOptions): boolean =>
  row.key !== 'local' && (row.kind === 'server' || getState().sort.field === 'custom')

const actionIcon = (name: string): TreeActionModel['icon'] => {
  switch (name) {
    case 'tag':
    case 'search':
    case 'createFolder':
    case 'uploadFile':
    case 'extension':
    case 'palette':
    case 'download':
    case 'tune':
      return name
    default:
      return 'kebab'
  }
}

/** Translate the userscript's domain tree into the one model consumed by both Svelte hosts. */
export const templateTreeAdapter = (
  callbacks: TreeCallbacks,
  rerender: () => void,
  options: TreeOptions,
): TemplateTreeAdapter => {
  const { surface, query = '', includeCollapsed = false, templateKeys } = options
  const entries: TreeEntryModel[] = []
  const rows = new Map<string, TreeRowOptions>()
  const actions = new Map<string, () => void>()
  let generatedKey = 0
  const actionModels = (
    key: string,
    group: 'leading' | 'row',
    source: readonly RowAction[],
  ): readonly TreeActionModel[] =>
    source.map((action, index) => {
      const id = `${group}-${index}`
      actions.set(`${key}:${id}`, action.run)
      return {
        id,
        label: action.label,
        icon: actionIcon(action.icon),
        ...(action.returnToCanvas === undefined ? {} : { returnToCanvas: action.returnToCanvas }),
      }
    })

  const output: TreeOutput = {
    row: (options) => {
      rows.set(options.key, options)
      entries.push({
        type: 'row',
        key: options.key,
        name: options.name,
        icon: treeIcon(options.kind),
        depth: options.depth,
        branches: options.branches ?? [],
        parentKey: options.parentKey ?? null,
        container: options.container,
        expanded: options.forceExpanded === true || isTreeExpanded(options.key),
        visible: options.checked ?? true,
        setSize: 0,
        positionInSet: 0,
        ...(options.forceExpanded === true ? { forceExpanded: true } : {}),
        ...(options.muted === true ? { muted: true } : {}),
        ...(options.meta === undefined ? {} : { meta: options.meta }),
        ...(options.preview === undefined ? {} : { preview: options.preview }),
        descendantAlarmKind: options.descendantAlarmKind,
        ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
        ...rowProgress(options),
        ...(options.leadingActions === undefined
          ? {}
          : { leadingActions: actionModels(options.key, 'leading', options.leadingActions) }),
        ...(options.actions === undefined
          ? {}
          : { actions: actionModels(options.key, 'row', options.actions) }),
        ...(options.onRename === undefined ? {} : { renamable: true }),
        ...(options.onContextMenu === undefined ? {} : { contextMenu: true }),
        ...(canReorderRow(options) ? { draggable: true } : {}),
        ...(options.canReparent === true ? { canReparent: true } : {}),
      })
    },
    notice: (text, depth, branches = [], action) => {
      const key = `notice-${generatedKey++}`
      let actionModel: TreeActionModel | undefined
      if (action !== undefined) {
        actionModel = { id: 'run', label: action.label, icon: 'kebab' }
        actions.set(`${key}:run`, action.run)
      }
      entries.push({
        type: 'notice',
        key,
        depth,
        branches,
        text,
        ...(actionModel === undefined ? {} : { action: actionModel }),
      })
    },
    action: (key, depth, label, title, run) => {
      const action = {
        id: 'run',
        label,
        icon: key === 'add-server' ? 'extension' : 'uploadFile',
        returnToCanvas: key === 'local-import',
      } as const
      actions.set(`${key}:run`, run)
      entries.push({
        type: 'action',
        key,
        depth,
        action,
        variant: key === 'add-server' ? 'ghost' : 'compact',
        ...(key === 'add-server' ? { showIcon: true } : {}),
        title,
      })
    },
  }

  measureProfileDetail(
    templateKeys === undefined ? 'Template tree build' : 'Claimed tree build',
    () => buildTree(treeContext(output, callbacks, rerender, options)),
  )

  const tagOptions = new Map(
    localTagCatalog().map((tag) => [tag.id, { id: tag.id, name: tag.name, owner: 'Local' }]),
  )
  for (const server of getState().servers) {
    const source = rowsForSurface(server, surface)
    for (const row of [...(source?.nodes ?? []), ...(source?.templates ?? [])])
      for (const tag of row.tags ?? [])
        tagOptions.set(tag.id, { ...tag, owner: server.info?.name ?? server.url })
  }

  const siblingRows = new Map<string, TreeRowModel[]>()
  for (const entry of entries) {
    if (entry.type !== 'row') continue
    const key = entry.parentKey ?? '__root__'
    const siblings = siblingRows.get(key) ?? []
    siblings.push(entry)
    siblingRows.set(key, siblings)
  }
  for (const siblings of siblingRows.values()) {
    siblings.forEach((entry, index) => {
      const at = entries.indexOf(entry)
      entries[at] = { ...entry, setSize: siblings.length, positionInSet: index + 1 }
    })
  }
  const renderedRename = currentRenamingKey()
  if (!includeCollapsed && renderedRename !== null && !rows.has(renderedRename)) finishRenaming()

  const renamingKey = currentRenamingKey()
  let model: TemplateTreeModel = {
    query,
    sort: getState().sort,
    displayMode: templateDisplayMode(),
    filters: getState().filters,
    tagOptions: [...tagOptions.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.owner.localeCompare(b.owner),
    ),
    serverFiltersAvailable: getState().servers.some(
      (server) => (rowsForSurface(server, surface)?.templates.length ?? 0) > 0,
    ),
    entries,
    ...(renamingKey === null ? {} : { renamingKey }),
  }

  const destinationFor = (
    target: TreeRowOptions,
    position: 'before' | 'inside' | 'after',
  ): { parentKey: string | null; beforeKey: string | null; level: SiblingLevel } | null => {
    if (position === 'inside') {
      if (!target.container) return null
      const level = target.destinationSiblings?.(target.key)
      if (level === undefined) return null
      return { parentKey: target.key, beforeKey: level.visible[0] ?? null, level }
    }
    const parentKey = target.parentKey ?? null
    const visible = target.siblings
    const index = visible.indexOf(target.key)
    if (index === -1) return null
    return {
      parentKey,
      beforeKey: position === 'before' ? target.key : (visible[index + 1] ?? null),
      level: { visible, all: target.orderingSiblings ?? (() => visible) },
    }
  }

  const applyDrop = (
    dragged: TreeRowOptions,
    target: TreeRowOptions,
    position: 'before' | 'inside' | 'after',
  ): void => {
    if (!canReorderRow(dragged)) return
    const destination = destinationFor(target, position)
    if (destination === null || dragged.key === destination.beforeKey) return
    const sourceParent = dragged.parentKey ?? null
    if (sourceParent === null && destination.parentKey !== null) return
    const reparenting = sourceParent !== destination.parentKey
    if (reparenting && (dragged.canReparent !== true || target.canReparent !== true)) return
    const place = target.onDropAt
    if (reparenting && place === undefined) return

    const previousOrder = getState().customOrder
    let optimisticOrder: readonly string[] | null = null
    const result = placeTreeKey(
      destination.level.visible,
      destination.level.all(),
      dragged.key,
      destination.beforeKey,
      reparenting && isSameServerPlacement(dragged.key, destination.parentKey, surface),
    )
    if (result === 'too-many') {
      target.onError(
        reparenting
          ? 'The row was moved, but this level has too many rows to save a custom order safely.'
          : 'This level has too many rows to save a custom order safely.',
      )
    } else if (reparenting && isSameServerPlacement(dragged.key, destination.parentKey, surface)) {
      optimisticOrder = getState().customOrder
    }
    if (!reparenting) {
      if (place !== undefined) void place(dragged.key, destination.parentKey, destination.beforeKey)
      rerender()
      return
    }

    const rollBackOrder = (): void => {
      if (
        optimisticOrder !== null &&
        getState().customOrder.length === optimisticOrder.length &&
        getState().customOrder.every((key, index) => key === optimisticOrder?.[index])
      ) {
        setState({ customOrder: previousOrder })
      }
    }
    void place?.(dragged.key, destination.parentKey, destination.beforeKey).then(
      (destinationKey) => {
        if (destinationKey === null) {
          rollBackOrder()
          rerender()
          return
        }
        if (optimisticOrder === null || destinationKey !== dragged.key) {
          const placed = placeTreeKey(
            destination.level.visible,
            destination.level.all(),
            destinationKey,
            destination.beforeKey,
            true,
          )
          if (placed === 'too-many') {
            target.onError(
              'The row was moved, but this level has too many rows to save a custom order safely.',
            )
          }
        }
        rerender()
      },
      (error: unknown) => {
        rollBackOrder()
        target.onError(`Could not move that row. ${String(error)}`)
        rerender()
      },
    )
  }

  return {
    get model() {
      return model
    },
    refreshProgress: () => {
      let changed = false
      const next = model.entries.map((entry) => {
        const options = entry.type === 'row' ? rows.get(entry.key) : undefined
        if (entry.type !== 'row' || options === undefined) return entry
        const fresh = rowProgress(options)
        if (
          sameCounts(entry.progress, fresh.progress) &&
          sameColourCounts(entry.colourProgress, fresh.colourProgress)
        )
          return entry
        changed = true
        const { progress: _progress, colourProgress: _colours, ...rest } = entry
        return { ...rest, ...fresh }
      })
      if (changed) model = { ...model, entries: next }
      return changed
    },
    handle: (intent) => {
      if (intent.type === 'drag-state') {
        setTreeDragActive(intent.active)
        return
      }
      if (intent.type === 'action') {
        actions.get(`${intent.key}:${intent.actionId}`)?.()
        return
      }
      const row = 'key' in intent ? rows.get(intent.key) : undefined
      switch (intent.type) {
        case 'toggle-expanded': {
          const collapsed = new Set(getState().collapsed)
          if (collapsed.has(intent.key)) collapsed.delete(intent.key)
          else collapsed.add(intent.key)
          // State listeners redraw the tree; a second redraw here would rebuild it twice.
          setState({ collapsed: [...collapsed] })
          break
        }
        case 'toggle-visible':
          if (row?.onToggleChecked !== undefined) row.onToggleChecked(intent.visible)
          break
        case 'context-menu':
          row?.onContextMenu?.(
            new MouseEvent('contextmenu', { clientX: intent.x, clientY: intent.y }),
          )
          break
        case 'rename':
          finishRenaming()
          row?.onRename?.(intent.name)
          break
        case 'cancel-rename':
          finishRenaming()
          rerender()
          break
        case 'drop': {
          const dragged = rows.get(intent.draggedKey)
          const target = rows.get(intent.targetKey)
          if (dragged !== undefined && target !== undefined) {
            applyDrop(dragged, target, intent.position)
          }
          break
        }
        case 'search':
        case 'sort':
        case 'filter':
          break
      }
    },
  }
}
