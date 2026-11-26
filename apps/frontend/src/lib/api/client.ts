import {
  type AlarmsResponse,
  API_VERSION_PATH,
  type ArchiveHistory,
  type CanvasTilesResponse,
  type ContributionsResponse,
  type HistoryResponse,
  isTransientStatus,
  type LeaderboardResponse,
  LIVE_PROTOCOL_V2,
  liveCredentialProtocol,
  type Manifest,
  type PainterHistoryResponse,
  type PainterTotalsResponse,
  type ProgressHistoryResponse,
  type ProgressWindow,
  resolveServerUrl,
  type ServerAsset,
  type ServerAssetKind,
  type ServerInfo,
  type StatusResponse,
  serverAssetPath,
  type TemplateProgressHistoryResponse,
  type TileHistoryResponse,
  tileImagePath,
  uuidV7,
} from '@caelestis/shared'
import { LIVE_PATH, READ_PROXY, STORAGE_KEYS } from '../deployment.js'
import { sanitizeServerInfo } from '../server-info.js'
import { frontendClientAccept } from './client-metrics.js'

const { server: SERVER_KEY, token: TOKEN_KEY, liveClientId: LIVE_CLIENT_ID_KEY } = STORAGE_KEYS
type ApiVersionPath = typeof API_VERSION_PATH | ''
/** Servers whose `/server` answered only at the unversioned root (see `getServer`). */
const legacyServers = new Set<string>()
const apiVersionPath = (): ApiVersionPath =>
  typeof window !== 'undefined' && legacyServers.has(readServerUrl()) ? '' : API_VERSION_PATH
const DEV_SERVER = 'http://127.0.0.1:8787'
/**
 * A configured server is fixed for the deployment. Without one, the selected server and access
 * token live in localStorage.
 */
const configuredServer =
  (import.meta.env.VITE_CAELESTIS_SERVER as string | undefined)?.replace(/\/+$/, '') || null

export const serverUrlIsConfigured = configuredServer !== null

/**
 * The stored server choice (null for none) and the token that belongs to it. A stored server that
 * no longer resolves (an older dialog accepted URLs with credentials) counts as none, so the dialog
 * can replace it, and its token goes with it: the default server never receives that credential.
 */
const storedConnection = (): { readonly server: string | null; readonly token: string | null } => {
  const token = localStorage.getItem(TOKEN_KEY)
  const stored = serverUrlIsConfigured ? null : localStorage.getItem(SERVER_KEY)
  if (stored === null || stored.length === 0) return { server: null, token }
  try {
    return { server: resolveServerUrl(stored), token }
  } catch {
    return { server: null, token: null }
  }
}

/** The deployment's configured base URL as given, else the stored or default server's. */
export const readServerUrl = (): string =>
  configuredServer ??
  storedConnection().server ??
  resolveServerUrl(import.meta.env.DEV ? DEV_SERVER : window.location.origin)

export const readToken = (): string | null => storedConnection().token

/**
 * Where the browser loads an operator's logo or preview from: the read proxy on the server render
 * and for the configured server, the chosen server's own origin otherwise.
 */
export const serverAssetUrl = (kind: ServerAssetKind, asset: ServerAsset): string => {
  const path = `${apiVersionPath()}${serverAssetPath(kind, asset)}`
  return typeof window === 'undefined' || usesServerReadProxy()
    ? `${READ_PROXY}${path}`
    : `${readServerUrl()}${path}`
}

/** Use the SSR Worker credential only for its configured/default server and never for user choices. */
export const usesServerReadProxy = (): boolean => {
  if (readToken() !== null) return false
  if (serverUrlIsConfigured) return true
  const stored = storedConnection().server
  return stored === null || stored === resolveServerUrl(window.location.origin)
}

/** Throws a TypeError for a server URL that is not HTTP(S) or carries credentials. */
export const writeConnection = (url: string, token: string | null): void => {
  if (!serverUrlIsConfigured) localStorage.setItem(SERVER_KEY, resolveServerUrl(url))
  if (token === null || token.length === 0) localStorage.removeItem(TOKEN_KEY)
  else localStorage.setItem(TOKEN_KEY, token)
}

