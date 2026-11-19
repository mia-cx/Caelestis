import { type AlarmKind, WORLD_PIXELS } from '@caelestis/shared'
import { goToServerTemplate } from '../application/tree-navigation.js'
import {
  hasRefreshedServer,
  isServerRefreshing,
  refreshServerSnapshot,
  renderedParent,
  serverSnapshotError,
} from '../application/tree-server-state.js'
import { serverAlarmFor, serverAlarmKindFor } from '../server-alarms.js'
import type { ServerTemplate } from '../server-manifest.js'
import { manifestRows as rowsForSurface } from '../server-manifests.js'
import { serverProgressFor } from '../server-status.js'
import { isScopeVisible, type ServerConnection, setScopeVisible } from '../settings.js'
import { isTemplateVisible, setLocalVisible } from '../templates/local-store.js'
import { nodeChainVisible } from '../templates/server-nodes.js'
import {
  nodeScopeKey,
  nodeTreeKey,
  serverScopeKey,
  serverTemplateKey,
  serverTemplateTreeKey,
} from '../tree-keys.js'
import { sumProgress } from './progress.js'
import type { TreeContext, TreeTarget } from './tree-context.js'
import {
  completeColourProgress,
  serverTemplateColourProgress,
  serverTemplateProgress,
} from './tree-facts.js'
import {
  type CategoryRoot,
  categoryRoot,
  claimFacts,
  createActions,
  isTreeExpanded,
  previewArt,
  renameTarget,
  renderCategoryRows,
  tagAction,
} from './tree-rows.js'
import { groupedTreeSource, type TreeItem, type TreeSource } from './tree-source.js'

type ServerRows = NonNullable<ReturnType<typeof rowsForSurface>>

/** The server's rows on this surface; the claimed list keeps only its templates, flat. */
const scopedRows = (ctx: TreeContext, server: ServerConnection): ServerRows | undefined => {
  const rows = rowsForSurface(server, ctx.surface)
  const { templateKeys } = ctx
  if (rows === undefined || templateKeys === undefined) return rows
  return {
    nodes: [],
    templates: rows.templates.filter((template) =>
      templateKeys.has(serverTemplateTreeKey(server, template.id)),
    ),
  }
}

/**
 * The worst alarm under each folder, `null` for the server's top level. Walks the full hierarchy
 * before filtering or collapsing rows, including pending moves.
 */
const descendantAlarms = (
  server: ServerConnection,
  rows: ServerRows | undefined,
): Map<string | null, AlarmKind> => {
  const alarms = new Map<string | null, AlarmKind>()
  const parents = new Map(
    (rows?.nodes ?? []).map((node) => [
      node.id,
      renderedParent(nodeTreeKey(server, node.id), node.parentId),
    ]),
  )
  for (const template of rows?.templates ?? []) {
    const alarm = serverAlarmFor(server, template)
    if (alarm === null) continue
    let parentId = renderedParent(serverTemplateTreeKey(server, template.id), template.nodeId)
    while (alarms.get(parentId) !== 'sustained-griefing' && alarms.get(parentId) !== alarm.kind) {
      alarms.set(parentId, alarm.kind)
      if (parentId === null) break
      parentId = parents.get(parentId) ?? null
    }
  }
  return alarms
}

/** Trouble with the connection itself, said in words under its root. */
const connectionNotice = (ctx: TreeContext, server: ServerConnection): void => {
  if (server.status === 'unreachable') {
    ctx.output.notice(`Could not be reached. ${server.error ?? ''}`.trim(), 1)
  } else if (server.status === 'needs-token') {
    ctx.output.notice('Needs an access token — add it in settings.', 1)
  }
}

/**
 * A server's folders and the templates hanging off them.
 *
 * The three things that make this different from Local live here and nowhere else: renaming and
 * re-parenting go over HTTP and are refused without admin scope, a template row is drawn from the
 * manifest before its pixels have finished downloading, and the switch is this browser's own
 * record rather than anything the server said.
 */
