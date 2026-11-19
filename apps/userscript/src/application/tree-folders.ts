import {
  nodeSlug,
  sameTemplateSurface,
  type TemplateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { createLocalFolder } from '../local-folders.js'
import { createNode, listServerNodes } from '../server-api.js'
import { isCurrentServerConnection } from '../server-connections.js'
import { getState, type LocalFolder, MAX_LOCAL_FOLDERS, setState } from '../settings.js'
import { LOCAL_ROOT_KEY, localFolderIdOf, localFolderKey, nodeTreeKey } from '../tree-keys.js'
import { toast } from '../ui/toast.js'
import type { TreeTarget } from '../ui/tree.js'
import { startRenaming } from '../ui/tree-state.js'
import { refreshEditedSurface, serverNodesFailure } from './tree-server.js'

/**
 * A name nobody has to type: "New folder", then "New folder 2", and so on.
 *
 * `key` is how the caller's world decides two names are the same one. Local folders compare
 * lowercased display names; a server compares the path segment it derives, so `New-folder` and
 * `New folder` collide there and do not here.
 */
const freeFolderName = (
  taken: ReadonlySet<string>,
  key: (name: string) => string = (name) => name.toLowerCase(),
): string => {
  const base = 'New folder'
  if (!taken.has(key(base))) return base
  for (let n = 2; n < 500; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(key(candidate))) return candidate
  }
  return `${base} ${Date.now()}`
}

/**
 * The lowercased names a new Local folder must not repeat: its siblings on the same surface.
 *
 * Only siblings, to match the server: Local allows the same name under different parents, so a
 * "New folder" at the top used to push a fresh child of an unrelated folder to "New folder 2".
 */
const takenLocalFolderNames = (
  folders: readonly LocalFolder[],
  parentId: string | null,
  surface: TemplateSurface,
): Set<string> =>
  new Set(
    folders
      .filter(
        (folder) =>
          folder.parentId === parentId &&
          sameTemplateSurface(folder.surface ?? WORLD_TEMPLATE_SURFACE, surface),
      )
      .map((folder) => folder.name.toLowerCase()),
  )

const isLocalTarget = (target: TreeTarget): boolean =>
  target.server === null && (target.key === LOCAL_ROOT_KEY || localFolderIdOf(target.key) !== null)

/**
 * Make sure the row about to be created will be on screen.
 *
 * Creating inside a collapsed folder put the new child straight into rename mode, the tree never
 * rendered it, and the rename state was cleared by the next draw. The user saw nothing happen and
 * found a default-named folder later.
 */
const expandForNewChild = (key: string): void => {
  const collapsed = getState().collapsed
  if (!collapsed.includes(key)) return
  setState({ collapsed: collapsed.filter((one) => one !== key) })
}

export const createFolder = async (
  target: TreeTarget,
  rerender: () => void,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<void> => {
  const { server, nodeId } = target
  if (isLocalTarget(target)) {
    // Nested under whichever Local folder was clicked, or at the top when it was Local itself.
    const parentId = localFolderIdOf(target.key)
    expandForNewChild(target.key)
    const taken = takenLocalFolderNames(getState().localFolders, parentId, surface)
    const folder = createLocalFolder(parentId, freeFolderName(taken), surface)
    if (folder === null) {
      toast(
        `Could not save that folder. Local supports up to ${MAX_LOCAL_FOLDERS.toLocaleString()}.`,
        'error',
      )
      return
    }
    startRenaming(localFolderKey(folder.id))
    rerender()
    return
  }
  if (server === null) {
    toast('Nothing to create a folder in here.', 'warning')
    return
  }
  // No dialog: pick a free name, create it, and drop straight into renaming it. Asking for a name
  // before the thing exists is a question with no context; renaming one that is on screen is not.
  const listed = await listServerNodes(server, undefined, surface)
  if (listed.status !== 'ok') {
    toast(serverNodesFailure(listed), 'error')
    return
  }
  // Asking took a round trip, and the panel was usable throughout it. Writing to a server the user
  // has since disconnected creates a folder in a place they can no longer see.
  if (!isCurrentServerConnection(server)) return
  // Compared as the server will store them, and only against siblings. Matching display names
  // treated `New-folder` and `New folder` as different while the backend slugs both to
  // `new-folder`, so the chosen name came back as a path conflict instead of becoming "New folder 2".
  const siblings = listed.nodes.filter((node) => node.parentId === nodeId)
  const name = freeFolderName(new Set(siblings.map((node) => nodeSlug(node.name))), nodeSlug)
  expandForNewChild(target.key)
  const result = await createNode(server, name, nodeId, undefined, surface)
  if (!result.ok) {
    toast(result.message, 'error')
    await refreshEditedSurface(server, surface, rerender)
    return
  }
  // Refresh before rendering: the row we are about to put into rename mode does not exist in the
  // cached node list yet, so re-rendering first would draw a tree without it and drop the rename.
  startRenaming(nodeTreeKey(server, result.node.id))
  await refreshEditedSurface(server, surface, rerender)
}
