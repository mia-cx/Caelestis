import { type PaintEvent, seconds, tileKey, uuidV7 } from '@caelestis/shared'
import { warn } from './debug.js'
import { requestLivePaint, serverLiveSyncVersion } from './live-socket.js'
import { type AcceptedPaint, onAcceptedPaint } from './paint-requests.js'
import {
  type ConnectedServer,
  connectedServers,
  isCurrentServerConnection,
  onServerRemoved,
} from './server-connections.js'
import { manifestCoverage } from './server-manifests.js'
import { serverRequest } from './server-request.js'
import { withRetries } from './server-transport.js'
import { getState } from './settings.js'
import { accountIdentity, loadAccount } from './wplace-account.js'

/**
 * Reporting the paints Wplace accepted to every connected server whose templates cover them.
 *
 * Each paint gets one event id, so a repeat after a lost acknowledgement is a duplicate the server
 * recognises. Recent paints are replayed when a server's coverage changes or it reconnects.
 */

const MAX_RECENT_PAINTS = 64
const MAX_DEDUPE_VALUES = 4_096
const MUTATION_REPLY_BYTES = 64 * 1024
/** A live paint the socket could not take is offered again after this long. */
const LIVE_RETRY_MS = 1_000

interface ObservedPaint {
  readonly eventId: string
  readonly paint: AcceptedPaint
}

/** Event ids recently sent to one connection: reported, still in flight, and owed a repeat. */
interface ServerDedupe {
  readonly server: ConnectedServer
  readonly values: Set<string>
  readonly active: Set<string>
  readonly pending: Set<string>
}

const reportedPaints = new Map<string, ServerDedupe>()
const recentPaints: ObservedPaint[] = []

onServerRemoved((serverUrl) => {
  reportedPaints.delete(serverUrl)
})

const reportError = (error: unknown): void => {
  warn('paint report failed', String(error))
}

/** Remember bounded recent event ids; old values may safely be reported again after eviction. */
const rememberDedupe = (dedupe: ServerDedupe, value: string): void => {
  if (dedupe.values.has(value)) return
  while (dedupe.values.size >= MAX_DEDUPE_VALUES) {
    const oldest = dedupe.values.values().next()
    if (oldest.done) break
    dedupe.values.delete(oldest.value)
    dedupe.active.delete(oldest.value)
    dedupe.pending.delete(oldest.value)
  }
  dedupe.values.add(value)
}

const deliverPaint = async (
  server: ConnectedServer,
  dedupe: ServerDedupe,
  eventId: string,
  event: PaintEvent,
): Promise<void> => {
  if (serverLiveSyncVersion(server) === 2) {
    const result = await withRetries(
      () => requestLivePaint(server, event),
      (delivered) => delivered === null,
    )
    dedupe.active.delete(eventId)
    if (result !== null && result.error === undefined) {
      dedupe.pending.delete(eventId)
      return
    }
    if (
      (result === null || result.error === 'unavailable') &&
      dedupe.values.has(eventId) &&
      getState().reportPaints &&
      isCurrentServerConnection(server)
    ) {
      setTimeout(() => {
        if (dedupe.active.has(eventId) || !dedupe.values.has(eventId)) return
        dedupe.active.add(eventId)
        void deliverPaint(server, dedupe, eventId, event).catch(reportError)
      }, LIVE_RETRY_MS)
    } else {
      dedupe.values.delete(eventId)
      if (result?.error !== undefined)
        warn('telemetry paint report was rejected', {
          server: server.url,
          eventId,
          error: result.error,
        })
    }
    return
  }
  const response =
    (
      await serverRequest(server, '/telemetry/paints', {
        method: 'POST',
        json: event,
        limits: 'background',
        read: 'json',
        retry: true,
        maxBytes: MUTATION_REPLY_BYTES,
      }).catch(() => null)
    )?.response ?? null
  dedupe.active.delete(eventId)
  if (response?.ok) {
    dedupe.pending.delete(eventId)
    return
  }
  // A paint observed again while this report was in flight is owed one more attempt.
  const replay =
    dedupe.pending.delete(eventId) &&
    dedupe.values.has(eventId) &&
    getState().reportPaints &&
    isCurrentServerConnection(server)
  if (replay) {
    dedupe.active.add(eventId)
    queueMicrotask(() => void deliverPaint(server, dedupe, eventId, event).catch(reportError))
  } else dedupe.values.delete(eventId)
  if (response !== null)
    warn('telemetry paint report was rejected', {
      server: server.url,
      status: response.status,
    })
}

const reportPaint = async ({ eventId, paint }: ObservedPaint): Promise<void> => {
  if (!getState().reportPaints) return
  await loadAccount()
  const identity = accountIdentity()
  if (identity === null) return
  const submitted = paint.tiles.reduce((total, tile) => total + tile.pixels.x.length, 0)
  await Promise.all(
    connectedServers().map(async (server) => {
      const coverage = manifestCoverage(server)
      if (server.season !== paint.season || coverage === null) return
      const tiles = paint.tiles.filter((tile) => coverage.tiles.has(tileKey(tile)))
      if (tiles.length === 0) return
      const previous = reportedPaints.get(server.url)
      const dedupe =
        previous !== undefined && isCurrentServerConnection(previous.server)
          ? previous
          : {
              server,
              values: new Set<string>(),
              active: new Set<string>(),
              pending: new Set<string>(),
            }
      if (dedupe.values.has(eventId)) {
        if (dedupe.active.has(eventId)) dedupe.pending.add(eventId)
        return
      }
      rememberDedupe(dedupe, eventId)
      dedupe.active.add(eventId)
      reportedPaints.set(server.url, dedupe)
      const scopedSubmitted = tiles.reduce((total, tile) => total + tile.pixels.x.length, 0)
      const event: PaintEvent = {
        eventId,
        ...identity,
        season: paint.season,
        ts: seconds(paint.observedAt),
        tiles,
        painted:
          tiles.length === paint.tiles.length
            ? paint.painted
            : paint.painted === submitted
              ? scopedSubmitted
              : null,
      }
      await deliverPaint(server, dedupe, eventId, event)
    }),
  )
}

/** Report the recent paints again, to whichever servers now cover them. */
export const replayRecentPaints = (): void => {
  for (const paint of recentPaints) void reportPaint(paint).catch(reportError)
}

/** Report every paint Wplace accepts, while the user shares paints. */
export const installPaintReports = (): void => {
  onAcceptedPaint((paint) => {
    if (!getState().reportPaints) return
    const observation = { eventId: uuidV7(), paint }
    recentPaints.push(observation)
    if (recentPaints.length > MAX_RECENT_PAINTS) recentPaints.shift()
    void reportPaint(observation).catch(reportError)
  })
}