const serverSource = (
  ctx: TreeContext,
  server: ServerConnection,
  rows: ServerRows,
  root: CategoryRoot,
  alarms: ReadonlyMap<string | null, AlarmKind>,
): TreeSource => {
  const { surface, rerender, callbacks, facts } = ctx
  const canRearrange = server.isAdmin
  const scopeKey = serverScopeKey(server.url)

  /**
   * A drop anywhere in this server's tree, resolved to a folder.
   *
   * One handler for folder rows and template rows alike: a top-level refusal is a rule about the
   * thing being *dragged*, which `dropOnServerNode` enforces from the dragged key.
   */
  const intoServer = (draggedKey: string, dropParent: string | null): Promise<string | null> => {
    const into =
      dropParent === null || dropParent === root.key
        ? null
        : rows.nodes.find((node) => nodeTreeKey(server, node.id) === dropParent)?.id
    if (into === undefined) return Promise.resolve(null)
    return callbacks.onDropInServer(server, into, draggedKey)
  }

  const entries: Array<{ parentId: string | null; item: TreeItem }> = []
  for (const node of rows.nodes) {
    const nodeKey = nodeTreeKey(server, node.id)
    const target: TreeTarget = { server, surface, nodeId: node.id, key: nodeKey, name: node.name }
    entries.push({
      parentId: renderedParent(nodeKey, node.parentId),
      item: {
        key: nodeKey,
        name: node.name,
        tagNames: node.tags?.map((tag) => tag.name) ?? [],
        filterFacts: {
          source: 'server',
          visible: isScopeVisible(scopeKey) && nodeChainVisible(server.url, node.id, surface),
          tags: node.tags?.map((tag) => tag.id) ?? [],
        },
        kind: 'folder',
        childrenOf: node.id,
        descendantAlarmKind: alarms.get(node.id),
        createdAt: node.createdAt,
        visible: isScopeVisible(nodeScopeKey(server.url, node.id)),
        setVisible: (on) => setScopeVisible(nodeScopeKey(server.url, node.id), on),
        canReparent: canRearrange,
        ...(canRearrange ? { onDropAt: intoServer } : {}),
        onContextMenu: (event: MouseEvent) => callbacks.onContextMenu(target, event),
        ...(canRearrange
          ? {
              onRename: (value: string) => void renameTarget(target, value, rerender, surface),
              actions: [tagAction(target, rerender), ...createActions(ctx, target)],
            }
          : {}),
      },
    })
  }
  for (const template of rows.templates) {
    const templateKey = serverTemplateTreeKey(server, template.id)
    const drawn = facts.drawnServerTemplate(server, template.id)
    const colourProgress = serverTemplateColourProgress(facts, surface, server, template)
    const progress = serverTemplateProgress(facts, surface, server, template)
    const visibilityKey = serverTemplateKey(server.url, template.id, surface)
    const alarm = serverAlarmFor(server, template)
    const alarmKind = surface.kind === 'world' ? serverAlarmKindFor(server, template) : undefined
    const target: TreeTarget = {
      server,
      surface,
      nodeId: template.nodeId,
      key: templateKey,
      name: template.name,
      templateId: template.id,
      templateVersion: template.version,
      templateUpdatedAt: template.updatedAt,
      // The claimed list is flat, so its rows have no folder to show them alone in.
      ...(ctx.templateKeys === undefined
        ? { showOnly: () => source.showOnly(templateKey, root.switch) }
        : {}),
    }
    entries.push({
      parentId:
        ctx.templateKeys === undefined ? renderedParent(templateKey, template.nodeId) : null,
      item: {
        key: templateKey,
        name: template.name,
        tagNames: template.tags?.map((tag) => tag.name) ?? [],
        actions: canRearrange ? [tagAction(target, rerender)] : undefined,
        kind: 'image',
        childrenOf: null,
        preview: {
          width:
            template.bbox.maxX > template.bbox.minX
              ? template.bbox.maxX - template.bbox.minX
              : WORLD_PIXELS - template.bbox.minX + template.bbox.maxX,
          height: template.bbox.maxY - template.bbox.minY,
          ...(drawn?.serverVersion === template.version ? previewArt(drawn) : {}),
          ownership: `Server · ${server.info?.name ?? server.url}`,
        },
        createdAt: template.updatedAt,
        updatedAt: template.updatedAt,
        totalPixels: template.totalPixels,
        mismatched:
          surface.kind === 'world'
            ? serverProgressFor(server, template)?.mismatched
            : drawn === undefined || progress.known === 0
              ? undefined
              : progress.mismatched,
        muted: !template.published,
        ...(template.published ? {} : { excludeFromRollup: true as const }),
        progress,
        progressReader: () => serverTemplateProgress(facts, surface, server, template),
        lifecycle: {
          finished: template.finished === true,
          frozen: template.timelapseFrozen === true,
          griefed: alarm?.kind === 'sustained-griefing',
          ...(alarm === null ? {} : { alarmKind: alarm.kind, pixelsLost: alarm.pixelsLost }),
        },
        filterFacts: {
          source: 'server',
          tags: template.tags?.map((tag) => tag.id) ?? [],
          claims: claimFacts(ctx, templateKey),
          visible:
            drawn === undefined
              ? isScopeVisible(scopeKey) &&
                isScopeVisible(visibilityKey) &&
                nodeChainVisible(server.url, template.nodeId, surface)
              : isTemplateVisible(drawn),
          lifecycle: {
            finished: template.finished === true,
            frozen: template.timelapseFrozen === true,
          },
          ...(alarmKind === undefined ? {} : { alarm: alarmKind }),
        },
        ...(colourProgress === undefined
          ? {}
          : {
              colourProgress: () =>
                serverTemplateColourProgress(facts, surface, server, template) ?? colourProgress,
            }),
        leadingActions: [
          {
            icon: 'search',
            label: 'Go to',
            returnToCanvas: true,
            run: () => goToServerTemplate(template.bbox, surface),
          },
        ],
        visible: drawn?.visible ?? isScopeVisible(visibilityKey),
        // A drawn server row owns the dual commit: live bitmaps and the durable scope either both
        // move or neither does. Before its pixels arrive there is only the scope.
        setVisible: async (on) =>
          drawn === undefined
            ? setScopeVisible(visibilityKey, on)
            : await setLocalVisible(drawn.id, on),
        canReparent: canRearrange,
        ...(canRearrange ? { onDropAt: intoServer } : {}),
        onContextMenu: (event: MouseEvent) => callbacks.onContextMenu(target, event),
        ...(canRearrange
          ? { onRename: (value: string) => void renameTarget(target, value, rerender, surface) }
          : {}),
      },
    })
  }
  const source = groupedTreeSource(entries)
  return source
}

