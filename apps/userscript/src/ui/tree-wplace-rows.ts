import { goToLocalTemplate } from '../application/tree-navigation.js'
import { isScopeVisible, setScopeVisible } from '../settings.js'
import { isTemplateVisible } from '../templates/catalog.js'
import { copyWplaceTemplate, NATIVE_ALLIANCE_TREE_KEY } from '../templates/native-alliance.js'
import { centreOf, navigateTo } from '../templates/navigate.js'
import {
  OFFICIAL_EVENTS_TREE_KEY,
  officialEvent,
  officialProgress,
} from '../templates/official-overlays.js'
import type { TemplateProgress } from '../templates/progress-types.js'
import { nodeChainVisible } from '../templates/server-nodes.js'
import { setLocalVisible } from '../templates/template-edits.js'
import { NATIVE_ALLIANCE_OWNER, OFFICIAL_OVERLAY_OWNER } from '../templates/wplace-owned.js'
import { eventTemplateKey, nativeTemplateKey, nodeScopeKey, serverScopeKey } from '../tree-keys.js'
import type { TreeContext } from './tree-context.js'
import { isTreeExpanded, previewArt, renderLevel, reportTreeError } from './tree-rows.js'
import {
  groupedTreeSource,
  type RowAction,
  type TreeItem,
  type TreeSource,
  treeMatcher,
} from './tree-source.js'

/**
 * A root whose contents Wplace owns: no rename, reorder, import, or folder creation. Rendered
 * only when something in it matches; returns whether it did.
 */
const renderReadOnlyRoot = (
  ctx: TreeContext,
  key: string,
  name: string,
  scope: string,
  source: TreeSource,
): boolean => {
  const matches = treeMatcher(source, ctx.needle, ctx.filters)
  if (!source.children(null).some(matches)) return false
  ctx.output.row({
    key,
    name,
    kind: 'server',
    depth: 0,
    container: true,
    forceExpanded: ctx.reveal,
    siblings: [],
    parentKey: null,
    canReparent: false,
    rerender: ctx.rerender,
    onError: reportTreeError,
    checked: isScopeVisible(scope),
    onToggleChecked: (on) => {
      setScopeVisible(scope, on)
      ctx.rerender()
    },
  })
  if (ctx.includeCollapsed || ctx.reveal || isTreeExpanded(key))
    renderLevel(ctx, source, null, 1, key, [], matches)
  return true
}

const copyAction = (ctx: TreeContext, id: string): RowAction => ({
  icon: 'download',
  label: 'Copy to Local',
  run: () => {
    void copyWplaceTemplate(id).then(ctx.rerender, (error) => reportTreeError(String(error)))
  },
})

