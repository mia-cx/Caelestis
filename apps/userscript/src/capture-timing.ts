import {
  type CapturePaintStatus,
  isEventServer,
  isRecord,
  LATENCY_REPORT_GAP_MS,
  type LatencyReport,
  MAX_CAPTURE_TIMING_MS,
  MAX_LATENCY_PAINTS,
  type PaintLatency,
  type PaintRequestStatus,
} from '@caelestis/shared'
import { observePageRequests, type RequestRoute } from './page-requests.js'
import { captureViews, localClock, sendCapture } from './presence-client.js'
import {
  observeTerritorySocket,
  type TerritoryMessage,
  type TerritorySocketObserver,
} from './territory-socket.js'
import { worldPaintCommitButton } from './wplace-paint.js'
import { BACKEND_ORIGIN, tileFromUrl } from './wplace-raster.js'

/**
 * Timing of Wplace's own requests, for reading how capture slots land and how painters' latency to
 * Wplace spreads. Every request Wplace sends to its backend is a round-trip sample, from when it
 * leaves the page to when its response headers arrive; tiles are left out, because the browser
 * often answers them from its cache. So is every request on the territory event's socket, from its
 * frame to its ack. Each Paint click on the world draft is timed to its paint request, a `/paint`
 * POST or a territory `paint` frame, and every writable event-server session hears both now and
 * then as a `latency-report`.
 */

/** Round trips kept for the estimate, newest last. */
const RTT_SAMPLES = 16
/** How long after a Paint click its request may take to be sent and answered. */
const PAINT_WAIT_MS = 10_000
/** How often latency goes to event servers, while there is something new to say. */
const REPORT_MS = 5 * 60_000
/** How long a round trip counts toward the estimate; an older one may predate a network change. */
const RTT_FRESH_MS = REPORT_MS

/** Recent round trips, each with when it was measured, newest last. */
const rtts: { readonly at: number; readonly ms: number }[] = []
/** Round trips measured so far, and how many of them the last report had seen. */
let measured = 0
let reported = 0
/** Paints timed since the last report, newest last. */
let paints: PaintLatency[] = []
let lastReportAt = Number.NEGATIVE_INFINITY
let reportedPaint = false
let reportTimer: ReturnType<typeof setTimeout> | undefined

/** The round trips measured in the last five minutes, in milliseconds. */
const freshRtts = (): number[] => {
  const since = localClock() - RTT_FRESH_MS
  return rtts.filter(({ at }) => at > since).map(({ ms }) => ms)
}

/** The median of Wplace's recent round trips, in milliseconds; null without one. */
export const wplaceRtt = (samples = freshRtts()): number | null => {
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle]
  if (upper === undefined) return null
  const lower = sorted.length % 2 === 0 ? (sorted[middle - 1] ?? upper) : upper
  return (lower + upper) / 2
}

/** A duration as a report carries it: whole milliseconds, within what the wire accepts. */
export const reportMs = (ms: number): number =>
  Math.min(MAX_CAPTURE_TIMING_MS, Math.max(0, Math.round(ms)))
export const wholeMs = (ms: number | null): number | null => (ms === null ? null : reportMs(ms))

/** How the paint request after a Paint click went. */
export interface PaintTiming {
  readonly clickToSendMs: number | null
  readonly sendToResponseMs: number | null
  readonly status: CapturePaintStatus
}

/** A click's timing as `timeNextPaint` gives it: only what can become of a request it waits on. */
type ClickTiming = PaintTiming & { readonly status: PaintRequestStatus | 'no-request' }
type Settle = (status: ClickTiming['status'], at?: number) => void
/**
 * A click waiting for its paint request: `take` hands it the request sent at `sentAt`, and whether
 * that request may be another click's.
 */
interface Waiting {
  readonly take: (sentAt: number, shared: boolean) => Settle
}
/** The clicks still waiting for a paint request, oldest first. */
let waiting: Waiting[] = []
/** The timing of the latest click on the world draft's Paint button. */
let lastClick: Promise<ClickTiming> | null = null

/**
 * Time the paint request Wplace sends after a Paint click at `clickedAt` (a `localClock()` time):
 * the first `/paint` POST or territory `paint` frame from then on, or none within ten seconds.
 * Wplace prepares a request for as long as it takes, closing the panel or not, so an earlier click
 * still waiting may yet send one: the clicks waiting share the next request. With more than one, no click can claim it, and
 * each reports it without a click-to-send time.
 */
export const timeNextPaint = (clickedAt: number): Promise<ClickTiming> =>
  new Promise((resolve) => {
    let sentAt: number | null = null
    let shared = false
    let settled = false
    const settle: Settle = (status, at) => {
      if (settled) return
      settled = true
      waiting = waiting.filter((other) => other !== mine)
      clearTimeout(timer)
      resolve({
        clickToSendMs: sentAt === null || shared ? null : sentAt - clickedAt,
        sendToResponseMs: sentAt === null || at === undefined ? null : at - sentAt,
        status,
      })
    }
    const mine: Waiting = {
      take: (at, others) => {
        sentAt = at
        shared = others
        return settle
      },
    }
    waiting = [...waiting, mine]
    const timer = setTimeout(
      () => settle(sentAt === null ? 'no-request' : 'no-response'),
      PAINT_WAIT_MS,
    )
  })

/** Hand a paint request sent at `sentAt` to every click waiting, and how to settle them all. */
const takeRequest = (sentAt: number): Settle | null => {
  const takers = waiting
  if (takers.length === 0) return null
  waiting = []
  const settles = takers.map(({ take }) => take(sentAt, takers.length > 1))
  return (status, at) => {
    for (const settle of settles) settle(status, at)
  }
}

