import {
  parseTemplateTags,
  type ReconciliationReason,
  SERVER_ASSET_MAX_BYTES,
  type ServerAssetKind,
  type SyncTransport,
  type TemplateSurface,
  type TemplateTag,
  templateRecipeJson,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { userscriptClientHeaders } from './client-metrics.js'
import { warn } from './debug.js'
import type { ServerTemplate } from './server-cache.js'
import {
  activeServerToken,
  bearer,
  isCurrentServerConnection,
  noteAuthFailure,
  onServerRemoved,
  serverConnectionIdentity,
  serverConnectionSignal,
  takeProbedManifest,
  upsertServer,
} from './server-connections.js'
import {
  parseServerInfo,
  parseServerManifest,
  parseTreeNode,
  parseTreeNodes,
  type ServerInfo,
  type ServerManifest,
  type TreeNode,
} from './server-manifest.js'
import { coalesceServerRead } from './server-read-coalescer.js'
import {
  requestServerManifest,
  requestServerMetadata,
  requestServerMutation,
  requestServerTree,
  requestServerUpload,
  serverManifestSequence,
} from './server-transport.js'
import { serverEndpoint } from './server-url.js'
import { getState, type ServerConnection } from './settings.js'
import type { TemplateAuthoring } from './templates/authoring.js'

/** The template server's HTTP API: the manifest every member reads, and the admin routes. */

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

type Failure = { readonly ok: false; readonly message: string }
type Done = { readonly ok: true } | Failure

const FORBIDDEN = 'That code cannot change this server — it needs admin access.'

/** What an admin route's refusal says to the user. */
const failureMessage = (response: Response, body: unknown, forbidden = FORBIDDEN): string =>
  response.status === 401 || response.status === 403
    ? forbidden
    : isRecord(body) && typeof body.error === 'string'
      ? body.error
      : `Server said ${response.status}.`

const retryable = (status: number): boolean => status === 408 || status === 429 || status >= 500

const adminHeaders = (server: ServerConnection): Record<string, string> => ({
  'content-type': 'application/json',
  ...bearer(activeServerToken(server)),
})

type Send = typeof requestServerMutation

/**
 * One call to an admin route with this connection's credential. A refused credential is noted on
 * the connection here, so every route reports it the same way.
 */
const adminRequest = async (
  server: ServerConnection,
  path: string,
  init: {
    readonly method?: string
    readonly json?: unknown
    readonly body?: BodyInit
    readonly headers?: Record<string, string>
    readonly send?: Send
  } = {},
): Promise<{ readonly response: Response; readonly body: unknown }> => {
  const send = init.send ?? requestServerMutation
  const { response, body } = await send(serverEndpoint(server.url, path), {
    ...(init.method === undefined ? {} : { method: init.method }),
    headers: init.headers ?? adminHeaders(server),
    ...(init.json !== undefined
      ? { body: JSON.stringify(init.json) }
      : init.body === undefined
        ? {}
        : { body: init.body }),
  })
  if (response.status === 401 || response.status === 403) noteAuthFailure(server, response.status)
  return { response, body }
}

/**
 * An admin write whose success carries nothing back. `path` may be built lazily, so a request that
 * cannot even be addressed fails like any other.
 */
const adminWrite = async (
  server: ServerConnection,
  path: string | (() => string),
  init: Parameters<typeof adminRequest>[2],
): Promise<Done> => {
  try {
    const { response, body } = await adminRequest(
      server,
      typeof path === 'string' ? path : path(),
      init,
    )
    return response.ok ? { ok: true } : { ok: false, message: failureMessage(response, body) }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

/** An admin write a caller may retry after a timeout, rate limit, server error or network failure. */
const retryableAdminWrite = async (
  server: ServerConnection,
  path: string,
  init: Parameters<typeof adminRequest>[2],
): Promise<Done | (Failure & { readonly retryable: true })> => {
  try {
    const { response, body } = await adminRequest(server, path, init)
    if (response.ok) return { ok: true }
    return {
      ok: false,
      message: failureMessage(response, body),
      ...(retryable(response.status) ? { retryable: true as const } : {}),
    }
  } catch (error) {
    return { ok: false, message: String(error), retryable: true }
  }
}

export type NodeListResult =
  | { readonly ok: true; readonly nodes: readonly TreeNode[] }
  | { readonly ok: false; readonly message: string; readonly status?: number }

const nodeListFrom = (body: unknown): readonly TreeNode[] | null => {
  const raw = isRecord(body) && 'nodes' in body ? body.nodes : body
  return parseTreeNodes(raw)
}

const fetchNodes = async (
  base: string,
  token: string | null,
  season: number,
  surface: TemplateSurface,
  signal?: AbortSignal,
): Promise<NodeListResult> => {
  try {
    const query = new URLSearchParams({ season: String(season), surface: surface.kind })
    if (surface.allianceId !== null) query.set('allianceId', String(surface.allianceId))
    const { response, body } = await requestServerTree(
      serverEndpoint(base, `/admin/nodes?${query}`),
      {
        headers: bearer(token),
        ...(signal === undefined ? {} : { signal }),
      },
    )
    if (!response.ok)
      return {
        ok: false,
        status: response.status,
        message: `Server said ${response.status}.`,
      }
    const nodes = nodeListFrom(body)
    return nodes === null
      ? { ok: false, message: 'Server returned an invalid folder list.' }
      : { ok: true, nodes }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

/**
 * Create a folder on a server.
 *
 * `POST /admin/nodes` needs admin scope, and nothing in `GET /server` says whether the code we hold
 * has it — so the only honest way to find out is to try and report what comes back. A 403 means the
 * code is a read code, which is a different problem from the server being down.
 */
export const createNode = async (
  server: ServerConnection,
  name: string,
  parentId: string | null,
  description?: string,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<{ ok: true; node: TreeNode } | { ok: false; message: string }> => {
  if (server.season === null)
    return { ok: false, message: 'Refresh this server before editing it.' }
  try {
    const { response, body } = await adminRequest(server, '/admin/nodes', {
      method: 'POST',
      json: {
        season: server.season,
        surfaceKind: surface.kind,
        ...(surface.allianceId === null ? {} : { allianceId: surface.allianceId }),
        parentId,
        name,
        ...(description === undefined ? {} : { description }),
      },
    })
    if (response.ok) {
      const node = parseTreeNode(body)
      if (node === null || node.parentId !== parentId) {
        return { ok: false, message: 'Server returned an invalid folder.' }
      }
      return { ok: true, node }
    }
    return {
      ok: false,
      message: failureMessage(
        response,
        body,
        'That code cannot create folders — it needs admin access.',
      ),
    }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

type UploadFailure = {
  readonly ok: false
  readonly message: string
  readonly ambiguous?: true
}

interface PendingUploadAmbiguity {
  readonly afterManifestRequest: number
}

const pendingUploadAmbiguities = new Map<string, PendingUploadAmbiguity>()
const activeUploads = new Map<string, { readonly token: object }>()

const markUploadAmbiguous = (server: ServerConnection, message: string): UploadFailure => {
  const existing = pendingUploadAmbiguities.get(server.url)
  pendingUploadAmbiguities.set(server.url, {
    afterManifestRequest: Math.max(existing?.afterManifestRequest ?? 0, serverManifestSequence()),
  })
  return { ok: false, message, ambiguous: true }
}

const clearUploadAmbiguity = (server: ServerConnection, manifestRequest: number): void => {
  const pending = pendingUploadAmbiguities.get(server.url)
  if (pending !== undefined && manifestRequest > pending.afterManifestRequest) {
    pendingUploadAmbiguities.delete(server.url)
  }
}

const beginUpload = (
  server: ServerConnection,
): { readonly token: object } | { readonly failure: UploadFailure } => {
  if (!isCurrentServerConnection(server)) {
    return { failure: { ok: false, message: 'The server connection changed before upload.' } }
  }
  if (pendingUploadAmbiguities.has(server.url)) {
    return {
      failure: {
        ok: false,
        message:
          'A previous upload may have completed. Refresh this server before uploading again.',
        ambiguous: true,
      },
    }
  }
  if (activeUploads.has(server.url)) {
    return { failure: { ok: false, message: 'Another upload to this server is still running.' } }
  }
  const token = {}
  activeUploads.set(server.url, { token })
  return { token }
}

const endUpload = (serverUrl: string, token: object): void => {
  if (activeUploads.get(serverUrl)?.token === token) activeUploads.delete(serverUrl)
}

/** Multipart uploads set their own content type, so only the credential travels as a header. */
const uploadInit = (server: ServerConnection, body: FormData) =>
  ({
    method: 'POST',
    headers: bearer(activeServerToken(server)),
    body,
    send: requestServerUpload,
  }) as const

export const renameNode = (server: ServerConnection, nodeId: string, name: string): Promise<Done> =>
  adminWrite(server, `/admin/nodes/${nodeId}`, { method: 'PATCH', json: { name } })

export const deleteNode = (
  server: ServerConnection,
  nodeId: string,
  expected: {
    readonly nodes: number
    readonly templates: number
  } | null = null,
): Promise<Done> => {
  const cascade =
    expected === null
      ? ''
      : `?cascade=true&expectedNodes=${expected.nodes}&expectedTemplates=${expected.templates}`
  return adminWrite(server, `/admin/nodes/${nodeId}${cascade}`, { method: 'DELETE' })
}

/** The optional source and recipe parts of a template upload. */
const setAuthoringParts = async (
  form: FormData,
  authoring: TemplateAuthoring | null | undefined,
): Promise<void> => {
  if (authoring == null) return
  // Re-wrapped: a stored source is a page-realm Blob that this realm's FormData refuses.
  const source = new Blob([await authoring.source.arrayBuffer()], { type: 'image/png' })
  form.set('source', source, 'source.png')
  form.set('recipe', templateRecipeJson(authoring.recipe))
}

/**
 * Publish a local template to a server.
 *
 * `POST /admin/templates` is multipart and wants an indexed PNG plus the origin in canvas pixels,
 * which is exactly what a local template already holds — so this is a move rather than a
 * conversion, and the placement someone got right locally is the placement the server stores.
 */
export const uploadTemplate = async (
  server: ServerConnection,
  input: {
    nodeId: string | null
    name: string
    originX: number
    originY: number
    png: Blob
    surface?: TemplateSurface
    /** The source and recipe behind `png`, kept by the server with this version. */
    authoring?: TemplateAuthoring | null
  },
): Promise<{ ok: true; id: string; version: string } | UploadFailure> => {
  const begun = beginUpload(server)
  if ('failure' in begun) return begun.failure
  try {
    const form = new FormData()
    form.set('png', input.png, `${input.name}.png`)
    await setAuthoringParts(form, input.authoring)
    if (input.nodeId !== null) form.set('nodeId', input.nodeId)
    if (server.season === null) return { ok: false, message: 'Refresh this server first.' }
    form.set('season', String(server.season))
    form.set('name', input.name)
    form.set('originX', String(input.originX))
    form.set('originY', String(input.originY))
    if (input.surface?.kind !== undefined && input.surface.kind !== 'world') {
      form.set('surfaceKind', input.surface.kind)
      form.set('allianceId', String(input.surface.allianceId))
    }
    const { response, body } = await adminRequest(
      server,
      '/admin/templates',
      uploadInit(server, form),
    )
    if (response.ok) {
      const id = isRecord(body) ? body.templateId : undefined
      const version = isRecord(body) ? body.versionId : undefined
      return typeof id === 'string' &&
        UUID_V7.test(id) &&
        typeof version === 'string' &&
        UUID_V7.test(version)
        ? { ok: true, id, version }
        : markUploadAmbiguous(server, 'Server returned an invalid uploaded template.')
    }
    const message = failureMessage(
      response,
      body,
      'That code cannot upload templates — it needs admin access.',
    )
    return response.status >= 500 ? markUploadAmbiguous(server, message) : { ok: false, message }
  } catch (error) {
    return markUploadAmbiguous(server, String(error))
  } finally {
    endUpload(server.url, begun.token)
  }
}

export const moveNode = (server: ServerConnection, nodeId: string, parentId: string | null) =>
  retryableAdminWrite(server, `/admin/nodes/${nodeId}`, { method: 'PATCH', json: { parentId } })

export const countNodeSubtree = async (
  server: ServerConnection,
  nodeId: string,
): Promise<{ nodes: number; templates: number } | null> => {
  try {
    const { response, body } = await adminRequest(server, `/admin/nodes/${nodeId}/subtree`)
    if (!response.ok || !isRecord(body)) return null
    const { nodes, templates } = body
    if (
      typeof nodes !== 'number' ||
      !Number.isSafeInteger(nodes) ||
      nodes < 1 ||
      typeof templates !== 'number' ||
      !Number.isSafeInteger(templates) ||
      templates < 0
    )
      return null
    return { nodes, templates }
  } catch {
    return null
  }
}

/**
 * Everything a server is publishing: the folder tree and the templates hanging off it.
 *
 * One fetch, from `/manifest`, and that endpoint is the right one for **both** — the structure is
 * not privileged information. Anyone with a read code is meant to see the tree; the admin boundary
 * is *changing* it, which lives on the `/admin` routes. Reading the tree from `GET /admin/nodes`
 * put the boundary in the wrong place and left every read-scope member staring at a server with no
 * folders, and therefore no templates, since a template row is drawn under its folder.
 *
 * Answers empty on any failure rather than throwing. A tree that has drawn a stale row is better
 * than a tree that has thrown, and the cached copy is what it falls back to.
 */
export interface ServerContents {
  readonly workRevision?: number
  /** Opaque manifest revision, retained so the coordinator can back off while it is unchanged. */
  readonly revision?: string
  readonly nodes: readonly TreeNode[]
  readonly templates: readonly ServerTemplate[]
}

const latestManifestResponse = new Map<string, number>()
const manifestResponseOf = new WeakMap<ServerContents, number>()
const admittedServerContents = new Map<
  string,
  { readonly server: ServerConnection; readonly contents: ServerContents }
>()
const serverContentsListeners = new Set<
  (server: ServerConnection, contents: ServerContents) => void
>()

// Request ids are process-wide and monotonic, so an old response can never tie a request made
// after this URL reconnects. Only the answer belonging to the ended connection is forgotten.
onServerRemoved((url) => latestManifestResponse.delete(url))

/** Observe each newest successful manifest, no matter which UI or poll requested it. */
export const onServerContents = (
  listener: (server: ServerConnection, contents: ServerContents) => void,
): (() => void) => {
  serverContentsListeners.add(listener)
  return () => serverContentsListeners.delete(listener)
}

/** Whether this snapshot is still the newest successful manifest response for its server. */
export const isLatestServerContents = (serverUrl: string, contents: ServerContents): boolean => {
  const response = manifestResponseOf.get(contents)
  return response === undefined || response === latestManifestResponse.get(serverUrl)
}

/**
 * Mark the newest manifest as safe for every consumer to use.
 *
 * Aggregate admission belongs to the tree snapshot authority because it spans all configured servers.
 * Keeping the winning snapshot here gives admin helpers and the canvas repair path the same answer,
 * while retaining the connection that earned it prevents a same-URL reconnect from inheriting it.
 */
export const admitServerContents = (
  server: ServerConnection,
  contents: ServerContents,
): boolean => {
  const current = getState().servers.find((candidate) => candidate.url === server.url)
  if (
    current === undefined ||
    !isCurrentServerConnection(server) ||
    !isLatestServerContents(server.url, contents)
  )
    return false
  admittedServerContents.set(server.url, { server: current, contents })
  const request = manifestResponseOf.get(contents)
  if (request !== undefined) clearUploadAmbiguity(server, request)
  return true
}

/** The admitted snapshot belonging to this exact connection lifetime, if one exists. */
export const admittedServerContentsFor = (server: ServerConnection): ServerContents | null => {
  const admitted = admittedServerContents.get(server.url)
  return admitted !== undefined &&
    isCurrentServerConnection(server) &&
    isCurrentServerConnection(admitted.server)
    ? admitted.contents
    : null
}

export const forgetAdmittedServerContents = (serverUrl: string): void => {
  admittedServerContents.delete(serverUrl)
}

const awaitReadOrAbort = <T>(read: Promise<T>, signal: AbortSignal): Promise<T | null> =>
  new Promise<T | null>((resolve, reject) => {
    const aborted = (): void => {
      cleanup()
      resolve(null)
    }
    const cleanup = (): void => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    void read.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })

const refreshServerRelease = (server: ServerConnection, release: ServerInfo): ServerConnection => {
  if (
    server.info === null ||
    (server.info.version === release.version && server.info.build === release.build)
  )
    return server
  const { version: _version, build: _build, ...info } = server.info
  const updated = {
    ...server,
    info: {
      ...info,
      ...(release.version === undefined ? {} : { version: release.version }),
      ...(release.build === undefined ? {} : { build: release.build }),
    },
  }
  upsertServer(updated)
  return updated
}

const contentsOf = (manifest: ServerManifest): ServerContents => ({
  revision: manifest.version,
  ...(manifest.workRevision === undefined ? {} : { workRevision: manifest.workRevision }),
  nodes: manifest.nodes,
  templates: manifest.templates,
})

const publishContents = (
  current: ServerConnection,
  manifest: ServerManifest,
  contents: ServerContents,
  failure: string,
): void => {
  const updated = refreshServerRelease(current, manifest.server)
  for (const listener of serverContentsListeners) {
    try {
      listener(updated, contents)
    } catch (error) {
      warn('install', failure, String(error))
    }
  }
}

export const listServerContents = async (
  server: ServerConnection,
  signal?: AbortSignal,
  reason: ReconciliationReason = 'unknown',
  transport: SyncTransport = 'compatibility-poll',
): Promise<ServerContents | null> => {
  if (server.info === null || server.season === null) return null
  if (!isCurrentServerConnection(server)) return null
  try {
    const info = server.info
    const season = server.season
    const owner = serverConnectionIdentity(server)
    const read = coalesceServerRead(
      owner,
      `${season}\u0000world\u0000manifest`,
      async (): Promise<ServerContents | null> => {
        const {
          response,
          body,
          sequence: request,
        } = await requestServerManifest(
          serverEndpoint(server.url, `/manifest?season=${season}`),
          {
            headers: {
              ...userscriptClientHeaders({ transport, reason }),
              ...bearer(activeServerToken(server)),
            },
            signal: serverConnectionSignal(server),
          },
          () => isCurrentServerConnection(server),
        )
        if (response.status === 401 || response.status === 403)
          noteAuthFailure(server, response.status)
        if (!response.ok) return null
        const manifest = parseServerManifest(body, info)
        if (manifest === null || manifest.season !== season) return null
        return publishManifestResponse(server, manifest, request)
      },
    )
    if (signal === undefined) return await read
    if (signal.aborted) return null
    return await awaitReadOrAbort(read, signal)
  } catch {
    return null
  }
}

/** Record one manifest response and, when it is this server's newest, hand it to every listener. */
const publishManifestResponse = (
  server: ServerConnection,
  manifest: ServerManifest,
  request: number,
): ServerContents => {
  const contents = contentsOf(manifest)
  manifestResponseOf.set(contents, request)
  const current = getState().servers.find((candidate) => candidate.url === server.url)
  if (
    current !== undefined &&
    isCurrentServerConnection(server) &&
    request > (latestManifestResponse.get(server.url) ?? 0)
  ) {
    latestManifestResponse.set(server.url, request)
    publishContents(current, manifest, contents, 'could not publish fresh manifest contents')
  }
  return contents
}

/**
 * Start a connection from the manifest its probe downloaded to verify the credential.
 *
 * Connecting reads `/manifest` to prove the code works, and the first sync wanted the same manifest
 * moments later. Adopting the probe's copy makes it that first read, so a page load downloads each
 * manifest once. One use only, and never once a newer response has arrived: a later read must
 * fetch, because a mutation may have changed the manifest since.
 */
export const adoptProbedServerContents = (server: ServerConnection): ServerContents | null => {
  const probed = takeProbedManifest(server.url)
  if (
    probed === undefined ||
    !isCurrentServerConnection(server) ||
    !isCurrentServerConnection(probed.server) ||
    probed.manifest.season !== server.season ||
    probed.request <= (latestManifestResponse.get(server.url) ?? 0)
  )
    return null
  return publishManifestResponse(server, probed.manifest, probed.request)
}

/** Publish one authenticated live manifest through the same listeners as the initial read. */
export const applyLiveServerManifest = (
  server: ServerConnection,
  body: unknown,
): ServerContents | null => {
  if (server.info === null || server.season === null || !isCurrentServerConnection(server))
    return null
  const manifest = parseServerManifest(body, server.info)
  if (manifest === null || manifest.season !== server.season) return null
  const contents = contentsOf(manifest)
  const request = (latestManifestResponse.get(server.url) ?? 0) + 1
  latestManifestResponse.set(server.url, request)
  manifestResponseOf.set(contents, request)
  const current = getState().servers.find((candidate) => candidate.url === server.url)
  if (current === undefined || !isCurrentServerConnection(server)) return null
  publishContents(current, manifest, contents, 'could not publish live manifest contents')
  return contents
}

export type ServerNodesResult =
  | { readonly status: 'ok'; readonly nodes: readonly TreeNode[] }
  | { readonly status: 'unreachable' | 'not-admitted' }

/**
 * The admitted folders, with network failure kept distinct from a successful unsafe snapshot.
 *
 * Empty is a real server answer. A failed fetch used to answer with an empty list, so Move claimed
 * the server had one folder, Copy said to create one first, and folder naming picked a name as
 * though nothing was there. Aggregate refusal is different again: the server answered, but using
 * rows the tree and canvas refused would let admin actions commit against state the UI cannot show.
 */
export const listServerNodes = async (
  server: ServerConnection,
  signal?: AbortSignal,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<ServerNodesResult> => {
  if (server.season === null || !isCurrentServerConnection(server)) return { status: 'unreachable' }
  if (surface.kind !== 'world') {
    const listed = await fetchNodes(
      server.url,
      activeServerToken(server),
      server.season,
      surface,
      signal,
    )
    const current = getState().servers.find((candidate) => candidate.url === server.url)
    if (!listed.ok || current === undefined || !isCurrentServerConnection(server))
      return { status: 'unreachable' }
    return { status: 'ok', nodes: listed.nodes }
  }
  const contents = await listServerContents(server, signal)
  const current = getState().servers.find((candidate) => candidate.url === server.url)
  if (contents === null || current === undefined || !isCurrentServerConnection(server))
    return { status: 'unreachable' }
  const admitted = admittedServerContentsFor(current)
  return admitted === null ? { status: 'not-admitted' } : { status: 'ok', nodes: admitted.nodes }
}

/** Dismiss an observed grief episode for everyone on this server. */
export const dismissTemplateAlarm = (
  server: ServerConnection,
  templateId: string,
  alarmId: string,
): Promise<Done> =>
  adminWrite(server, `/admin/templates/${templateId}/alarms/${alarmId}`, { method: 'DELETE' })

export const patchTemplate = (
  server: ServerConnection,
  templateId: string,
  patch: {
    name?: string
    nodeId?: string | null
    published?: boolean
    finished?: boolean
    timelapseFrozen?: boolean
  },
) => retryableAdminWrite(server, `/admin/templates/${templateId}`, { method: 'PATCH', json: patch })

type ServerTagMutation =
  | {
      readonly type: 'assign-folder'
      readonly id: string
      readonly folderId: string
      readonly attached: boolean
    }
  | { readonly type: 'create'; readonly name: string }
  | { readonly type: 'rename'; readonly id: string; readonly name: string }
  | { readonly type: 'delete'; readonly id: string }
  | {
      readonly type: 'assign'
      readonly id: string
      readonly templateId: string
      readonly attached: boolean
    }

/** Fetch the authoritative server catalog and optional template assignments with admin credentials. */
export const listServerTags = async (
  server: ServerConnection,
  templateId?: string,
  folderId?: string,
): Promise<
  | {
      readonly ok: true
      readonly tags: readonly TemplateTag[]
      readonly selected: readonly string[]
    }
  | Failure
> => {
  try {
    const query =
      folderId !== undefined
        ? `?folderId=${encodeURIComponent(folderId)}`
        : templateId === undefined
          ? ''
          : `?templateId=${encodeURIComponent(templateId)}`
    const { response, body } = await adminRequest(server, `/admin/tags${query}`, {
      send: requestServerTree,
    })
    if (!response.ok) return { ok: false, message: failureMessage(response, body) }
    const tags = isRecord(body) ? parseTemplateTags(body.tags) : null
    const selected = isRecord(body) ? body.selected : undefined
    if (
      tags === null ||
      !Array.isArray(selected) ||
      selected.length > tags.length ||
      !selected.every(
        (id): id is string => typeof id === 'string' && tags.some((tag) => tag.id === id),
      )
    )
      return { ok: false, message: 'The server returned invalid tags.' }
    return { ok: true, tags, selected }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

/** Apply one tag mutation under the same authorization boundary as template metadata. */
export const mutateServerTag = (
  server: ServerConnection,
  mutation: ServerTagMutation,
): Promise<Done> => {
  const suffix = (): string =>
    mutation.type === 'create'
      ? ''
      : `/${encodeURIComponent(mutation.id)}${mutation.type === 'assign' ? `/templates/${encodeURIComponent(mutation.templateId)}` : mutation.type === 'assign-folder' ? `/folders/${encodeURIComponent(mutation.folderId)}` : ''}`
  const method =
    mutation.type === 'create'
      ? 'POST'
      : mutation.type === 'rename'
        ? 'PATCH'
        : (mutation.type === 'assign' || mutation.type === 'assign-folder') && mutation.attached
          ? 'PUT'
          : 'DELETE'
  return adminWrite(server, () => `/admin/tags${suffix()}`, {
    method,
    ...('name' in mutation ? { json: { name: mutation.name } } : {}),
  })
}

/** Public metadata for this server's URL, or null when it could not be read. */
const readServerInfo = async (serverUrl: string): Promise<ServerInfo | null> => {
  const metadata = await requestServerMetadata(serverEndpoint(serverUrl, '/server'))
  return metadata.response.ok ? parseServerInfo(metadata.body) : null
}

/**
 * Rename a server — the name every member sees, not a label local to this browser.
 *
 * Worth being explicit about, because the row it is edited from looks exactly like the Local one
 * above it, and that one *is* local. This writes to the server, and the next member to open their
 * panel sees the new name.
 *
 * The local copy is refreshed from public server metadata after the write. The mutation response
 * has no revision, so applying the submitted name directly could overwrite a newer rename learned
 * by a connection that replaced this one while the response was delayed.
 */
const activeServerRenames = new Set<string>()

export const renameServer = async (server: ServerConnection, name: string): Promise<Done> => {
  const trimmed = name.trim()
  if (trimmed === '') return { ok: false, message: 'A server needs a name.' }
  if (activeServerRenames.has(server.url)) {
    return { ok: false, message: 'A rename for this server is already in progress.' }
  }
  activeServerRenames.add(server.url)
  try {
    const { response, body } = await adminRequest(server, '/admin/server', {
      method: 'PATCH',
      json: { name: trimmed },
    })
    if (!response.ok) return { ok: false, message: failureMessage(response, body) }
    const current = getState().servers.find((candidate) => candidate.url === server.url)
    if (current !== undefined && current.info !== null && server.info !== null) {
      let refreshed: ServerInfo | null = null
      try {
        refreshed = await readServerInfo(current.url)
      } catch {
        // The PATCH already committed. A failed cosmetic refresh must not turn success into failure.
      }
      const latest = getState().servers.find((candidate) => candidate.url === server.url)
      if (
        latest !== undefined &&
        latest.info !== null &&
        isCurrentServerConnection(current) &&
        latest.info === current.info &&
        refreshed !== null &&
        refreshed.id === server.info.id &&
        latest.info.id === refreshed.id
      ) {
        upsertServer({ ...latest, info: refreshed })
      } else if (
        latest !== undefined &&
        latest.info !== null &&
        isCurrentServerConnection(server) &&
        latest.info === current.info &&
        refreshed === null &&
        latest.info.id === server.info.id
      ) {
        // Preserve the immediate feedback when the metadata read alone failed. This fallback is
        // safe only in the connection lifetime that submitted the write.
        upsertServer({ ...latest, info: { ...latest.info, name: trimmed } })
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, message: String(error) }
  } finally {
    activeServerRenames.delete(server.url)
  }
}

/**
 * Re-read public server metadata after an admin write committed, and adopt it only while the
 * connection that wrote is still the current one for its URL and still describes the same server.
 * A failed re-read is not a failed write, so it is swallowed.
 */
const adoptRefreshedServerInfo = async (server: ServerConnection): Promise<void> => {
  const current = getState().servers.find((candidate) => candidate.url === server.url)
  if (current === undefined || current.info === null || server.info === null) return
  let refreshed: ServerInfo | null = null
  try {
    refreshed = await readServerInfo(current.url)
  } catch {
    return
  }
  const latest = getState().servers.find((candidate) => candidate.url === server.url)
  if (
    latest !== undefined &&
    latest.info !== null &&
    isCurrentServerConnection(current) &&
    latest.info === current.info &&
    refreshed !== null &&
    refreshed.id === server.info.id
  ) {
    upsertServer({ ...latest, info: refreshed })
  }
}

/** An admin write to the server's public presentation, followed by re-reading what it now shows. */
const presentationWrite = async (
  server: ServerConnection,
  path: string,
  init: Parameters<typeof adminRequest>[2],
): Promise<Done> => {
  const written = await adminWrite(server, path, init)
  if (written.ok) await adoptRefreshedServerInfo(server)
  return written
}

export interface ServerDetailsPatch {
  readonly name?: string
  readonly description?: string | null
  readonly discordInviteUrl?: string | null
  readonly homeCopy?: string | null
  readonly logoText?: string | null
}

/** Edit the public presentation every member and crawler sees. Null clears a field. */
export const updateServerDetails = async (
  server: ServerConnection,
  patch: ServerDetailsPatch,
): Promise<Done> => {
  if (Object.values(patch).every((value) => value === undefined))
    return { ok: false, message: 'Nothing to change.' }
  return presentationWrite(server, '/admin/server', { method: 'PATCH', json: patch })
}

/** Upload a logo or link preview image. The server sniffs the container and bounds the size. */
export const uploadServerAsset = async (
  server: ServerConnection,
  kind: ServerAssetKind,
  bytes: Uint8Array,
  contentType: string,
): Promise<Done> => {
  if (bytes.byteLength === 0) return { ok: false, message: 'That file is empty.' }
  if (bytes.byteLength > SERVER_ASSET_MAX_BYTES[kind])
    return {
      ok: false,
      message: `The ${kind} image must be at most ${Math.round(SERVER_ASSET_MAX_BYTES[kind] / 1024)} KiB.`,
    }
  return presentationWrite(server, `/admin/server/assets/${kind}`, {
    method: 'PUT',
    headers: { ...adminHeaders(server), 'content-type': contentType },
    body: bytes.slice().buffer,
    send: requestServerUpload,
  })
}

export const deleteServerAsset = (server: ServerConnection, kind: ServerAssetKind): Promise<Done> =>
  presentationWrite(server, `/admin/server/assets/${kind}`, { method: 'DELETE' })

export const deleteTemplate = (
  server: ServerConnection,
  templateId: string,
  expected: { readonly version: string; readonly updatedAt: number },
): Promise<Done> => {
  const query = new URLSearchParams({
    expectedVersion: expected.version,
    expectedUpdatedAt: String(expected.updatedAt),
  })
  return adminWrite(server, `/admin/templates/${templateId}?${query}`, { method: 'DELETE' })
}

/**
 * Replace a published template's pixels, keeping everything else about it.
 *
 * The origin travels with the image because a new version is a new slicing — moving artwork on the
 * canvas is a different picture as far as the chunk index is concerned, not an edit to the old one.
 */
export const uploadTemplateVersion = async (
  server: ServerConnection,
  templateId: string,
  input: {
    originX: number
    originY: number
    png: Blob
    name: string
    /** Omitted for canvas artwork, which no recipe produced. */
    authoring?: TemplateAuthoring | null
  },
): Promise<{ ok: true; versionId: string } | UploadFailure> => {
  const begun = beginUpload(server)
  if ('failure' in begun) return begun.failure
  try {
    const form = new FormData()
    form.set('png', input.png, `${input.name}.png`)
    await setAuthoringParts(form, input.authoring)
    form.set('originX', String(input.originX))
    form.set('originY', String(input.originY))
    const { response, body } = await adminRequest(
      server,
      `/admin/templates/${templateId}/versions`,
      uploadInit(server, form),
    )
    if (response.ok) {
      const versionId = isRecord(body) ? body.versionId : undefined
      // A 2xx with no usable id is not a success we can report: the server never confirmed what it
      // stored. `uploadTemplate` rejects the same shape, and Replace announcing "done" on it told
      // the user their artwork had been replaced on no evidence at all.
      return typeof versionId === 'string' && UUID_V7.test(versionId)
        ? { ok: true, versionId }
        : markUploadAmbiguous(
            server,
            'The server accepted the upload but did not say what it stored.',
          )
    }
    const message = failureMessage(response, body)
    return response.status >= 500 ? markUploadAmbiguous(server, message) : { ok: false, message }
  } catch (error) {
    return markUploadAmbiguous(server, String(error))
  } finally {
    endUpload(server.url, begun.token)
  }
}

/**
 * An access token as the server will ever describe it back to us.
 *
 * No secret. The plaintext exists once, in the response to the call that mints it, and is never
 * stored anywhere — the server keeps a hash, so there is nothing to reveal later even if a route
 * wanted to. Which is the point: a list that could show them would turn one leaked admin session
 * into every token the server has.
 */
interface StoredAccessToken {
  readonly tokenHash: string
  readonly label: string
  readonly scope: 'read' | 'report' | 'admin'
  readonly createdWithToken: string
  readonly createdAt: number
  readonly bootstrap?: false
}

/** The operator credential is environment-owned and therefore has no revocable token hash. */
interface BootstrapAccessToken {
  readonly label: string
  readonly scope: 'admin'
  readonly createdAt: number
  readonly bootstrap: true
}

export type AccessToken = StoredAccessToken | BootstrapAccessToken

export interface AccessTokenPage {
  readonly tokens: readonly AccessToken[]
  readonly nextCursor: string | null
}

const SCOPES: readonly string[] = ['read', 'report', 'admin']
const TOKEN_CURSOR = /^(0|[1-9]\d*):[0-9a-f]{64}$/

/**
 * A configured server is someone else's machine, so its token list is checked rather than trusted:
 * the panel renders these rows and hands `tokenHash` straight back as a URL path segment.
 */
const asAccessToken = (value: unknown): AccessToken | null => {
  if (!isRecord(value)) return null
  const { label, scope, createdAt, bootstrap, tokenHash, createdWithToken } = value
  if (typeof label !== 'string' || typeof createdAt !== 'number') return null
  if (typeof scope !== 'string' || !SCOPES.includes(scope)) return null
  if (bootstrap === true) return { label, scope: 'admin', createdAt, bootstrap: true }
  if (typeof tokenHash !== 'string' || !/^[0-9a-f]{1,128}$/.test(tokenHash)) return null
  return {
    tokenHash,
    label,
    scope: scope as StoredAccessToken['scope'],
    createdWithToken: typeof createdWithToken === 'string' ? createdWithToken : '',
    createdAt,
  }
}

export const listAccessTokens = async (
  server: ServerConnection,
  cursor: string | null = null,
): Promise<AccessTokenPage | null> => {
  try {
    const suffix = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`
    const { response, body } = await adminRequest(server, `/admin/tokens${suffix}`)
    if (!response.ok) return null
    const tokens = isRecord(body) ? body.tokens : undefined
    // Pagination was added after the token-list route. Older and third-party servers legitimately
    // omit the field, which means the one page they returned is the last one.
    const nextCursor = isRecord(body) ? (body.nextCursor ?? null) : null
    if (
      !Array.isArray(tokens) ||
      (nextCursor !== null && (typeof nextCursor !== 'string' || !TOKEN_CURSOR.test(nextCursor)))
    )
      return null
    const parsed = tokens.map(asAccessToken)
    if (!parsed.every((token): token is AccessToken => token !== null)) return null
    return { tokens: parsed, nextCursor }
  } catch {
    // Null rather than empty, so the panel can say "could not ask" instead of "there are none" —
    // the difference between those two is the difference between a blip and a server with no way in.
    return null
  }
}

/** Mint one. The `token` in the result is the only time the plaintext will ever exist here. */
export const createAccessToken = async (
  server: ServerConnection,
  label: string,
  scope: AccessToken['scope'],
): Promise<{ ok: true; token: string } | Failure> => {
  try {
    const { response, body } = await adminRequest(server, '/admin/tokens', {
      method: 'POST',
      json: { label, scope },
    })
    const token = isRecord(body) ? body.token : undefined
    if (response.ok && typeof token === 'string') return { ok: true, token }
    return { ok: false, message: failureMessage(response, body) }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

/** Revoke one, by the hash the list gave us. Revocation deletes the stored token row. */
export const revokeAccessToken = (server: ServerConnection, tokenHash: string): Promise<Done> =>
  adminWrite(server, () => `/admin/tokens/${encodeURIComponent(tokenHash)}`, { method: 'DELETE' })
