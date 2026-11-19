import { warn } from '../debug.js'
import { removeLocalFolder } from '../local-folders.js'
import {
  countNodeSubtree,
  deleteNode as deleteNodeOnServer,
  deleteTemplate as deleteTemplateOnServer,
} from '../server-api.js'
import { getState, removeTreeStateKeys } from '../settings.js'
import { templateIdsInLocalFolder } from '../templates/catalog.js'
import { stopMoveForDeletion } from '../templates/move.js'
import { removeLocalTemplate, setTemplatesFolder } from '../templates/template-edits.js'
import { localFolderIdOf, localTemplateIdOf } from '../tree-keys.js'
import { requestConfirmation, showToast } from '../ui/notification-host.js'
import type { TreeTarget } from '../ui/tree-context.js'
import { plural } from './plural.js'
import { refreshEditedSurface } from './tree-server.js'
import { surfaceOf } from './tree-target.js'

/**
 * Delete sits in a context menu one slip away from Rename, and a folder is not recoverable from the
 * client, so it always asks first.
 */
const askToDelete = (
  kind: string,
  name: string,
  note: string,
  restoreFocusTo: HTMLElement | null,
): Promise<boolean> =>
  requestConfirmation({
    // Their shape: the heading asks, the body names the thing and says what happens to it.
    title: `Delete ${kind}?`,
    body: `${name} will be permanently removed.`,
    note,
    confirmLabel: 'Delete',
    restoreFocusTo,
  })

const deleteLocalTemplate = async (
  target: TreeTarget,
  templateId: string,
  rerender: () => void,
  restoreFocusTo: HTMLElement | null,
): Promise<void> => {
  if (
    !(await askToDelete(
      'template',
      target.name,
      'It is stored in this browser only.',
      restoreFocusTo,
    ))
  ) {
    return
  }
  // Join an existing delete in the store rather than returning early: every surface that asked
  // still receives the real outcome. If placement was active, reserve its slot until deletion is
  // known to have succeeded; a failed delete restores exactly the preview the user was moving.
  const stoppedMove = stopMoveForDeletion(templateId)
  const failed = (): void => {
    showToast(`Could not delete “${target.name}”.`, 'error')
    if (
      stoppedMove !== null &&
      !stoppedMove.reservation.start(templateId, rerender, stoppedMove.origin)
    ) {
      showToast(`Could not restore placement for “${target.name}”.`, 'error')
    }
  }
  try {
    if (!(await removeLocalTemplate(templateId))) {
      failed()
      return
    }
    removeTreeStateKeys(new Set([target.key]))
    rerender()
  } catch (error) {
    warn('local delete failed', String(error))
    failed()
  } finally {
    stoppedMove?.reservation.release()
  }
}

const deleteLocalFolder = async (
  target: TreeTarget,
  folderId: string,
  rerender: () => void,
  restoreFocusTo: HTMLElement | null,
): Promise<void> => {
  const confirmed = await requestConfirmation({
    title: `Delete “${target.name}”?`,
    body: 'The folder will be removed.',
    // Say where things go, because "delete" on a container reads as "delete what is inside it".
    note: 'Anything inside it moves up one level rather than being deleted.',
    confirmLabel: 'Delete',
    restoreFocusTo,
  })
  if (!confirmed) return
  // The folder goes only once everything inside it has somewhere else to be. A write that fails —
  // IndexedDB gone, or a compare-and-swap lost to another tab — leaves that template pointing at a
  // folder id, and the tree renders templates by matching their folder to one that exists, so
  // removing the folder anyway would take the template off screen for good.
  const parentId = getState().localFolders.find((f) => f.id === folderId)?.parentId ?? null
  const children = templateIdsInLocalFolder(folderId)
  if (!(await setTemplatesFolder(children, parentId))) {
    showToast(`Could not move everything out of “${target.name}”, so the folder was kept.`, 'error')
    rerender()
    return
  }
  if (!removeLocalFolder(folderId)) {
    showToast(`Everything was moved out, but “${target.name}” could not be deleted.`, 'error')
    rerender()
    return
  }
  removeTreeStateKeys(new Set([target.key]))
  rerender()
}

