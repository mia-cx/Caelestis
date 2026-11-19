import { type TemplateSurface, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { localFolderChainVisible } from '../local-folders.js'
import { getState, isScopeVisible } from '../settings.js'
import { isTemplateVisible, type PlacedTemplate } from '../templates/catalog.js'
import { nodeChainVisible, serverNodeParents } from '../templates/server-nodes.js'
import { LOCAL_ROOT_KEY, localFolderIdOf, serverScopeKey, serverTemplateKey } from '../tree-keys.js'
import type { TreeTarget } from '../ui/tree-context.js'

export const surfaceOf = (target: TreeTarget): TemplateSurface =>
  target.surface ?? WORLD_TEMPLATE_SURFACE

/**
 * Whether a row is drawn, and whether the row holding it is, read from its switches alone.
 *
 * For folders, and for server templates whose pixels have not downloaded: their rows and switches
 * exist before any render copy does.
 */
const rowVisibility = (target: TreeTarget): readonly [drawn: boolean, parentDrawn: boolean] => {
  if (target.server === null) {
    const id = localFolderIdOf(target.key)
    const folder = getState().localFolders.find((candidate) => candidate.id === id)
    if (folder === undefined) return [isScopeVisible(LOCAL_ROOT_KEY), true]
    return [localFolderChainVisible(folder.id), localFolderChainVisible(folder.parentId)]
  }
  const { url } = target.server
  const surface = surfaceOf(target)
  const serverShown = isScopeVisible(serverScopeKey(url))
  if (target.templateId !== undefined) {
    const parentDrawn = serverShown && nodeChainVisible(url, target.nodeId, surface)
    const own = isScopeVisible(serverTemplateKey(url, target.templateId, surface))
    return [parentDrawn && own, parentDrawn]
  }
  if (target.nodeId === null) return [serverShown, true]
  const parent = serverNodeParents(url, surface).find(([id]) => id === target.nodeId)?.[1] ?? null
  return [
    serverShown && nodeChainVisible(url, target.nodeId, surface),
    serverShown && nodeChainVisible(url, parent, surface),
  ]
}

/**
 * The warning for a row the map does not draw, or null when it does.
 *
 * Moving, re-capturing, or adding templates under a hidden row changes art nobody can see: a
 * placement with no outline and no Apply or Cancel looked like Move did nothing, then blocked every
 * other Move. These refuse instead, and say which switch to turn on.
 */
export const hiddenNotice = (target: TreeTarget, template?: PlacedTemplate): string | null => {
  const [drawn, parentDrawn] =
    template === undefined
      ? rowVisibility(target)
      : [isTemplateVisible(template), isTemplateVisible({ ...template, visible: true })]
  if (drawn) return null
  return parentDrawn
    ? `“${target.name}” is hidden. Show it first.`
    : `“${target.name}” is in a hidden folder. Show the folder first.`
}
