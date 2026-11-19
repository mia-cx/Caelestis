import { type TemplateSurface, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { moveNode as moveNodeOnServer, patchTemplate } from '../server-api.js'
import { serverByUrl, serverLabel } from '../server-connections.js'
import type { ServerConnection } from '../settings.js'
import { canCopyAsLocalTemplate, templateById } from '../templates/local-store.js'
import {
  localFolderIdOf,
  localFolderKey,
  localTemplateKey,
  nodeTreeKey,
  parseTreeKey,
  serverTemplateKey,
  serverTemplateTreeKey,
} from '../tree-keys.js'
import { requestConfirmation, showToast } from '../ui/notification-host.js'
import { busyRefusal } from './template-busy.js'
import {
  copyLocalTemplateToServer,
  moveServerTemplateToLocal,
  moveServerTemplateToServer,
} from './transfer.js'
import { type Destination, type Source, transplant } from './transplant.js'
import { refreshEditedSurface, retryOptimisticMutation } from './tree-server.js'
import {
  findServerNode,
  findServerTemplate,
  optimisticallyPlaceServerRow,
} from './tree-server-state.js'

/**
 * Move a whole folder — a server's node or a Local one — to wherever it was dropped.
 *
 * Confirmed first when it crosses a boundary, because the source end of it is a delete that other
 * people can see, and a drag is easy to make by accident. Nothing is removed until the destination
 * holds the entire branch; see `transplant`.
 */
export const moveBranch = async (
  draggedKey: string,
  destination: Destination,
  rerender: () => void,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<string | null> => {
  const fromServer = parseTreeKey(draggedKey)?.kind === 'server-node'
  const found = fromServer ? findServerNode(draggedKey, surface) : null
  if (fromServer && found === null) return null
  const sourceId = found?.node.id ?? localFolderIdOf(draggedKey)
  if (sourceId === null) return null

  const sourceServer = found === null ? null : (serverByUrl(found.serverUrl) ?? null)
  if (fromServer && sourceServer === null) return null

  /**
   * Within one server, a move is one field: the node's parent.
   *
   * Nothing is copied and no pixels move — the templates hang off node ids that do not change — so
   * this is a different operation from crossing a boundary, and asking to confirm it would be
   * asking about a folder drag inside a single tree, which nobody expects.
   */
  if (
    destination.kind === 'server' &&
    sourceServer !== null &&
    destination.server.url === sourceServer.url
  ) {
    if (found !== null && destination.nodeId === found.node.parentId) return draggedKey
    const optimistic =
      surface.kind === 'world'
        ? optimisticallyPlaceServerRow(destination.server, draggedKey, destination.nodeId)
        : null
    const moved = await retryOptimisticMutation(() =>
      moveNodeOnServer(destination.server, sourceId, destination.nodeId),
    )
    if (!moved.ok) {
      optimistic?.rollback()
      showToast(moved.message, 'error')
      rerender()
      return null
    }
    optimistic?.commit()
    rerender()
    void refreshEditedSurface(destination.server, surface, rerender)
    return draggedKey
  }

  const sourceName = sourceServer === null ? 'Local' : serverLabel(sourceServer)
  const destinationName = destination.kind === 'local' ? 'Local' : serverLabel(destination.server)
  const confirmed = await requestConfirmation({
    title: `Move this folder to ${destinationName}?`,
    body: `Everything inside it is copied to ${destinationName} first, and only then removed from ${sourceName}.`,
    ...(sourceServer === null
      ? {}
      : { note: `Everyone connected to ${sourceName} will stop seeing it.` }),
    confirmLabel: 'Move',
  })
  if (!confirmed) return null

  const source: Source =
    sourceServer === null
      ? { kind: 'local', folderId: sourceId }
      : { kind: 'server', server: sourceServer, nodeId: sourceId }

  showToast('Moving…')
  const result = await transplant(source, destination, rerender, surface)
  showToast(result.message, result.tone)
  rerender()
  if (!result.ok || result.destinationId === undefined) return null
  return destination.kind === 'server'
    ? nodeTreeKey(destination.server, result.destinationId)
    : localFolderKey(result.destinationId)
}

/**
 * Take a single published template into Local, and off the server.
 *
 * The pixels come from the copy already drawn, so nothing is downloaded twice — and if it has not
 * finished arriving there is nothing to move yet, which is worth saying rather than half-doing.
 */
export const copyServerTemplateToLocal = async (
  templateKey: string,
  folderId: string | null,
  rerender: () => void,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<string | null> => {
  const found = findServerTemplate(templateKey, surface)
  if (found === null) return null
  const source = serverByUrl(found.serverUrl)
  if (source === undefined) return null
  const drawn = templateById(serverTemplateKey(found.serverUrl, found.template.id, surface))
  if (drawn === undefined || drawn.serverVersion !== found.template.version) {
    showToast('That template has not finished loading yet — try again in a moment.', 'warning')
    return null
  }
  if (!canCopyAsLocalTemplate(drawn)) {
    showToast('Wrapped server templates cannot be moved into Local yet.', 'warning')
    return null
  }

  const sourceName = serverLabel(source)
  const confirmed = await requestConfirmation({
    title: `Move “${found.template.name}” into Local?`,
    body: `It is copied into this browser first, and only then removed from ${sourceName}.`,
    note: `Everyone connected to ${sourceName} will stop seeing it.`,
    confirmLabel: 'Move',
  })
  if (!confirmed) return null

  const result = await moveServerTemplateToLocal(source, found.template, drawn, folderId, rerender)
  showToast(result.message, result.tone)
  rerender()
  return result.destinationId === undefined ? null : localTemplateKey(result.destinationId)
}

/**
 * A template or folder dropped onto a folder on a server, or onto the server's own row.
 *
 * Three journeys behind one gesture, and which one it is comes from what was dragged:
 *
 * - **From Local** — an upload. The same thing "Copy to a server" does, with the destination
 *   already answered by where it was dropped.
 * - **Within one server** — a refile, which is a single column and touches no pixels.
 * - **Across servers** — a move: the artwork is uploaded to the destination and then removed from
 *   the source. Confirmed first, because the second half is destructive to something other people
 *   can see, and a drag is easy to make by accident.
 *
 * A drop that would change nothing is silently ignored rather than round-tripping to say so.
 */
export const dropOnServerNode = async (
  server: ServerConnection,
  nodeId: string | null,
  draggedKey: string,
  rerender: () => void,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<string | null> => {
  // A folder is a branch, not a row: its structure and everything hanging off it must exist at the
  // destination before anything is taken off the source. `transplant` owns that ordering; this only
  // decides which end is which.
  //
  // This is also the one destination that may be the server itself rather than a folder on it —
  // dropping onto the server's own row means the top level for folders and templates alike.
  const dragged = parseTreeKey(draggedKey)
  if (dragged?.kind === 'server-node' || dragged?.kind === 'local-folder') {
    return await moveBranch(draggedKey, { kind: 'server', server, nodeId }, rerender, surface)
  }
  if (dragged?.kind === 'local-template') {
    const local = templateById(dragged.id)
    if (local === undefined) return null
    // The refusal the Copy dialog makes: a drag onto a server folder is the same upload by another
    // gesture.
    const busy = busyRefusal(local, 'copying it')
    if (busy !== null) {
      showToast(busy, 'warning')
      return null
    }
    const result = await copyLocalTemplateToServer(local, server, nodeId, rerender)
    if (result.ok) showToast(`Uploaded “${local.name}” to ${serverLabel(server)}.`)
    else showToast(result.message, result.retryable === true ? 'warning' : 'error')
    return result.ok ? serverTemplateTreeKey(server, result.id) : null
  }

  if (dragged?.kind !== 'server-template') return null
  const found = findServerTemplate(draggedKey, surface)
  if (found === null) return null
  const templateId = found.template.id

  if (found.serverUrl === server.url) {
    if (found.template.nodeId === nodeId) return draggedKey
    const optimistic =
      surface.kind === 'world' ? optimisticallyPlaceServerRow(server, draggedKey, nodeId) : null
    const result = await retryOptimisticMutation(() =>
      patchTemplate(server, templateId, { nodeId }),
    )
    if (!result.ok) {
      optimistic?.rollback()
      showToast(result.message, 'error')
      rerender()
      return null
    }
    optimistic?.commit()
    rerender()
    void refreshEditedSurface(server, surface, rerender)
    return draggedKey
  }

  const source = serverByUrl(found.serverUrl)
  if (source === undefined) return null
  const sourceName = serverLabel(source)
  const destinationName = serverLabel(server)
  const confirmed = await requestConfirmation({
    title: `Move “${found.template.name}” to ${destinationName}?`,
    body: `It will be uploaded to ${destinationName} and removed from ${sourceName}.`,
    note: `Everyone connected to ${sourceName} will stop seeing it.`,
    confirmLabel: 'Move',
  })
  if (!confirmed) return null

  // The pixels come from the copy already on the canvas, which is the assembled result of that
  // server's own chunks — so a cross-server move needs no second download.
  const drawn = templateById(serverTemplateKey(found.serverUrl, templateId, surface))
  if (drawn === undefined) {
    showToast('That template has not finished loading yet — try again in a moment.', 'warning')
    return null
  }
  const result = await moveServerTemplateToServer(
    source,
    server,
    nodeId,
    found.template,
    drawn,
    rerender,
  )
  showToast(result.message, result.tone)
  return result.destinationId === undefined
    ? null
    : serverTemplateTreeKey(server, result.destinationId)
}