/** Open live reads through the Worker when it owns the credential. */
export const openLiveSocket = (season: number, admin: boolean): WebSocket => {
  const proxy = usesServerReadProxy()
  const endpoint = new URL(
    `${proxy ? READ_PROXY : readServerUrl()}${apiVersionPath()}${LIVE_PATH}`,
    window.location.href,
  )
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  endpoint.searchParams.set('season', String(season))
  endpoint.searchParams.set('scope', admin ? 'admin' : 'public')
  endpoint.searchParams.set('client', 'frontend')
  endpoint.searchParams.set('stateVector', '1')
  const protocols = [LIVE_PROTOCOL_V2]
  const token = readToken()
  if (!proxy && token !== null) protocols.push(liveCredentialProtocol(token))
  if (!proxy && token === null) {
    let clientId = localStorage.getItem(LIVE_CLIENT_ID_KEY)
    if (clientId === null) {
      clientId = uuidV7()
      localStorage.setItem(LIVE_CLIENT_ID_KEY, clientId)
    }
    endpoint.searchParams.set('clientId', clientId)
  }
  return new WebSocket(endpoint, protocols)
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const retryableMethod = (method: string | undefined): boolean =>
  method === undefined || method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD'

/** One transient edge/backend failure must not strand the app until the user reloads it. */
const fetchWithTransientRetry = async (url: string, init: RequestInit): Promise<Response> => {
  let first: Response
  try {
    first = await fetch(url, init)
  } catch (error) {
    if (!retryableMethod(init.method)) throw error
    return fetch(url, init)
  }
  if (!retryableMethod(init.method) || !isTransientStatus(first.status)) return first
  return fetch(url, init)
}

const request = async (
  path: string,
  init?: RequestInit,
  versionPath: ApiVersionPath = apiVersionPath(),
): Promise<Response> => {
  const token = readToken()
  const proxy = usesServerReadProxy()
  const headers = new Headers(init?.headers)
  const reconciles =
    path === '/manifest' ||
    path.startsWith('/manifest?') ||
    path === '/telemetry/status' ||
    path.startsWith('/telemetry/status?') ||
    path === '/telemetry/alarms' ||
    path.startsWith('/telemetry/alarms?')
  headers.set(
    'accept',
    reconciles ? frontendClientAccept('recovery', 'connect') : frontendClientAccept(),
  )
  if (token !== null) headers.set('authorization', `Bearer ${token}`)
  const endpoint = `${proxy ? READ_PROXY : readServerUrl()}${versionPath}${path}`
  const response = await fetchWithTransientRetry(endpoint, { ...init, headers })
  if (!response.ok) {
    let message = response.statusText
    try {
      const body = (await response.json()) as { error?: string }
      if (typeof body.error === 'string') message = body.error
    } catch {
      // A non-JSON error body keeps the status text.
    }
    throw new ApiError(response.status, message)
  }
  return response
}

const json = async <T>(path: string, versionPath?: ApiVersionPath): Promise<T> =>
  (await request(path, undefined, versionPath)).json() as Promise<T>

/**
 * Read the connected server and learn its API path: servers that predate the versioned API answer
 * 404 there, and every later request to them uses the unversioned root.
 */
export const getServer = async (): Promise<ServerInfo> => {
  const url = readServerUrl()
  legacyServers.delete(url)
  try {
    return sanitizeServerInfo(await json('/server', API_VERSION_PATH))
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error
  }
  const server = await json<ServerInfo>('/server', '')
  legacyServers.add(url)
  return sanitizeServerInfo(server)
}

export const getManifest = (season?: number): Promise<Manifest> =>
  json(season === undefined ? '/manifest' : `/manifest?season=${season}`)

export const getStatus = (season?: number): Promise<StatusResponse> =>
  json(season === undefined ? '/telemetry/status' : `/telemetry/status?season=${season}`)

export const getAlarms = (season?: number): Promise<AlarmsResponse> =>
  json(season === undefined ? '/telemetry/alarms' : `/telemetry/alarms?season=${season}`)

/** `/server` deliberately exposes no caller scope, so admin admission is probed explicitly. */
export const probeAdminScope = async (season: number): Promise<boolean> => {
  try {
    await request(`/admin/nodes?season=${season}`)
    return true
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false
    throw error
  }
}

/** Read canvas observations for one immutable artwork version, independently of placement pace. */
export const getProgressHistory = (
  templateId: string,
  versionId: string,
  from: number,
  to: number,
): Promise<ProgressHistoryResponse> =>
  json(
    `/telemetry/progress/${encodeURIComponent(templateId)}?version=${encodeURIComponent(versionId)}&from=${from}&to=${to}`,
  )

/** Read the observations recorded throughout a template's life, across artwork replacements. */
export const getTemplateProgressHistory = (
  templateId: string,
  from: number,
  to: number,
  notBefore?: number,
): Promise<TemplateProgressHistoryResponse> =>
  json(
    `/telemetry/progress/${encodeURIComponent(templateId)}?from=${from}&to=${to}${notBefore === undefined ? '' : `&notBefore=${notBefore}`}`,
  )

export const getHistory = (
  templateIds: readonly string[],
  from: number,
  to: number,
  options: { readonly maxResolution?: number } = {},
): Promise<HistoryResponse> =>
  json(
    `/telemetry/history?templateIds=${templateIds.map(encodeURIComponent).join(',')}` +
      `&from=${from}&to=${to}` +
      (options.maxResolution === undefined ? '' : `&maxResolution=${options.maxResolution}`),
  )

/** Who painted in a range and how much, leading first: the list to pick painters from. */
export const getPainterTotals = (
  templateIds: readonly string[],
  from: number,
  to: number,
  options: {
    readonly limit?: number
    readonly windows?: readonly (ProgressWindow & { readonly id: string })[]
  } = {},
): Promise<PainterTotalsResponse> => {
  const windows = (options.windows ?? [])
    .filter(({ start, end }) => start !== null || end !== null)
    .map(({ id, start, end }) => `${id}:${start ?? ''}:${end ?? ''}`)
  return json(
    `/telemetry/painters?templateIds=${templateIds.map(encodeURIComponent).join(',')}` +
      `&from=${from}&to=${to}` +
      (options.limit === undefined ? '' : `&limit=${options.limit}`) +
      (windows.length === 0 ? '' : `&windows=${encodeURIComponent(windows.join(','))}`),
  )
}

/**
 * The named painters' buckets on the same ladder as `getHistory`, so painter lines share its
 * precision. Bounded by the painter list, not by the scope's age.
 */
export const getPainterHistory = (
  templateIds: readonly string[],
  painters: readonly number[],
  from: number,
  to: number,
  options: { readonly maxResolution?: number } = {},
): Promise<PainterHistoryResponse> =>
  json(
    `/telemetry/painter-history?templateIds=${templateIds.map(encodeURIComponent).join(',')}` +
      `&painters=${painters.join(',')}&from=${from}&to=${to}` +
      (options.maxResolution === undefined ? '' : `&maxResolution=${options.maxResolution}`),
  )

export const getContributions = (
  templateIds: readonly string[],
  from: number,
  to: number,
): Promise<ContributionsResponse> =>
  json(
    `/telemetry/contributions?templateIds=${templateIds.map(encodeURIComponent).join(',')}` +
      `&from=${from}&to=${to}`,
  )

export const getLeaderboard = (
  season: number,
  options: { templateIds?: readonly string[]; from?: number; to?: number; limit?: number } = {},
): Promise<LeaderboardResponse> => {
  const params = new URLSearchParams({ season: String(season) })
  if (options.templateIds !== undefined) params.set('templateIds', options.templateIds.join(','))
  if (options.from !== undefined) params.set('from', String(options.from))
  if (options.to !== undefined) params.set('to', String(options.to))
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  return json(`/telemetry/leaderboard?${params}`)
}

export const getCanvas = (season: number): Promise<CanvasTilesResponse> =>
  json(`/telemetry/canvas?season=${season}`)

export const getTileHistory = (
  x: number,
  y: number,
  season: number,
  from: number,
  to: number,
): Promise<TileHistoryResponse> =>
  json(`/telemetry/tiles/${x}/${y}/history?season=${season}&from=${from}&to=${to}`)

/**
 * `/chunks` and `/tiles` require a bearer token, which an `<img src>` cannot carry, so an image is
 * fetched as a blob behind an object URL. The caller owns the URL; `render.ts` caches the decoded
 * image and revokes it.
 */
const loadImageUrl = async (path: string): Promise<string> =>
  URL.createObjectURL(await (await request(path)).blob())

export const chunkImageUrl = (hash: string): Promise<string> => loadImageUrl(`/chunks/${hash}`)
export const tileImageUrl = (hash: string): Promise<string> =>
  loadImageUrl(`/${tileImagePath(hash)}`)

/** Read sparse observations, treating older backends without this route as no archive. */
export const getArchiveHistory = async (
  templateId: string,
  version: string,
  tile?: { x: number; y: number },
): Promise<ArchiveHistory> => {
  const query = new URLSearchParams({ version })
  if (tile !== undefined) {
    query.set('x', String(tile.x))
    query.set('y', String(tile.y))
  }
  try {
    return await json(`/archive/templates/${templateId}?${query}`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404)
      return { source: 'eralyon', basis: null, samples: [], frames: [] }
    throw error
  }
}