/** Wplace's own event overlays, listed read-only under Events on the world canvas. */
export const renderEventRows = (ctx: TreeContext): boolean => {
  const events = ctx.surface.kind === 'world' ? officialEvent() : null
  if (events === null || events.fragments.length === 0) return false
  const { facts } = ctx
  // Event groups and fragments share the `event:` row namespace.
  const folder = (id: string, name: string, parentId: string | null) => {
    const scope = nodeScopeKey(OFFICIAL_OVERLAY_OWNER, id)
    return {
      parentId,
      item: {
        key: eventTemplateKey(id),
        name,
        kind: 'folder',
        childrenOf: id,
        filterFacts: {
          source: 'server',
          visible: nodeChainVisible(OFFICIAL_OVERLAY_OWNER, id),
          tags: [],
        },
        visible: isScopeVisible(scope),
        setVisible: (on: boolean) => setScopeVisible(scope, on),
        canReparent: false,
      } satisfies TreeItem,
    }
  }
  const opened = new Set(events.fragments.map((fragment) => fragment.group.id))
  const source = groupedTreeSource([
    folder(events.id, events.name, null),
    ...events.groups
      .filter((group) => opened.has(group.id))
      .map((group) => folder(group.id, group.name, events.id)),
    ...events.fragments.map((fragment) => {
      // Pixels exist only while Wplace draws the fragment nearby; the row exists regardless.
      const mirror = facts.drawn.find((template) => template.id === fragment.templateId)
      const visible = mirror?.visible ?? isScopeVisible(fragment.templateId)
      const readProgress = (): TemplateProgress | undefined =>
        officialProgress(fragment) ?? (mirror === undefined ? undefined : facts.progress(mirror))
      const progress = readProgress()
      return {
        parentId: fragment.group.id,
        item: {
          key: eventTemplateKey(fragment.templateId),
          name: fragment.shortName,
          kind: 'image',
          childrenOf: null,
          meta: `${fragment.width}×${fragment.height}`,
          ...(mirror === undefined
            ? {}
            : {
                preview: {
                  width: mirror.width,
                  height: mirror.height,
                  ...previewArt(mirror),
                  ownership: 'Wplace',
                },
                colourProgress: () => facts.colourProgress(mirror),
              }),
          filterFacts: {
            source: 'server',
            visible:
              visible &&
              isScopeVisible(serverScopeKey(OFFICIAL_OVERLAY_OWNER)) &&
              nodeChainVisible(OFFICIAL_OVERLAY_OWNER, fragment.group.id),
            tags: [],
          },
          ...(progress === undefined
            ? {}
            : {
                totalPixels: progress.total,
                progress,
                progressReader: () => readProgress() ?? progress,
              }),
          visible,
          setVisible: (on: boolean) =>
            mirror === undefined
              ? setScopeVisible(fragment.templateId, on)
              : setLocalVisible(mirror.id, on),
          canReparent: false,
          leadingActions: [
            {
              icon: 'search',
              label: 'Go to',
              returnToCanvas: true,
              run: () =>
                navigateTo(centreOf({ ...fragment, originX: fragment.x, originY: fragment.y })),
            },
          ],
          ...(mirror === undefined ? {} : { actions: [copyAction(ctx, mirror.id)] }),
        } satisfies TreeItem,
      }
    }),
  ])
  return renderReadOnlyRoot(
    ctx,
    OFFICIAL_EVENTS_TREE_KEY,
    'Events',
    serverScopeKey(OFFICIAL_OVERLAY_OWNER),
    source,
  )
}

/** The alliance's own Wplace templates on this canvas, listed read-only under Wplace. */
export const renderNativeRows = (ctx: TreeContext): boolean => {
  const { facts } = ctx
  const native = facts.drawn.filter((template) => template.serverUrl === NATIVE_ALLIANCE_OWNER)
  if (native.length === 0) return false
  const source = groupedTreeSource(
    native.map((template) => ({
      parentId: null,
      item: {
        key: nativeTemplateKey(template.id),
        name: template.name,
        kind: 'image',
        childrenOf: null,
        meta: `${template.width}×${template.height}`,
        preview: {
          width: template.width,
          height: template.height,
          ...previewArt(template),
          ownership: 'Wplace',
        },
        filterFacts: { source: 'server', visible: isTemplateVisible(template), tags: [] },
        totalPixels: template.opaque,
        progress: facts.progress(template),
        progressReader: () => facts.progress(template),
        colourProgress: () => facts.colourProgress(template),
        visible: template.visible,
        setVisible: (on: boolean) => setLocalVisible(template.id, on),
        canReparent: false,
        leadingActions: [
          {
            icon: 'search',
            label: 'Go to',
            returnToCanvas: true,
            run: () => goToLocalTemplate(template.id),
          },
        ],
        actions: [copyAction(ctx, template.id)],
      } satisfies TreeItem,
    })),
  )
  return renderReadOnlyRoot(
    ctx,
    NATIVE_ALLIANCE_TREE_KEY,
    'Wplace',
    serverScopeKey(NATIVE_ALLIANCE_OWNER),
    source,
  )
}
