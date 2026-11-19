import { isRecord } from '@caelestis/shared'
import { count } from './debug.js'
import { flushDraftWrites } from './draft-pixels.js'
import { notifyEach } from './page-hooks.js'
import { observePageRequests, type RequestRoute } from './page-requests.js'
import { isPageInstance } from './page-world.js'
import { nextPixelObservation } from './pixel-observation.js'
import {
  beginSubmission,
  finishSubmission,
  type PaintedTile,
  retainAcceptedPaint,
} from './tile-pixels.js'
import { BACKEND_ORIGIN } from './wplace-raster.js'

/** Opaque identity shared only between the synchronous submit tap and its accepted response. */
export interface PaintSubmission {
  readonly identity: object
}

/** A `/paint` submission Wplace's server accepted in full. */
export interface AcceptedPaint {
  readonly submission: PaintSubmission
  readonly season: number
  readonly tiles: readonly PaintedTile[]
  readonly painted: number
  readonly observedAt: number
}

type AcceptedPaintListener = (paint: AcceptedPaint) => void
type PaintSubmissionListener = (submission: PaintSubmission) => void
const acceptedPaintListeners = new Set<AcceptedPaintListener>()
const paintSubmissionListeners = new Set<PaintSubmissionListener>()

/** Observe the public paint payload only after Wplace reports how many pixels it accepted. */
export const onAcceptedPaint = (listener: AcceptedPaintListener): (() => void) => {
  acceptedPaintListeners.add(listener)
  return () => acceptedPaintListeners.delete(listener)
}

/** Snapshot browser-owned state before Wplace can clear its submitted draft. */
export const onPaintSubmission = (listener: PaintSubmissionListener): (() => void) => {
  paintSubmissionListeners.add(listener)
  return () => paintSubmissionListeners.delete(listener)
}

const observedPaintFrom = (
  body: unknown,
  response: unknown,
  submission: PaintSubmission,
): AcceptedPaint | null => {
  if (!isRecord(body) || !isRecord(response)) return null
  if (!Number.isSafeInteger(body.season) || !Array.isArray(body.tiles)) return null
  if (!Number.isSafeInteger(response.painted) || Number(response.painted) < 0) return null
  const tiles: PaintedTile[] = []
  for (const raw of body.tiles) {
    if (!isRecord(raw) || !isRecord(raw.pixels)) return null
    const pixels = raw.pixels
    if (
      !Number.isSafeInteger(raw.x) ||
      !Number.isSafeInteger(raw.y) ||
      !Array.isArray(pixels.x) ||
      !Array.isArray(pixels.y) ||
      !Array.isArray(pixels.colors) ||
      !pixels.x.every(Number.isSafeInteger) ||
      !pixels.y.every(Number.isSafeInteger) ||
      !pixels.colors.every(Number.isSafeInteger)
    )
      return null
    tiles.push({
      x: Number(raw.x),
      y: Number(raw.y),
      pixels: {
        x: pixels.x as number[],
        y: pixels.y as number[],
        colors: pixels.colors as number[],
      },
    })
  }
  return {
    submission,
    season: Number(body.season),
    tiles,
    painted: Number(response.painted),
    observedAt: Math.floor(Date.now() / 1_000),
  }
}

const paintRoute: RequestRoute = (request) => {
  if (request.url.origin !== BACKEND_ORIGIN || request.url.pathname !== '/paint') return undefined
  const { input, init, realm } = request
  const submitted = isPageInstance(input, 'Request', realm as unknown as Record<string, unknown>)
    ? (input as Request).clone()
    : new realm.Request(input as RequestInfo, init)
  if (submitted.method.toUpperCase() !== 'POST') return undefined
  const submission: PaintSubmission = { identity: {} }
  beginSubmission(submission.identity)
  flushDraftWrites()
  notifyEach(
    paintSubmissionListeners,
    (listener) => listener(submission),
    'paint:submission-listener-failed',
  )
  const body = submitted.json().catch(() => null)
  const finish = (): void => finishSubmission(submission.identity)
  return {
    response: (response) => {
      if (!response.ok) {
        finish()
        return response
      }
      const accepted = nextPixelObservation()
      try {
        const answer = response
          .clone()
          .json()
          .catch(() => null)
        void Promise.all([body, answer]).then(([sent, reply]) => {
          try {
            const paint = observedPaintFrom(sent, reply, submission)
            if (paint === null) return
            retainAcceptedPaint(submission.identity, paint.tiles, paint.painted, accepted)
            notifyEach(
              acceptedPaintListeners,
              (listener) => listener(paint),
              'telemetry:paint-listener-failed',
            )
          } finally {
            finish()
          }
        })
      } catch {
        finish()
        count('telemetry:paint-response-unreadable')
      }
      return response
    },
    failed: finish,
  }
}

/** Watch Wplace's paint submissions, and keep what its server accepted. */
export const observePaintRequests = (): void => {
  observePageRequests(paintRoute)
}