/**
 * A folder on a server, which is never only a folder.
 *
 * The count comes from the server rather than the tree, because the tree only knows what it has
 * fetched — a folder nobody has expanded has never been listed — and "delete 1 folder" for
 * something holding forty templates is the kind of wrong that only shows up afterwards.
 */
const deleteServerFolder = async (
  target: TreeTarget & { readonly server: NonNullable<TreeTarget['server']> },
  nodeId: string,
  rerender: () => void,
  restoreFocusTo: HTMLElement | null,
): Promise<void> => {
  const holding = await countNodeSubtree(target.server, nodeId)
  if (holding === null) {
    showToast(`Could not count what is inside “${target.name}”, so the folder was kept.`, 'error')
    return
  }
  const inside =
    holding.nodes === 1 && holding.templates === 0
      ? null
      : { folders: holding.nodes - 1, templates: holding.templates }
  const contents =
    inside === null || (inside.folders === 0 && inside.templates === 0)
      ? null
      : [
          inside.folders > 0 ? plural(inside.folders, 'subfolder') : '',
          inside.templates > 0 ? plural(inside.templates, 'template') : '',
        ]
          .filter((part) => part !== '')
          .join(' and ')

  const confirmed = await requestConfirmation({
    title: `Delete “${target.name}”?`,
    body:
      contents === null
        ? `${target.name} will be permanently removed.`
        : `${target.name} and everything in it — ${contents} — will be permanently removed.`,
    ...(contents === null
      ? {}
      : {
          note: 'Everyone connected to this server loses all of it, and it cannot be undone.',
        }),
    confirmLabel: 'Delete',
    restoreFocusTo,
  })
  if (!confirmed) return

  // Cascade only where there is something to cascade. An empty folder deletes without the flag, so
  // a server that does not know it still answers.
  const result = await deleteNodeOnServer(target.server, nodeId, inside === null ? null : holding)
  if (!result.ok) showToast(result.message, 'error')
  await refreshEditedSurface(target.server, surfaceOf(target), rerender)
}

/** Delete whatever row `target` is, after asking. */
export const deleteTreeRow = async (
  target: TreeTarget,
  rerender: () => void,
  restoreFocusTo: HTMLElement | null = null,
): Promise<void> => {
  const templateId = localTemplateIdOf(target.key)
  if (templateId !== null) {
    await deleteLocalTemplate(target, templateId, rerender, restoreFocusTo)
    return
  }
  const folderId = localFolderIdOf(target.key)
  if (folderId !== null) {
    await deleteLocalFolder(target, folderId, rerender, restoreFocusTo)
    return
  }
  const { server } = target
  if (server !== null && target.templateId !== undefined) {
    if (target.templateVersion === undefined || target.templateUpdatedAt === undefined) {
      showToast('That template revision is no longer available. Refresh and try again.', 'warning')
      return
    }
    const confirmed = await askToDelete(
      'published template',
      target.name,
      // Said plainly because it is the one delete here that reaches other people: everyone
      // connected to this server loses it, not just this browser.
      'Everyone connected to this server will stop seeing it.',
      restoreFocusTo,
    )
    if (!confirmed) return
    const result = await deleteTemplateOnServer(server, target.templateId, {
      version: target.templateVersion,
      updatedAt: target.templateUpdatedAt,
    })
    if (!result.ok) showToast(result.message, 'error')
    await refreshEditedSurface(server, surfaceOf(target), rerender)
    return
  }
  if (server === null || target.nodeId === null) {
    showToast('Nothing to delete here yet.', 'warning')
    return
  }
  await deleteServerFolder({ ...target, server }, target.nodeId, rerender, restoreFocusTo)
}
