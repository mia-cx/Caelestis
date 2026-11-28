import {
  type CapturePaintStatus,
  isEventServer,
  LATENCY_REPORT_GAP_MS,
  type LatencyReport,
  MAX_CAPTURE_TIMING_MS,
  MAX_LATENCY_PAINTS,
  type PaintLatency,
  type PaintRequestStatus,
} from '@caelestis/shared'
import { observePageRequests, type RequestRoute } from './page-requests.js'
import { captureViews, localClock, sendCapture } from './presence-client.js'
import { worldPaintCommitButton } from './wplace-paint.js'
import { BACKEND_ORIGIN, tileFromUrl } from './wplace-raster.js'

/**
 * Timing of Wplace's own requests, for reading how capture slots land and how painters' latency to
 * Wplace spreads. Every request Wplace sends to its backend is a round-trip sample, from when it
 * leaves the page to when its response headers arrive; tiles are left out, because the browser
 * often answers them from its cache. Each Paint click on the world draft is timed to its paint
 * request, and every writable event-server session hears both now and then as a `latency-report`.
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
/** The click waiting for a paint request: `take` hands it the request sent at `sentAt`. */
let watch: { readonly take: (sentAt: number) => Settle; readonly settle: Settle } | null = null
/** The timing of the latest click on the world draft's Paint button. */
let lastClick: Promise<ClickTiming> | null = null

/**
 * Time the paint request Wplace sends after a Paint click at `clickedAt` (a `localClock()` time):
 * the first `/paint` POST from then on, or none within ten seconds. A later click takes the next
 * request, so a click still waiting settles as `no-request` then.
 */
export const timeNextPaint = (clickedAt: number): Promise<ClickTiming> => {
  watch?.settle('no-request')
  return new Promise((resolve) => {
    let sentAt: number | null = null
    let settled = false
    const settle: Settle = (status, at) => {
      if (settled) return
      settled = true
      if (watch === waiting) watch = null
      clearTimeout(timer)
      resolve({
        clickToSendMs: sentAt === null ? null : sentAt - clickedAt,
        sendToResponseMs: sentAt === null || at === undefined ? null : at - sentAt,
        status,
      })
    }
    const take = (at: number): Settle => {
      watch = null
      sentAt = at
      return settle
    }
    const waiting = { take, settle }
    watch = waiting
    const timer = setTimeout(
      () => settle(sentAt === null ? 'no-request' : 'no-response'),
      PAINT_WAIT_MS,
    )
  })
}

/**
 * Press Paint through `press`, and return how the click went as the click hook timed it, so a
 * capture slot and the latency report share one timing of it. Null when `press` pressed nothing.
 */
export const timedPress = (press: () => boolean): Promise<ClickTiming> | null => {
  lastClick = null
  return press() ? lastClick : null
}

const timingRoute: RequestRoute = (request) => {
  if (request.url.origin !== BACKEND_ORIGIN || tileFromUrl(request.raw) !== null) return undefined
  const sentAt = localClock()
  const paint = request.url.pathname === '/paint' && !request.isGet() ? watch?.take(sentAt) : null
  return {
    response: (response) => {
      const at = localClock()
      rtts.push({ at, ms: at - sentAt })
      if (rtts.length > RTT_SAMPLES) rtts.shift()
      measured++
      paint?.(response.status, at)
      return response
    },
    failed: () => paint?.('failed'),
  }
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
  // Capture phase, so the click is timed before Wplace's own handler sends anything.
  window.addEventListener('click', onClick, true)
  scheduleReport(REPORT_MS)
}
