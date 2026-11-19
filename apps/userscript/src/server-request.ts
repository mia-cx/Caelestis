import type { ReconciliationReason, SyncTransport } from '@caelestis/shared'
import { userscriptClientHeaders } from './client-metrics.js'
import { activeServerToken, bearer, serverConnectionSignal } from './server-connections.js'
import {
  type ServerLimits,
  type ServerRead,
  type ServerResponse,
  sendServerRequest,
} from './server-transport.js'
import { endpointUrl } from './server-url.js'
import { getState, type ServerConnection } from './settings.js'

export interface ServerRequestOptions<Read extends ServerRead> {
  readonly method?: string
  readonly query?: Readonly<Record<string, string | number>> | URLSearchParams
  /** Sent as `application/json`. */
  readonly json?: unknown
  readonly body?: BodyInit
  /** Extra headers; the credential and client metrics are added here, not by callers. */
  readonly headers?: Readonly<Record<string, string>>
  readonly limits: ServerLimits
  readonly read: Read
  readonly maxBytes?: number
  readonly retry?: boolean
  /** Ends the request early, in addition to the connection's own lifetime. */
  readonly signal?: AbortSignal
  /** Why and how this read was made, reported to the server's client metrics. */
  readonly metrics?: { readonly transport: SyncTransport; readonly reason: ReconciliationReason }
}

/**
 * The URL of `route` on the server configured at `serverUrl`, through the API version its probe
 * found. A URL with no configured row resolves through the current `/v1` API.
 */
export const serverEndpoint = (serverUrl: string, route: string): string =>
  endpointUrl(
    serverUrl,
    route,
    getState().servers.find((server) => server.url === serverUrl)?.apiVersion ?? 'v1',
  )

/**
 * One request to a connected server: its address and API version, its credential, client metrics,
 * the limits' body budget and deadline, and an abort when the connection ends. Throws on a network
 * failure, timeout, or abort; an HTTP error comes back as a response.
 */
export const serverRequest = <Read extends ServerRead>(
  server: ServerConnection,
  route: string,
  options: ServerRequestOptions<Read>,
): Promise<ServerResponse<Read>> => {
  const query =
    options.query === undefined
      ? ''
      : `${new URLSearchParams(
          options.query instanceof URLSearchParams
            ? options.query
            : Object.entries(options.query).map(([name, value]) => [name, String(value)]),
        )}`
  const headers: Record<string, string> = {
    ...userscriptClientHeaders(options.metrics),
    ...bearer(activeServerToken(server)),
    ...(options.json === undefined ? {} : { 'content-type': 'application/json' }),
    ...options.headers,
  }
  const lifetime = serverConnectionSignal(server)
  return sendServerRequest(
    endpointUrl(server.url, query === '' ? route : `${route}?${query}`, server.apiVersion),
    {
      ...(options.method === undefined ? {} : { method: options.method }),
      headers,
      ...(options.json !== undefined
        ? { body: JSON.stringify(options.json) }
        : options.body === undefined
          ? {}
          : { body: options.body }),
      signal: options.signal === undefined ? lifetime : AbortSignal.any([lifetime, options.signal]),
    },
    {
      limits: options.limits,
      read: options.read,
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
    },
  )
}
