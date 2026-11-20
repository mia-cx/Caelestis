import { type TemplateSurface, templateSurfaceKey, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'

/**
 * The tree's row keys and server template ids: every constructor and the one parser.
 *
 * Row keys persist in settings (custom order, hidden rows, expanded folders), so their spelling is
 * a storage format. Server-scoped keys carry the server's identity so a different deployment at
 * the same URL cannot inherit another's rows.
 *
 * - `local` — the Local root; `local:<templateId>` a Local template; `lf:<folderId>` a Local folder
 * - `server:<url>` — a server's root
 * - `node:<encoded url>:<serverId>:<season>:<nodeId>` — a server folder
 * - `node:<encoded url>:<nodeId>` — a server folder's switch, which has no row of its own
 * - `st:<encoded url>:<serverId>:<season>:<templateId>` — a server template row
 * - `event:<templateId>`, `native:<templateId>` — Wplace-owned rows
 */

/** What identifies one deployment behind a server URL. */
interface ServerIdentitySource {
  readonly url: string
  readonly info: { readonly id: string } | null
  readonly season: number | null
  readonly lastVerified?: { readonly serverId: string; readonly season: number } | null
}

const UNKNOWN_IDENTITY = 'unknown:unknown'

export const LOCAL_ROOT_KEY = 'local'

/** `serverId:season` of the deployment behind a URL, or null before it was ever verified. */
export const serverIdentity = (server: ServerIdentitySource): string | null => {
  if (server.info !== null && server.season !== null) return `${server.info.id}:${server.season}`
  return server.lastVerified == null
    ? null
    : `${server.lastVerified.serverId}:${server.lastVerified.season}`
}

const scoped = (prefix: 'node' | 'st', server: ServerIdentitySource, id: string): string =>
  `${prefix}:${encodeURIComponent(server.url)}:${serverIdentity(server) ?? UNKNOWN_IDENTITY}:${id}`

export const localTemplateKey = (templateId: string): string => `local:${templateId}`
export const localFolderKey = (folderId: string): string => `lf:${folderId}`
export const serverScopeKey = (serverUrl: string): string => `server:${serverUrl}`
export const nodeTreeKey = (server: ServerIdentitySource, nodeId: string): string =>
  scoped('node', server, nodeId)
export const serverTemplateTreeKey = (server: ServerIdentitySource, templateId: string): string =>
  scoped('st', server, templateId)
/** The switch key of a server folder, isolated from equal ids on another server. */
export const nodeScopeKey = (serverUrl: string, nodeId: string): string =>
  `node:${encodeURIComponent(serverUrl)}:${nodeId}`
export const eventTemplateKey = (templateId: string): string => `event:${templateId}`
export const nativeTemplateKey = (templateId: string): string => `native:${templateId}`

/** Prefix shared by every row key of one server's folders or templates, whatever its identity. */
export const serverRowPrefix = (kind: 'node' | 'st', serverUrl: string): string =>
  `${kind}:${encodeURIComponent(serverUrl)}:`

export type TreeKey =
  | { readonly kind: 'local-root' }
  | { readonly kind: 'local-template'; readonly id: string }
  | { readonly kind: 'local-folder'; readonly id: string }
  | { readonly kind: 'server'; readonly url: string }
  | {
      readonly kind: 'server-node' | 'server-template'
      readonly url: string
      readonly identity: string
      readonly id: string
    }
  | { readonly kind: 'event' | 'native'; readonly id: string }

const afterPrefix = (key: string, prefix: string): string | null =>
  key.startsWith(prefix) ? key.slice(prefix.length) : null

const parseScoped = (rest: string): { url: string; identity: string; id: string } | null => {
  const parts = rest.split(':')
  if (parts.length < 4) return null
  const [encodedUrl, serverId, season] = parts
  try {
    return {
      url: decodeURIComponent(encodedUrl ?? ''),
      identity: `${serverId}:${season}`,
      id: parts.slice(3).join(':'),
    }
  } catch {
    return null
  }
}

/** What a row key names, or null for anything that is not a tree key. */
export const parseTreeKey = (key: string): TreeKey | null => {
  if (key === LOCAL_ROOT_KEY) return { kind: 'local-root' }
  const [prefix] = key.split(':', 1)
  const rest = key.slice((prefix?.length ?? 0) + 1)
  switch (prefix) {
    case 'local':
      return { kind: 'local-template', id: rest }
    case 'lf':
      return { kind: 'local-folder', id: rest }
    case 'server':
      return { kind: 'server', url: rest }
    case 'event':
    case 'native':
      return { kind: prefix, id: rest }
    case 'node':
    case 'st': {
      const scopedKey = parseScoped(rest)
      if (scopedKey === null) return null
      return { kind: prefix === 'node' ? 'server-node' : 'server-template', ...scopedKey }
    }
    default:
      return null
  }
}

/** The template id of a `local:<id>` row key, or null for any other key. */
export const localTemplateIdOf = (key: string): string | null => afterPrefix(key, 'local:')

/** The folder id of an `lf:<id>` row key, or null for any other key. */
export const localFolderIdOf = (key: string): string | null => afterPrefix(key, 'lf:')

/** The URL of a `server:<url>` row key, or null for any other key. */
export const serverUrlOfScopeKey = (key: string): string | null => afterPrefix(key, 'server:')

/**
 * Our id for a server's template, namespaced by owner URL so two servers cannot collide:
 * `srv:<encoded url>:<id>`, with `@<surface>:` before the id off the world surface.
 */
export const serverTemplateKey = (
  serverUrl: string,
  id: string,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): string => {
  const prefix = serverTemplateIdPrefix(serverUrl)
  return surface.kind === 'world'
    ? `${prefix}${id}`
    : `${prefix}@${templateSurfaceKey(surface)}:${id}`
}

/** Prefix shared by every template id one owner URL holds, on any surface. */
export const serverTemplateIdPrefix = (serverUrl: string): string =>
  `srv:${encodeURIComponent(serverUrl)}:`

/** Whether `id` is a server template id, of any server on any surface. */
export const isServerTemplateId = (id: string): boolean => id.startsWith('srv:')

/** A stored switch or preference key that belongs to the server at `url` and nothing else. */
export const isServerOwnedKey = (key: string, url: string): boolean => {
  const singleSegmentAfter = (prefix: string): boolean =>
    key.startsWith(prefix) && key.length > prefix.length && !key.slice(prefix.length).includes(':')
  return (
    key === serverScopeKey(url) ||
    singleSegmentAfter(serverRowPrefix('node', url)) ||
    singleSegmentAfter(serverTemplateIdPrefix(url)) ||
    // Template switches written before server template ids were `srv:` keys.
    singleSegmentAfter(serverRowPrefix('st', url))
  )
}