/**
 * Press Paint through `press`, and return how the click went as the click hook timed it, so a
 * capture slot and the latency report share one timing of it. Null when `press` pressed nothing.
 */
export const timedPress = (press: () => boolean): Promise<ClickTiming> | null => {
  lastClick = null
  return press() ? lastClick : null
}

/** Keep the round trip of a request sent at `sentAt` and answered at `at`. */
const measure = (sentAt: number, at: number): void => {
  rtts.push({ at, ms: at - sentAt })
  if (rtts.length > RTT_SAMPLES) rtts.shift()
  measured++
}

const timingRoute: RequestRoute = (request) => {
  if (request.url.origin !== BACKEND_ORIGIN || tileFromUrl(request.raw) !== null) return undefined
  const sentAt = localClock()
  const paint = request.url.pathname === '/paint' && !request.isGet() ? takeRequest(sentAt) : null
  return {
    response: (response) => {
      const at = localClock()
      measure(sentAt, at)
      paint?.(response.status, at)
      return response
    },
    failed: () => paint?.('failed'),
  }
}

/** How a territory paint's ack reads as a request status: accepted as HTTP would say it. */
const TERRITORY_ACCEPTED = 200
/** Territory requests kept waiting for their ack; Wplace gives up on one after ten seconds. */
const TERRITORY_UNANSWERED = 16

/** Territory socket requests sent, by their id, until their ack arrives. */
const territoryRequests = new Map<
  unknown,
  { readonly sentAt: number; readonly paint: Settle | null }
>()

/**
 * What became of a territory paint, from its ack: refused when the server answered with an error,
 * or with a refusal Wplace reports (any reason but `own`, pixels the team already holds).
 */
const territoryStatus = (ack: TerritoryMessage): PaintRequestStatus => {
  if (ack.error) return 'refused'
  const reason = isRecord(ack.result) ? ack.result.reason : undefined
  return !reason || reason === 'own' ? TERRITORY_ACCEPTED : 'refused'
}

/**
 * The territory event's Paint panel sends no `/paint` request: its draft goes over the territory
 * socket as `{ t: 'paint', id }`, and the server's `{ t: 'ack', id }` answers it. Every request on
 * the socket is a round trip; a paint is also timed for the Paint click waiting for it.
 */
const territoryTiming: TerritorySocketObserver = {
  sent: (message) => {
    if (message.id === undefined) return
    const sentAt = localClock()
    territoryRequests.set(message.id, {
      sentAt,
      paint: message.t === 'paint' ? takeRequest(sentAt) : null,
    })
    for (const id of territoryRequests.keys()) {
      if (territoryRequests.size <= TERRITORY_UNANSWERED) break
      territoryRequests.delete(id)
    }
  },
  received: (message) => {
    const request = message.t === 'ack' ? territoryRequests.get(message.id) : undefined
    if (request === undefined) return
    territoryRequests.delete(message.id)
    const at = localClock()
    measure(request.sentAt, at)
    request.paint?.(territoryStatus(message), at)
  },
  closed: () => {
    for (const { paint } of territoryRequests.values()) paint?.('failed')
    territoryRequests.clear()
  },
}

const scheduleReport = (delay: number): void => {
  clearTimeout(reportTimer)
  reportTimer = setTimeout(report, delay)
}

/**
 * Tell every writable event-server session this tab's latency, when anything is new since the
 * last report. With no such session, the samples wait for the next report.
 */
const report = (): void => {
  scheduleReport(REPORT_MS)
  const servers = captureViews().filter(
    ({ server, canWrite }) => canWrite && isEventServer(server.info),
  )
  if (servers.length === 0 || (measured === reported && paints.length === 0)) return
  const samples = freshRtts()
  // Round trips can all have gone stale while no session could hear them: nothing left to say.
  if (samples.length === 0 && paints.length === 0) return
  const event: LatencyReport = {
    type: 'latency-report',
    wplaceRttMs: wholeMs(wplaceRtt(samples)),
    rttSamples: samples.length,
    paints,
  }
  paints = []
  reported = measured
  lastReportAt = localClock()
  for (const { server } of servers) sendCapture(server, event)
}

/** Keep a Paint click's timing for the next report, which the first one brings forward. */
const recordPaint = ({ clickToSendMs, sendToResponseMs, status }: ClickTiming): void => {
  // A click Wplace sent nothing for says nothing about latency.
  if (clickToSendMs === null || status === 'no-request') return
  paints = [
    ...paints,
    { clickToSendMs: reportMs(clickToSendMs), sendToResponseMs: wholeMs(sendToResponseMs), status },
  ].slice(-MAX_LATENCY_PAINTS)
  if (reportedPaint) return
  reportedPaint = true
  scheduleReport(Math.max(0, lastReportAt + LATENCY_REPORT_GAP_MS - localClock()))
}

/** Time a click on the world draft's Paint button, however it was pressed. */
const onClick = (event: Event): void => {
  const button = event.target instanceof Element ? event.target.closest('button') : null
  if (button === null || button !== worldPaintCommitButton()) return
  lastClick = timeNextPaint(localClock())
  void lastClick.then(recordPaint)
}

/** Time Wplace's backend requests and Paint clicks, and report them to event servers. */
export const observeWplaceTiming = (): void => {
  observePageRequests(timingRoute)
  observeTerritorySocket(territoryTiming)
  // Capture phase, so the click is timed before Wplace's own handler sends anything.
  window.addEventListener('click', onClick, true)
  scheduleReport(REPORT_MS)
}
