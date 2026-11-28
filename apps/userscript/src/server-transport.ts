import { anySignal } from './any-signal.js'
import { userscriptClientHeaders } from './client-metrics.js'
import { discardResponseBody, readBoundedJsonResponse } from './response.js'

/**
 * HTTP to a Caelestis server, before any connection exists: one bounded, timed, retryable request.
 * `serverRequest` adds a connection's address, credential and lifetime on top of this.
 */

const MIB = 1024 * 1024

/** Body budget and deadline for each kind of exchange. The deadline covers reading the body. */
export const SERVER_LIMITS = {
  /** Public metadata such as `GET /server`. */
  metadata: { maxBytes: 16 * 1024, timeoutMs: 10_000 },
  /** Admin writes and their one-line replies. */
  mutation: { maxBytes: 64 * 1024, timeoutMs: 10_000 },
  /** Manifests, folder lists and other whole-tree reads. */
  tree: { maxBytes: 64 * MIB, timeoutMs: 120_000 },
  /** Multipart and binary uploads, whose request rather than reply is large. */
  upload: { maxBytes: 64 * 1024, timeoutMs: 120_000 },
  /** Reads and writes an open dialog waits on, such as authoring sources and backfill steps. */
  interactive: { maxBytes: 64 * MIB, timeoutMs: 30_000 },
  /**
   * Work nobody waits on: telemetry reports and snapshots, mismatch masks and chunks. A short
   * deadline keeps a stalled server from holding the next poll back.
   */
  background: { maxBytes: 64 * MIB, timeoutMs: 15_000 },
} as const

export type ServerLimits = keyof typeof SERVER_LIMITS

/** How the body is read: parsed JSON, raw bytes, or thrown away unread. */
export type ServerRead = 'json' | 'bytes' | 'discard'

export type ServerBody<Read extends ServerRead> = Read extends 'bytes'
  ? Uint8Array<ArrayBuffer>
  : Read extends 'discard'
    ? null
    : unknown

export interface ServerResponse<Read extends ServerRead> {
  readonly response: Response
  readonly body: ServerBody<Read>
}

interface TransportOptions<Read extends ServerRead> {
  readonly limits: ServerLimits
  /** A tighter body budget than the limits allow, such as what is left of a transfer budget. */
  readonly maxBytes?: number
  readonly read: Read
  /** Retry a network failure or 5xx answer, with backoff; see {@link RETRY_ATTEMPTS}. */
  readonly retry?: boolean
}

/** Every request the userscript retries gets this many attempts, the first one included. */
export const RETRY_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 250

const retryDelay = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** attempt))

/**
 * Run `attempt` up to {@link RETRY_ATTEMPTS} times while `again` says its result failed for a
 * reason worth repeating. A request or delivery is idempotent wherever this is used: the next
 * attempt carries the same event id, delivery id or tile hash.
 */
export const withRetries = async <Result>(
  attempt: () => Promise<Result>,
  again: (result: Result) => boolean,
): Promise<Result> => {
  for (let tried = 1; ; tried++) {
    const result = await attempt()
    if (tried >= RETRY_ATTEMPTS || !again(result)) return result
    await retryDelay(tried - 1)
  }
}

const readBoundedBytes = async (
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> => {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardResponseBody(response)
    throw new RangeError(`response exceeds ${maxBytes} bytes`)
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > maxBytes) {
        await reader.cancel()
        throw new RangeError(`response exceeds ${maxBytes} bytes`)
      }
      parts.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

const readers: {
  readonly [Read in ServerRead]: (response: Response, maxBytes: number) => Promise<ServerBody<Read>>
} = {
  json: readBoundedJsonResponse,
  bytes: readBoundedBytes,
  discard: async (response) => {
    await discardResponseBody(response)
    return null
  },
}

const sendOnce = async <Read extends ServerRead>(
  input: string,
  init: RequestInit,
  options: TransportOptions<Read>,
): Promise<ServerResponse<Read>> => {
  const { maxBytes, timeoutMs } = SERVER_LIMITS[options.limits]
  const signal = anySignal([
    ...(init.signal == null ? [] : [init.signal]),
    AbortSignal.timeout(timeoutMs),
  ])
  const headers = new Headers(init.headers)
  if (!headers.has('accept')) headers.set('accept', userscriptClientHeaders().accept ?? '*/*')
  const response = await fetch(input, { ...init, headers, signal })
  const read: (response: Response, maxBytes: number) => Promise<ServerBody<Read>> =
    readers[options.read]
  return { response, body: await read(response, Math.min(maxBytes, options.maxBytes ?? maxBytes)) }
}

/** One request, bounded by `options.limits`; throws on a network failure, timeout or abort. */
export const sendServerRequest = <Read extends ServerRead>(
  input: string,
  init: RequestInit,
  options: TransportOptions<Read>,
): Promise<ServerResponse<Read>> => {
  if (options.retry !== true) return sendOnce(input, init, options)
  let failure: unknown = null
  return withRetries(
    async () => {
      try {
        failure = null
        return await sendOnce(input, init, options)
      } catch (error) {
        if (init.signal?.aborted) throw error
        failure = error
        return null
      }
    },
    (result) => result === null || result.response.status >= 500,
  ).then((result) => {
    if (result === null) throw failure
    return result
  })
}
