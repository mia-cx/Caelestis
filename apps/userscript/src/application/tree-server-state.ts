import { type TemplateSurface, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { PerServerMap } from '../per-server-map.js'
import { isCurrentServerConnection, onServerRemoved } from '../server-connections.js'
import type { ServerTemplate, TreeNode } from '../server-manifest.js'
import {
  amendManifestRows,
  type ManifestAdmission,
  manifestAdmission,
  manifestRows,
  onManifestChange,
  readManifest,
} from '../server-manifests.js'
import { getState, type ServerConnection } from '../settings.js'
import {
  nodeTreeKey,
  parseTreeKey,
  serverTemplateTreeKey,
  serverUrlOfScopeKey,
} from '../tree-keys.js'

/**
 * The server rows the tree draws, the parent changes it shows before the server confirms them, and
 * its refresh of each server's world manifest.
 *
 * Rendering happens synchronously, so the tree draws what the manifest store has and fills in when
 * a fetch lands. A server with no folders yet and a server whose folders have not arrived look the
 * same for a moment, which is the right trade against blocking the whole panel on a network call.
 */

interface OptimisticParent {
  readonly parentId: string | null
  readonly token: symbol
}

/**
 * Parent changes that the server has not answered yet, per server URL and row key.
 *
 * These are deliberately a render overlay rather than a rewrite of the manifest. A failed request
 * can therefore reveal the latest authoritative row again, while an unrelated manifest refresh
 * cannot make an in-flight drag visibly snap back.
 */
const optimisticParents = new PerServerMap<OptimisticParent>()

const urlOfRowKey = (key: string): string | null => {
  const parsed = parseTreeKey(key)
  return parsed?.kind === 'server-node' || parsed?.kind === 'server-template' ? parsed.url : null
}

export const renderedParent = (key: string, serverParent: string | null): string | null => {
  const url = urlOfRowKey(key)
  const optimistic = url === null ? undefined : optimisticParents.get(url, key)
  return optimistic === undefined ? serverParent : optimistic.parentId
}

export interface OptimisticServerPlacement {
  /** Keep the eager position after the server confirms it. */
  readonly commit: () => void
  /** Reveal the latest server position after the final request attempt fails. */
  readonly rollback: () => void
}

/**
 * Put an existing world row at its requested server parent before the PATCH makes a round trip.
 *
 * A token makes overlapping moves safe: a late answer for an older drag cannot commit or roll back
 * the newer one. Committing updates only the held parent field; the normal manifest refresh then
 * supplies canonical paths and any other server-derived fields.
 */
export const optimisticallyPlaceServerRow = (
  server: ServerConnection,
  key: string,
  parentId: string | null,
): OptimisticServerPlacement | null => {
  const rows = manifestRows(server)
  if (rows === undefined) return null
  const token = Symbol(key)
  const node = rows.nodes.find((candidate) => nodeTreeKey(server, candidate.id) === key)
  const template = rows.templates.find(
    (candidate) => serverTemplateTreeKey(server, candidate.id) === key,
  )
  if (node === undefined && template === undefined) return null
  optimisticParents.set(server.url, key, { parentId, token })

  const current = (): boolean => optimisticParents.get(server.url, key)?.token === token
  return {
    commit: () => {
      if (!current()) return
      amendManifestRows(server, WORLD_TEMPLATE_SURFACE, (contents) =>
        node !== undefined
          ? {
              ...contents,
              nodes: contents.nodes.map((candidate) =>
                candidate.id === node.id ? { ...candidate, parentId } : candidate,
              ),
            }
          : {
              ...contents,
              templates: contents.templates.map((candidate) =>
                candidate.id === template?.id ? { ...candidate, nodeId: parentId } : candidate,
              ),
            },
      )
      optimisticParents.delete(server.url, key)
    },
    rollback: () => {
      if (current()) optimisticParents.delete(server.url, key)
    },
  }
}

/** Which server holds the template row identified by its server-scoped tree key. */
export const findServerTemplate = (
  key: string,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): { serverUrl: string; template: ServerTemplate } | null => {
  for (const server of getState().servers) {
    const template = manifestRows(server, surface)?.templates.find(
      (candidate) => serverTemplateTreeKey(server, candidate.id) === key,
    )
    if (template !== undefined) return { serverUrl: server.url, template }
  }
  return null
}

/**
 * What a server last said about one template, for whoever is acting on a row.
 *
 * Read from the same rows the tree was drawn from, so a menu can never offer "Unpublish" on a row
 * drawn as unpublished — the two would otherwise be answering from different copies.
 */
export const serverTemplateAt = (
  serverUrl: string,
  id: string,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): ServerTemplate | null => {
  const server = getState().servers.find((candidate) => candidate.url === serverUrl)
  return server === undefined
    ? null
    : (manifestRows(server, surface)?.templates.find((template) => template.id === id) ?? null)
}

const NO_SERVER_TEMPLATES: readonly ServerTemplate[] = []

/** The immutable manifest template array currently backing one server's tree rows. */
export const templatesForServer = (
  serverUrl: string,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): readonly ServerTemplate[] => {
  const server = getState().servers.find((candidate) => candidate.url === serverUrl)
  return server === undefined
    ? NO_SERVER_TEMPLATES
    : (manifestRows(server, surface)?.templates ?? NO_SERVER_TEMPLATES)
}

/** Which server holds a folder row — the same scoped-key lookup as `findServerTemplate`. */
export const findServerNode = (
  key: string,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): { serverUrl: string; node: TreeNode } | null => {
  for (const server of getState().servers) {
    const node = manifestRows(server, surface)?.nodes.find(
      (candidate) => nodeTreeKey(server, candidate.id) === key,
    )
    if (node !== undefined) return { serverUrl: server.url, node }
  }
  return null
}

const serverUrlForTreeParent = (
  key: string | null,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): string | null => {
  if (key === null) return null
  return serverUrlOfScopeKey(key) ?? findServerNode(key, surface)?.serverUrl ?? null
}

export const isSameServerPlacement = (
  draggedKey: string,
  parentKey: string | null,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): boolean => {
  const dragged = parseTreeKey(draggedKey)?.kind
  const sourceUrl =
    dragged === 'server-template'
      ? findServerTemplate(draggedKey, surface)?.serverUrl
      : dragged === 'server-node'
        ? findServerNode(draggedKey, surface)?.serverUrl
        : undefined
  return sourceUrl !== undefined && sourceUrl === serverUrlForTreeParent(parentKey, surface)
}

/** Whether a refresh's manifest became the tree and canvas authority, and why not. */
export type ServerSnapshotResult =
  | ManifestAdmission
  | { readonly status: 'failed'; readonly message: string }

/** Every world manifest admission or refusal, whichever read or event caused it. */
export const onServerSnapshot = (
  listener: (server: ServerConnection, result: ServerSnapshotResult) => void,
): (() => void) =>
  onManifestChange((server, surface, change) => {
    if (surface.kind === 'world' && change.status !== 'forgotten') listener(server, change)
  })

const refreshing = new WeakMap<ServerConnection, Promise<ServerSnapshotResult>>()
const refreshControllers = new Map<string, AbortController>()
const refreshGeneration = new Map<string, number>()
const refreshedConnections = new WeakSet<ServerConnection>()
const nodeErrors = new WeakMap<ServerConnection, string>()

export const hasRefreshedServer = (server: ServerConnection): boolean =>
  refreshedConnections.has(server)

export const serverSnapshotError = (server: ServerConnection): string | undefined =>
  nodeErrors.get(server)

export const isServerRefreshing = (server: ServerConnection): boolean => refreshing.has(server)

/**
 * Re-read what a server publishes on the world surface: its folders and the templates under them.
 *
 * **Not gated on admin.** The tree is what a read token is for — seeing what the alliance is
 * building. Only *changing* it is privileged, and that boundary is drawn per row by `canEdit`.
 *
 * One at a time per server. The render pass calls this for any connected server it has nothing for,
 * and a render pass is cheap to provoke — so a server that is slow, unreachable, or refusing the
 * token got a fresh manifest request on *every* re-render, because a failure leaves the rows empty
 * and the next pass sees the same gap. Sharing the in-flight promise makes that one request.
 */
export const refreshServerSnapshot = async (
  server: ServerConnection,
  rerender: () => void,
  force = false,
): Promise<ServerSnapshotResult> => {
  if (!isCurrentServerConnection(server)) {
    return {
      status: 'superseded',
      message: 'The server connection changed before refresh.',
    }
  }
  const pending = refreshing.get(server)
  if (!force && pending !== undefined) {
    const result = await pending
    queueMicrotask(rerender)
    return result
  }
  const generation = (refreshGeneration.get(server.url) ?? 0) + 1
  refreshGeneration.set(server.url, generation)
  refreshControllers.get(server.url)?.abort(new Error('superseded by a newer refresh'))
  const controller = new AbortController()
  refreshControllers.set(server.url, controller)
  refreshedConnections.add(server)
  const run = refreshOnce(server, generation, controller.signal)
  refreshing.set(server, run)
  const result = await run
  if (refreshing.get(server) === run) refreshing.delete(server)
  if (refreshControllers.get(server.url) === controller) refreshControllers.delete(server.url)
  if (result.status === 'admitted') nodeErrors.delete(server)
  else if (result.status !== 'superseded') nodeErrors.set(server, result.message)
  queueMicrotask(rerender)
  return result
}

const refreshOnce = async (
  server: ServerConnection,
  generation: number,
  signal: AbortSignal,
): Promise<ServerSnapshotResult> => {
  const contents = await readManifest(server, { signal })
  if (!isCurrentServerConnection(server)) {
    return {
      status: 'superseded',
      message: 'The server connection changed during refresh.',
    }
  }
  if (refreshGeneration.get(server.url) !== generation) {
    return {
      status: 'superseded',
      message: 'A newer refresh replaced this one.',
    }
  }
  // Unreachable, so nothing is known. The tree keeps drawing what the store holds rather than
  // emptying itself — a server that blinks should not take its folders off your screen.
  const admission = contents === null ? undefined : manifestAdmission(contents)
  return admission ?? { status: 'failed', message: 'Could not refresh this server.' }
}

onServerRemoved((serverUrl) => {
  optimisticParents.forget(serverUrl)
  refreshControllers.get(serverUrl)?.abort(new Error('server disconnected'))
  refreshControllers.delete(serverUrl)
  refreshGeneration.delete(serverUrl)
})
