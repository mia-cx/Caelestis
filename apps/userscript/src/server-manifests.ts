import {
  type ReconciliationReason,
  type SyncTransport,
  type TemplateSurface,
  templateSurfaceKey,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { warn } from './debug.js'
import { PerServerMap } from './per-server-map.js'
import { cacheServer, forgetServer, loadServerCache } from './server-cache.js'
import {
  type ConnectedServer,
  isConnected,
  isCurrentServerConnection,
  noteAuthFailure,
  onServerRemoved,
  serverConnectionIdentity,
  serverConnectionSignal,
  takeProbedManifest,
  upsertServer,
} from './server-connections.js'
import {
  MAX_MANIFEST_CHUNKS,
  MAX_MANIFEST_TEMPLATES,
  MAX_TREE_NODES,
  parseServerManifest,
  type ServerInfo,
  type ServerManifest,
  type ServerTemplate,
  type TreeNode,
} from './server-manifest.js'
import { coalesceServerRead } from './server-read-coalescer.js'
import { serverRequest } from './server-request.js'
import { withManifestReadSlot } from './server-transport.js'
import { getState, type ServerConnection } from './settings.js'
import { serverIdentity } from './tree-keys.js'

/**
 * The one copy of every server manifest this client holds, per server and drawing surface.
 *
 * Every read, live snapshot and probe of a manifest lands here: it is ordered against the other
 * responses for the same surface, admitted against the client's memory budget, and kept until a
 * newer one, the surface's retirement or the server's removal replaces it. The tree, the canvas,
 * folder visibility and telemetry coverage all read their views from it, and learn of changes
 * through {@link onManifestChange}.
 *
 * Anyone with a read code may read a manifest: the structure is not privileged information, and
 * the admin boundary is *changing* it on the `/admin` routes.
 */

/** One manifest's folders and templates, with the revisions the coordinator schedules by. */
export interface ServerContents {
  readonly workRevision?: number
  /** Opaque manifest revision, retained so the coordinator can back off while it is unchanged. */
  readonly revision?: string
  readonly nodes: readonly TreeNode[]
  readonly templates: readonly ServerTemplate[]
}

/**
 * The tiles a server's world templates cover. The same object while a revisioned manifest covers
 * the same tiles, so it can stand for "what was read against this coverage".
 */
export interface ManifestCoverage {
  readonly tiles: ReadonlySet<string>
}

/** What became of one manifest response. */
export type ManifestAdmission =
  | {
      readonly status: 'admitted'
      /** Whether its rows differ from the ones it replaced. */
      readonly changed: boolean
      readonly contents: ServerContents
      /** The ordering number of the response that admitted it. */
      readonly response: number
      /** Whether it is still the admitted manifest for its connection and surface. */
      readonly current: () => boolean
    }
  | { readonly status: 'refused' | 'superseded'; readonly message: string }

/** What {@link onManifestChange} reports: an admission or refusal, or rows forgotten. */
export type ManifestChange =
  | Exclude<ManifestAdmission, { readonly status: 'superseded' }>
  | { readonly status: 'forgotten' }

interface Held {
  /** `serverId:season` of the deployment the rows came from. */
  readonly identity: string
  /** The connection that admitted them; null for rows restored from the cache. */
  readonly owner: ServerConnection | null
  readonly contents: ServerContents
  readonly response: number
  readonly parents: ReadonlyMap<string, string | null>
  readonly coverage: ManifestCoverage
}

type ChangeListener = (
  server: ServerConnection,
  surface: TemplateSurface,
  change: ManifestChange,
) => void

const held = new PerServerMap<Held>()
/** The newest response number per surface; an older response arriving later is superseded. */
const latestResponse = new PerServerMap<number>()
/** Moves each time a surface is forgotten, superseding every read started before. */
const surfaceEpochs = new Map<string, number>()
const admissions = new WeakMap<ServerContents, ManifestAdmission>()
const listeners = new Set<ChangeListener>()
let nodesRevision = 0

const keyOf = templateSurfaceKey

const emit = (server: ServerConnection, surface: TemplateSurface, change: ManifestChange): void => {
  for (const listener of listeners) {
    try {
      listener(server, surface, change)
    } catch (error) {
      warn('manifest observer failed', String(error))
    }
  }
}

/** Observe every admission, refusal and forgotten surface, whichever read or event caused it. */
export const onManifestChange = (listener: ChangeListener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The rows behind one server's tree on one surface: the newest admitted or cached manifest of the
 * deployment the server row names. Undefined until one has arrived.
 */
export const manifestRows = (
  server: ServerConnection,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): ServerContents | undefined => {
  const entry = held.get(server.url, keyOf(surface))
  return entry !== undefined && entry.identity === serverIdentity(server)
    ? entry.contents
    : undefined
}

const admittedEntry = (server: ServerConnection, surface: TemplateSurface): Held | undefined => {
  const entry = held.get(server.url, keyOf(surface))
  return entry?.owner != null &&
    isCurrentServerConnection(server) &&
    isCurrentServerConnection(entry.owner)
    ? entry
    : undefined
}

/**
 * The manifest admitted through this exact connection lifetime, which actions and the canvas act
 * on. Rows restored from the cache, or admitted by an earlier connection, are not.
 */
export const admittedManifest = (
  server: ServerConnection,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): ServerContents | null => admittedEntry(server, surface)?.contents ?? null

/** The world tiles this connection's admitted manifest covers. */
export const manifestCoverage = (server: ServerConnection): ManifestCoverage | null =>
  admittedEntry(server, WORLD_TEMPLATE_SURFACE)?.coverage ?? null

/** Parent of each folder on one surface, in manifest order. Null means the surface's top level. */
export const manifestParents = (
  serverUrl: string,
  surface: TemplateSurface,
): ReadonlyMap<string, string | null> | undefined => held.get(serverUrl, keyOf(surface))?.parents

/** Moves whenever any held folder tree does. */
export const manifestNodesRevision = (): number => nodesRevision

/** What became of the response that produced `contents`. */
export const manifestAdmission = (contents: ServerContents): ManifestAdmission | undefined =>
  admissions.get(contents)

const parentsOf = (nodes: readonly TreeNode[]): ReadonlyMap<string, string | null> =>
  new Map(nodes.map((node) => [node.id, node.parentId]))

const tilesOf = (templates: readonly ServerTemplate[]): ReadonlySet<string> =>
  new Set(templates.flatMap((template) => template.chunks.map((chunk) => chunk.tile)))

const sameNode = (left: TreeNode, right: TreeNode): boolean =>
  JSON.stringify(left.tags ?? []) === JSON.stringify(right.tags ?? []) &&
  left.id === right.id &&
  left.parentId === right.parentId &&
  left.path === right.path &&
  left.name === right.name &&
  left.createdAt === right.createdAt

const sameTemplate = (left: ServerTemplate, right: ServerTemplate): boolean =>
  left.id === right.id &&
  left.nodeId === right.nodeId &&
  left.name === right.name &&
  left.version === right.version &&
  left.totalPixels === right.totalPixels &&
  left.published === right.published &&
  left.updatedAt === right.updatedAt &&
  left.bbox.minX === right.bbox.minX &&
  left.bbox.minY === right.bbox.minY &&
  left.bbox.maxX === right.bbox.maxX &&
  left.bbox.maxY === right.bbox.maxY &&
  left.chunks.length === right.chunks.length &&
  left.chunks.every(
    (chunk, index) =>
      chunk.tile === right.chunks[index]?.tile && chunk.hash === right.chunks[index]?.hash,
  )

const sameRows = <T>(
  left: readonly T[],
  right: readonly T[],
  same: (left: T, right: T) => boolean,
): boolean =>
  left.length === right.length && left.every((entry, index) => same(entry, right[index] as T))

/** Why `contents` would push everything held past the client's memory budget, if it would. */
const budgetRefusal = (
  serverUrl: string,
  surfaceKey: string,
  contents: ServerContents,
): string | null => {
  let nodes = contents.nodes.length
  let templates = contents.templates.length
  let chunks = contents.templates.reduce((total, template) => total + template.chunks.length, 0)
  for (const [url, key, entry] of held.all()) {
    if (url === serverUrl && key === surfaceKey) continue
    nodes += entry.contents.nodes.length
    templates += entry.contents.templates.length
    chunks += entry.contents.templates.reduce(
      (total, template) => total + template.chunks.length,
      0,
    )
  }
  if (nodes > MAX_TREE_NODES)
    return `Connected server folders exceed the ${MAX_TREE_NODES.toLocaleString()}-node client limit.`
  if (templates > MAX_MANIFEST_TEMPLATES || chunks > MAX_MANIFEST_CHUNKS)
    return 'Connected server templates exceed the client manifest memory budget.'
  return null
}

/** Adopt release metadata a manifest carries without replacing the connection. */
const refreshServerRelease = (server: ConnectedServer, release: ServerInfo): ConnectedServer => {
  if (server.info.version === release.version && server.info.build === release.build) return server
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

/**
 * Order, admit and announce one parsed manifest. Null when a newer response for the same surface
 * already arrived, or the connection it came through has ended.
 */
const admit = (
  server: ConnectedServer,
  surface: TemplateSurface,
  manifest: ServerManifest,
  response: number,
): ServerContents | null => {
  const key = keyOf(surface)
  if (!isCurrentServerConnection(server) || response <= (latestResponse.get(server.url, key) ?? 0))
    return null
  latestResponse.set(server.url, key, response)
  const owner = refreshServerRelease(server, manifest.server)
  const contents: ServerContents = {
    revision: manifest.version,
    ...(manifest.workRevision === undefined ? {} : { workRevision: manifest.workRevision }),
    nodes: manifest.nodes,
    templates: manifest.templates,
  }
  const refusal = budgetRefusal(server.url, key, contents)
  if (refusal !== null) {
    const refused = { status: 'refused', message: refusal } as const
    admissions.set(contents, refused)
    emit(owner, surface, refused)
    return contents
  }
  const identity = `${owner.info.id}:${owner.season}`
  const previous = held.get(server.url, key)
  const changed =
    previous === undefined ||
    previous.identity !== identity ||
    !sameRows(previous.contents.nodes, contents.nodes, sameNode) ||
    !sameRows(previous.contents.templates, contents.templates, sameTemplate)
  const tiles = tilesOf(contents.templates)
  const previousTiles = previous?.coverage.tiles
  // An unchanged revision covering the same tiles keeps its coverage object, so alarms read
  // against it stay valid; anything else is new coverage.
  const sameCoverage =
    previous?.owner != null &&
    isCurrentServerConnection(previous.owner) &&
    contents.revision !== undefined &&
    previous.contents.revision === contents.revision &&
    previousTiles?.size === tiles.size &&
    [...previousTiles].every((tile) => tiles.has(tile))
  held.set(server.url, key, {
    identity,
    owner,
    contents,
    response,
    parents: changed || previous === undefined ? parentsOf(contents.nodes) : previous.parents,
    coverage: sameCoverage && previous !== undefined ? previous.coverage : { tiles },
  })
  if (changed) {
    nodesRevision++
    // The cache keeps only the published part; see `cacheServer`.
    if (surface.kind === 'world')
      void cacheServer({
        url: owner.url,
        serverId: owner.info.id,
        season: owner.season,
        nodes: contents.nodes,
        templates: contents.templates,
        fetchedAt: Date.now(),
      })
  }
  const admitted: ManifestAdmission = {
    status: 'admitted',
    changed,
    contents,
    response,
    current: () =>
      held.get(server.url, key)?.response === response &&
      admittedEntry(server, surface) !== undefined,
  }
  admissions.set(contents, admitted)
  emit(owner, surface, admitted)
  return contents
}

/** A response that a newer one or a retired surface overtook: its rows, recorded as superseded. */
const superseded = (manifest: ServerManifest): ServerContents => {
  const contents: ServerContents = {
    revision: manifest.version,
    nodes: manifest.nodes,
    templates: manifest.templates,
  }
  admissions.set(contents, { status: 'superseded', message: 'A newer manifest replaced this one.' })
  return contents
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

export interface ManifestReadOptions {
  readonly surface?: TemplateSurface
  /** Stops waiting for the read; a read other callers share keeps going. */
  readonly signal?: AbortSignal
  readonly reason?: ReconciliationReason
  readonly transport?: SyncTransport
}

/**
 * Read one surface's manifest and admit it. Answers the parsed manifest, whatever became of it
 * (see {@link manifestAdmission}), or null when the server could not be read or answered nothing
 * usable. Reads by every caller on the same connection and surface share one request.
 */
export const readManifest = async (
  server: ServerConnection,
  options: ManifestReadOptions = {},
): Promise<ServerContents | null> => {
  if (!isConnected(server) || !isCurrentServerConnection(server)) return null
  const { surface = WORLD_TEMPLATE_SURFACE, signal } = options
  const { info, season } = server
  const epoch = surfaceEpochs.get(keyOf(surface)) ?? 0
  try {
    const read = coalesceServerRead(
      serverConnectionIdentity(server),
      `${season}\u0000${keyOf(surface)}\u0000manifest`,
      async (): Promise<ServerContents | null> => {
        const { response, body, sequence } = await withManifestReadSlot(
          serverConnectionSignal(server),
          () => isCurrentServerConnection(server),
          async (sequence) => ({
            ...(await serverRequest(server, '/manifest', {
              query:
                surface.kind === 'world'
                  ? { season }
                  : { season, surface: surface.kind, allianceId: String(surface.allianceId) },
              limits: 'tree',
              read: 'json',
              metrics: {
                transport: options.transport ?? 'compatibility-poll',
                reason: options.reason ?? 'unknown',
              },
            })),
            sequence,
          }),
        )
        if (response.status === 401 || response.status === 403)
          noteAuthFailure(server, response.status)
        if (!response.ok) return null
        const manifest = parseServerManifest(body, info, surface)
        if (manifest === null || manifest.season !== season) return null
        const retired = (surfaceEpochs.get(keyOf(surface)) ?? 0) !== epoch
        return (retired ? null : admit(server, surface, manifest, sequence)) ?? superseded(manifest)
      },
    )
    if (signal === undefined) return await read
    if (signal.aborted) return null
    return await awaitReadOrAbort(read, signal)
  } catch {
    return null
  }
}

/** Admit one authenticated live manifest after every response already received. */
export const applyLiveManifest = (
  server: ServerConnection,
  surface: TemplateSurface,
  body: unknown,
): ServerContents | null => {
  if (!isConnected(server) || !isCurrentServerConnection(server)) return null
  const manifest = parseServerManifest(body, server.info, surface)
  if (manifest === null || manifest.season !== server.season) return null
  return admit(server, surface, manifest, (latestResponse.get(server.url, keyOf(surface)) ?? 0) + 1)
}

/**
 * Start a connection from the manifest its probe downloaded to verify the credential.
 *
 * Connecting reads `/manifest` to prove the code works, and the first sync wanted the same manifest
 * moments later. Adopting the probe's copy makes it that first read, so a page load downloads each
 * manifest once. One use only, and never once a newer response has arrived: a later read must
 * fetch, because a mutation may have changed the manifest since.
 */
export const adoptProbedManifest = (server: ConnectedServer): ServerContents | null => {
  const probed = takeProbedManifest(server.url)
  if (probed === undefined || probed.manifest.season !== server.season) return null
  return admit(server, WORLD_TEMPLATE_SURFACE, probed.manifest, probed.request)
}

/**
 * Replace one surface's held rows in place, keeping their admission: an optimistic edit the server
 * has confirmed, ahead of the manifest that will carry it.
 */
export const amendManifestRows = (
  server: ServerConnection,
  surface: TemplateSurface,
  amend: (contents: ServerContents) => ServerContents,
): void => {
  const key = keyOf(surface)
  const entry = held.get(server.url, key)
  if (entry === undefined || entry.identity !== serverIdentity(server)) return
  const contents = amend(entry.contents)
  held.set(server.url, key, { ...entry, contents, parents: parentsOf(contents.nodes) })
  nodesRevision++
}

/**
 * Forget every server's rows on a surface nobody draws any more. Reads still in flight for it are
 * superseded, so none of them can bring the rows back.
 */
export const forgetManifestSurface = (surface: TemplateSurface): void => {
  const key = keyOf(surface)
  surfaceEpochs.set(key, (surfaceEpochs.get(key) ?? 0) + 1)
  for (const server of getState().servers) {
    if (!held.delete(server.url, key)) continue
    nodesRevision++
    emit(server, surface, { status: 'forgotten' })
  }
}

/**
 * Draw what a server said last time, immediately, before anything is fetched.
 *
 * Without it the tree is empty on every page load until each server answers, which is the wrong
 * first impression and gets worse the more servers are connected. The folder tree comes with it,
 * so a template restored into a folder switched off last session stays hidden.
 *
 * Reads only verified servers whose rows are still missing, so once the cache or the network has
 * filled them, later calls skip IndexedDB. A read that found nothing, or failed, is retried on the
 * next call; the panel calls this when it opens and when the server list changes. Redraws only
 * when the cache filled in rows.
 */
export const primeFromCache = async (rerender: () => void): Promise<void> => {
  const missing = (server: ServerConnection): boolean =>
    server.lastVerified != null && manifestRows(server) === undefined
  const servers = getState().servers.filter(missing)
  if (servers.length === 0) return
  let filled = false
  for (const entry of await loadServerCache(servers.map((server) => server.url))) {
    const server = servers.find((candidate) => candidate.url === entry.url)
    const identity = server?.lastVerified
    if (
      server === undefined ||
      identity == null ||
      identity.serverId !== entry.serverId ||
      identity.season !== entry.season ||
      // A network answer that landed during the read is newer than anything cached.
      !missing(server)
    )
      continue
    const templates = entry.templates ?? []
    held.set(server.url, keyOf(WORLD_TEMPLATE_SURFACE), {
      identity: `${entry.serverId}:${entry.season}`,
      owner: null,
      contents: { nodes: entry.nodes, templates },
      response: 0,
      parents: parentsOf(entry.nodes),
      coverage: { tiles: tilesOf(templates) },
    })
    nodesRevision++
    filled = true
  }
  if (filled) rerender()
}

// Response numbers are process-wide and increasing, so an old response can never tie a request
// made after this URL reconnects. Only the answers belonging to the ended connection go.
onServerRemoved(async (serverUrl) => {
  latestResponse.forget(serverUrl)
  const forgotten = held.forget(serverUrl)
  if (forgotten.size > 0) nodesRevision++
  await forgetServer(serverUrl)
})
