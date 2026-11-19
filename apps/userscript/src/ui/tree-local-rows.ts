import { sameTemplateSurface, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { goToLocalTemplate } from '../application/tree-navigation.js'
import {
  localFolderChainVisible,
  moveLocalFolder,
  setLocalFolderVisible,
} from '../local-folders.js'
import { getState } from '../settings.js'
import { isTemplateVisible } from '../templates/catalog.js'
import { localFolderTags, localTemplateTags } from '../templates/tags.js'
import { setLocalVisible, setTemplateFolder } from '../templates/template-edits.js'
import { LOCAL_ROOT_KEY, localFolderKey, localTemplateKey, parseTreeKey } from '../tree-keys.js'
import { sumProgress } from './progress.js'
import type { TreeContext, TreeTarget } from './tree-context.js'
import { completeColourProgress } from './tree-facts.js'
import {
  categoryRoot,
  claimFacts,
  createActions,
  isTreeExpanded,
  previewArt,
  renameTarget,
  renderCategoryRows,
  reportTreeError,
  tagAction,
} from './tree-rows.js'
import { type DropAt, groupedTreeSource, type TreeItem } from './tree-source.js'

/** File a dragged row into a Local folder, or Local's top level for a `null` parent. */
const dropInLocal =
  (ctx: TreeContext): DropAt =>
  async (draggedKey, parentKey) => {
    const parent = parentKey === null ? null : parseTreeKey(parentKey)
    const folderId = parent?.kind === 'local-folder' ? parent.id : null
    const dragged = parseTreeKey(draggedKey)
    switch (dragged?.kind) {
      case 'server-node':
      case 'server-template':
        return await ctx.callbacks.onDropInLocal(draggedKey, folderId)
      case 'local-template':
        if (!(await setTemplateFolder(dragged.id, folderId))) {
          reportTreeError('Could not move that template into the folder.')
          ctx.rerender()
          return null
        }
        ctx.rerender()
        return draggedKey
      case 'local-folder':
        if (!moveLocalFolder(dragged.id, folderId)) {
          reportTreeError('Could not save that folder move.')
          return null
        }
        return draggedKey
      default:
        return null
    }
  }

/**
 * Local's root and its folders and templates. Local means "only in this browser": server
 * templates share the store, but they are listed under the server publishing them, not here.
 * Returns whether filters matched anything here.
 */
export const renderLocalCategory = (ctx: TreeContext): boolean => {
  const { surface, rerender, callbacks, facts } = ctx
  const mine = facts.localOnly
  const readProgress = () => sumProgress(mine.map(facts.progress))
  const root = categoryRoot(ctx, {
    readProgress,
    colourProgress:
      mine.length === 0
        ? undefined
        : () => completeColourProgress(readProgress(), mine.map(facts.colourProgress)),
  })
  if (!ctx.filtering) root.render()
  if (!ctx.includeCollapsed && !isTreeExpanded(root.key) && !ctx.reveal) return false

  const onDropAt = dropInLocal(ctx)
  const entries: Array<{ parentId: string | null; item: TreeItem }> = []
  const folders =
    ctx.templateKeys === undefined
      ? getState().localFolders.filter((folder) =>
          sameTemplateSurface(folder.surface ?? WORLD_TEMPLATE_SURFACE, surface),
        )
      : []
  for (const folder of folders) {
    const key = localFolderKey(folder.id)
    const target: TreeTarget = { server: null, surface, nodeId: null, key, name: folder.name }
    entries.push({
      parentId: folder.parentId,
      item: {
        key,
        name: folder.name,
        tagNames: localFolderTags(folder.id).map((tag) => tag.name),
        filterFacts: {
          source: 'local',
          visible: localFolderChainVisible(folder.id),
          tags: localFolderTags(folder.id).map((tag) => tag.id),
        },
        kind: 'folder',
        childrenOf: folder.id,
        ...(folder.createdAt === undefined ? {} : { createdAt: folder.createdAt }),
        visible: folder.visible,
        setVisible: (on) => setLocalFolderVisible(folder.id, on),
        canReparent: true,
        onDropAt,
        onContextMenu: (event) => callbacks.onContextMenu(target, event),
        onRename: (value) => void renameTarget(target, value, rerender, surface),
        actions: [tagAction(target, rerender), ...createActions(ctx, target)],
      },
    })
  }
  for (const template of mine) {
    const key = localTemplateKey(template.id)
    const target: TreeTarget = {
      server: null,
      surface,
      nodeId: null,
      key,
      name: template.name,
      ...(ctx.templateKeys === undefined
        ? { showOnly: () => source.showOnly(key, root.switch) }
        : {}),
    }
    entries.push({
      parentId: ctx.templateKeys === undefined ? (template.folderId ?? null) : null,
      item: {
        key,
        name: template.name,
        tagNames: localTemplateTags(template.id).map((tag) => tag.name),
        kind: 'image',
        childrenOf: null,
        meta: `${template.width}×${template.height}`,
        preview: {
          width: template.width,
          height: template.height,
          ...previewArt(template),
          ownership: 'Local',
        },
        filterFacts: {
          source: 'local',
          visible: isTemplateVisible(template),
          tags: localTemplateTags(template.id).map((tag) => tag.id),
          claims: claimFacts(ctx, key),
        },
        updatedAt: template.updatedAt,
        totalPixels: template.opaque,
        mismatched: facts.progress(template).mismatched,
        progress: facts.progress(template),
        progressReader: () => facts.progress(template),
        colourProgress: () => facts.colourProgress(template),
        visible: template.visible,
        setVisible: (on) => setLocalVisible(template.id, on),
        canReparent: true,
        onDropAt,
        onContextMenu: (event: MouseEvent) => callbacks.onContextMenu(target, event),
        onRename: (value: string) => void renameTarget(target, value, rerender, surface),
        leadingActions: [
          {
            icon: 'search',
            label: 'Go to',
            returnToCanvas: true,
            run: () => goToLocalTemplate(template.id),
          },
        ],
        actions: [
          tagAction(target, rerender),
          {
            icon: 'uploadFile',
            label: 'Copy to a server',
            run: () => callbacks.onCopyToServer(template.id),
          },
        ],
      },
    })
  }
  const source = groupedTreeSource(entries)
  const matched = renderCategoryRows(ctx, root, source)
  if (matched === null) return false
  if (ctx.needle !== '' && !matched) ctx.output.notice('No matches.', 1)
  else if (mine.length === 0) ctx.output.notice('No local templates yet.', 1)
  // The hover action exists too, but an empty state is where someone is actually looking for the
  // way in, so it gets a visible button.
  ctx.output.action(
    'local-import',
    1,
    'Import a template',
    surface.kind === 'world' ? 'A .wplace file, a Blue Marble export, or an image' : 'An image',
    () =>
      callbacks.onImportTemplate({
        server: null,
        nodeId: null,
        key: LOCAL_ROOT_KEY,
        name: 'Local',
      }),
  )
  return true
}
