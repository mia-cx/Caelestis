import type { CapturePaintStatus } from '@caelestis/shared'
import { observePageRequests, type RequestRoute } from './page-requests.js'
import { localClock } from './presence-client.js'
import { BACKEND_ORIGIN, tileFromUrl } from './wplace-raster.js'

/**
 * Timing of Wplace's own requests, for reading how capture slots land. Every request Wplace sends
 * to its backend is a round-trip sample, from when it leaves the page to when its response
 * headers arrive; tiles are left out, because the browser often answers them from its cache.
 */

/** Round trips kept for the estimate, newest last. */
const RTT_SAMPLES = 16
/** How long after a Paint click its request may take to be sent and answered. */
const PAINT_WAIT_MS = 10_000

const rtts: number[] = []

/** The median of Wplace's recent round trips, in milliseconds; null before the first. */
export const wplaceRtt = (): number | null =>
  [...rtts].sort((a, b) => a - b)[Math.floor(rtts.length / 2)] ?? null

/** How the paint request after a Paint click went. */
export interface PaintTiming {
  readonly clickToSendMs: number | null
  readonly sendToResponseMs: number | null
  readonly status: CapturePaintStatus
}

/** Takes the first paint request after a click and returns what settles it, once; else nothing. */
type PaintWatch = (sentAt: number) => ((status: CapturePaintStatus, at?: number) => void) | null
let watch: PaintWatch | null = null

/**
 * Time the paint request Wplace sends after a Paint click at `clickedAt` (a `localClock()` time):
 * the first `/paint` POST from then on, or none within ten seconds. A later click's watch replaces
 * this one, which then never settles.
 */
export const timeNextPaint = (clickedAt: number): Promise<PaintTiming> =>
  new Promise((resolve) => {
    let sentAt: number | null = null
    const settle = (status: CapturePaintStatus, at?: number): void => {
      if (watch !== watcher) return
      watch = null
      clearTimeout(timer)
      resolve({
        clickToSendMs: sentAt === null ? null : sentAt - clickedAt,
        sendToResponseMs: sentAt === null || at === undefined ? null : at - sentAt,
        status,
      })
    }
    const watcher: PaintWatch = (at) => {
      if (sentAt !== null) return null
      sentAt = at
      return settle
    }
    watch = watcher
    const timer = setTimeout(
      () => settle(sentAt === null ? 'no-request' : 'no-response'),
      PAINT_WAIT_MS,
    )
  })

const timingRoute: RequestRoute = (request) => {
  if (request.url.origin !== BACKEND_ORIGIN || tileFromUrl(request.raw) !== null) return undefined
  const sentAt = localClock()
  const paint = request.url.pathname === '/paint' && !request.isGet() ? watch?.(sentAt) : null
  return {
    response: (response) => {
      const at = localClock()
      rtts.push(at - sentAt)
      if (rtts.length > RTT_SAMPLES) rtts.shift()
      paint?.(response.status, at)
      return response
    },
    failed: () => paint?.('failed'),
  }
}

/** Time Wplace's backend requests. */
export const observeWplaceTiming = (): void => {
  observePageRequests(timingRoute)
}