/**
 * A server's root and everything under it, or why there is nothing. Returns whether filters
 * matched anything here.
 */
export const renderServerCategory = (ctx: TreeContext, server: ServerConnection): boolean => {
  const { output, surface, rerender, facts } = ctx
  const rows = scopedRows(ctx, server)
  // Published only, same as every folder rollup: an admin's unpublished drafts are listed and
  // metered individually, but never counted into the server's aggregate.
  const published = (rows?.templates ?? []).filter((template) => template.published)
  const alarms = descendantAlarms(server, rows)
  const progressOf = (template: ServerTemplate) =>
    serverTemplateProgress(facts, surface, server, template)
  const coloursOf = (template: ServerTemplate) =>
    serverTemplateColourProgress(facts, surface, server, template)
  const readProgress = () => sumProgress(published.map(progressOf))
  const root = categoryRoot(ctx, {
    server,
    descendantAlarmKind: alarms.get(null),
    readProgress,
    colourProgress:
      published.length === 0 || !published.every((template) => coloursOf(template) !== undefined)
        ? undefined
        : () =>
            completeColourProgress(
              readProgress(),
              published.flatMap((template) => {
                const colours = coloursOf(template)
                return colours === undefined ? [] : [colours]
              }),
            ),
  })
  if (!ctx.filtering) root.render()
  if (!ctx.includeCollapsed && !isTreeExpanded(root.key) && !ctx.reveal) return false

  if (rows === undefined) {
    if (ctx.filtering) root.render()
    if (server.status !== 'connected') {
      // No badge for a healthy server: if it is in the list at all, it is connected. Only
      // trouble needs saying, and it says it in words where there is room for them.
      connectionNotice(ctx, server)
      return false
    }
    // Exactly one automatic attempt per verified connection. A failed request records an error
    // and waits for the explicit Retry button instead of scheduling itself forever.
    if (!hasRefreshedServer(server) && surface.kind === 'world') {
      void refreshServerSnapshot(server, rerender)
    }
    if (isServerRefreshing(server)) {
      output.notice(surface.kind === 'world' ? 'Loading folders…' : 'Loading templates…', 1)
    } else if (surface.kind === 'world') {
      output.notice(serverSnapshotError(server) ?? 'Could not load this server.', 1, [], {
        label: 'Retry',
        run: () => void refreshServerSnapshot(server, rerender, true),
      })
    }
    return false
  }

  const matched = renderCategoryRows(ctx, root, serverSource(ctx, server, rows, root, alarms))
  if (matched === null) return false
  if (ctx.needle !== '' && !matched) output.notice('No matches.', 1)
  else if (rows.nodes.length === 0 && rows.templates.length === 0)
    output.notice('No templates published yet.', 1)
  const refreshError = serverSnapshotError(server)
  if (server.status === 'connected' && refreshError !== undefined) {
    output.notice(refreshError, 1, [], {
      label: 'Retry',
      run: () => void refreshServerSnapshot(server, rerender, true),
    })
  }
  connectionNotice(ctx, server)
  return true
}
