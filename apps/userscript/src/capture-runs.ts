import {
  arenaToWorld,
  CAPTURE_LEAD_MS,
  type CaptureRun,
  captureSlot,
  decodePng,
  edgeRectanglePlanner,
  MAX_CAPTURE_PAINTERS,
  PALETTE_RGB,
  type PainterIdentity,
  type RegionShapePixels,
  simulateCapture,
  TERRITORY_ARENA,
  TERRITORY_CHARGES,
  type TerritoryTeam,
  TILE_SIZE,
  territoryMapFromImage,
} from '@caelestis/shared'
import type {
  CaelestisElement,
  CaptureProposal,
  CaptureRunIntent,
  CaptureRunModel,
} from '@caelestis/ui/elements'
import { type CaptureCue, primeCaptureAudio, scheduleCaptureCues } from './capture-cues.js'
import { log, warn } from './debug.js'
import { comparisonDraftPixelAt } from './draft-pixels.js'
import { requestMapFrame } from './map-view.js'
import { UNPAINTED } from './native-pixels.js'
import {
  type CaptureView,
  captureViews,
  localClock,
  onPresenceChange,
  sendCapture,
  syncCaptureClock,
} from './presence-client.js'
import { presenceCss } from './presence-colour.js'
import { hasServerAdminToken } from './server-connections.js'
import { getState, onStateChange, setState } from './settings.js'
import { simulatedInputAllowed } from './simulated-input.js'
import { navigateTo } from './templates/navigate.js'
import { applyWplaceTheme } from './ui/theme.js'
import { accountIdentity } from './wplace-account.js'
import { submitPaintDraft } from './wplace-paint.js'
import { BACKEND_ORIGIN } from './wplace-raster.js'

/**
 * Capture runs in Wplace's territory event, from this tab's side.
 *
 * The run itself lives in a server's presence room (`presence-client` holds it). This module picks
 * the run to show, plans walls from Wplace's live territory map for an administrator, reports how
 * much of this painter's line is drafted, draws every line on the map, and at this painter's slot
 * presses Paint when the Dangerous settings switch allows it.
 *
 * Slots are on the server's clock. Joining and starting each sync this tab's clock against the
 * server's, so a slot lands at the same instant in every browser whatever its latency or skew.
 */

const ELEMENT_ID = 'caelestis-capture-run'
/** How often a member's drafted count is re-read and the countdown redrawn. */
const TICK_MS = 100
/** How long the card stays on "done" after the last slot before it may be closed. */
const DONE_AFTER_MS = 3_000
/** How long before a slot the precise wait starts; setTimeout alone can be late by this much. */
const SPIN_MS = 30

interface Proposal extends CaptureProposal {
  /** Each painter's line as flat world coordinates. */
  readonly lines: readonly (readonly number[])[]
}

let painters = 3
let proposals: readonly Proposal[] = []
let proposing = false
let message: string | undefined
let element: CaelestisElement<'caelestis-capture-run'> | null = null
let timer: ReturnType<typeof setInterval> | null = null
/** Run id and member index whose slot this tab has already acted on, or armed. */
let armedSlot: string | null = null
/** Silences the beeps of the slot armed before, when the run restarts or closes. */
let silence: () => void = () => {}
let joinedRun: string | null = null
let lastDrafted = -1

/** The run to show: the first server with one, else a server this tab may open one on. */
const active = (): CaptureView | null => {
  const views = captureViews()
  return (
    views.find((view) => view.run !== null) ??
    views.find((view) => hasServerAdminToken(view.server)) ??
    null
  )
}

const memberIndex = (view: CaptureView): number =>
  view.run?.members.findIndex((member) => member.sessionId === view.sessionId) ?? -1

/** Local `localClock()` time of a server time, once this tab's clock is synced. */
const localTime = (view: CaptureView, serverTime: number): number | null =>
  view.clockOffset === null ? null : serverTime - view.clockOffset

const linePixels = (line: readonly number[]): { x: number; y: number }[] => {
  const pixels: { x: number; y: number }[] = []
  for (let at = 0; at + 1 < line.length; at += 2)
    pixels.push({ x: line[at] as number, y: line[at + 1] as number })
  return pixels
}

/** How many of a line's pixels this tab has drafted. */
const draftedOn = (line: readonly number[]): number =>
  linePixels(line).filter(({ x, y }) => {
    const tile = { x: Math.floor(x / TILE_SIZE), y: Math.floor(y / TILE_SIZE) }
    const offset = (y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE)
    return comparisonDraftPixelAt(tile, offset) !== UNPAINTED
  }).length

/** A line as a pixel mask over its bounding box, for the presence layer. */
const lineMask = (line: readonly number[]): RegionShapePixels | null => {
  const pixels = linePixels(line)
  if (pixels.length === 0) return null
  const xs = pixels.map(({ x }) => x)
  const ys = pixels.map(({ y }) => y)
  const rect = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs) + 1,
    h: Math.max(...ys) - Math.min(...ys) + 1,
  }
  const mask = new Uint8Array(rect.w * rect.h)
  for (const { x, y } of pixels) mask[(y - rect.y) * rect.w + (x - rect.x)] = 1
  return { rect, mask, count: pixels.length }
}

export interface CaptureLineItem {
  readonly pixels: RegionShapePixels
  readonly painter: PainterIdentity | null
  readonly mine: boolean
}

const lineCache = new WeakMap<CaptureRun, readonly CaptureLineItem[]>()

/** Every line of the shown run, or of the proposal an administrator is looking at, for the map. */
export const captureLines = (): readonly CaptureLineItem[] => {
  const view = active()
  const run = view?.run ?? null
  if (view === null) return []
  if (run === null || run.lines.length === 0) {
    const preview = proposals[0]
    if (preview === undefined) return []
    return preview.lines.flatMap((line) => {
      const pixels = lineMask(line)
      return pixels === null ? [] : [{ pixels, painter: null, mine: false }]
    })
  }
  const cached = lineCache.get(run)
  if (cached !== undefined) return cached
  const mine = memberIndex(view)
  const items = run.lines.flatMap((line, index) => {
    const pixels = lineMask(line)
    const member = run.members[index]
    return pixels === null
      ? []
      : [{ pixels, painter: member?.painter ?? null, mine: index === mine }]
  })
  lineCache.set(run, items)
  return items
}

const edgeLabel = (lines: readonly (readonly number[])[]): string => {
  const first = linePixels(lines[0] ?? [])[0]
  if (first === undefined) return 'Wall'
  const local = {
    x: first.x - TERRITORY_ARENA.tileX * TILE_SIZE,
    y: first.y - TERRITORY_ARENA.tileY * TILE_SIZE,
  }
  const last = TERRITORY_ARENA.size - 1
  if (local.y === last) return 'Along the bottom edge'
  if (local.y === 0) return 'Along the top edge'
  if (local.x === last) return 'Along the right edge'
  if (local.x === 0) return 'Along the left edge'
  return 'Wall'
}

/** This painter's team in the event, from Wplace's own leaderboard. */
const loadTeam = async (): Promise<TerritoryTeam | null> => {
  const response = await fetch(`${BACKEND_ORIGIN}/territory/leaderboard`, {
    credentials: 'include',
  })
  if (!response.ok) return null
  const body: unknown = await response.json()
  const team = (body as { me?: { team?: unknown } } | null)?.me?.team
  return team === 0 || team === 1 || team === 2 || team === 3 ? team : null
}

/** Plan walls for the run's group size from the live map, best first. */
const propose = async (groupSize: number): Promise<void> => {
  proposing = true
  message = undefined
  render()
  try {
    const [team, snapshot] = await Promise.all([
      loadTeam(),
      fetch(`${BACKEND_ORIGIN}/territory/snapshot`).then((response) =>
        response.ok ? response.arrayBuffer() : null,
      ),
    ])
    if (team === null) {
      message = 'Join a team in the event first.'
      return
    }
    if (snapshot === null) {
      message = 'Wplace did not send the territory map. Try again.'
      return
    }
    const map = territoryMapFromImage(await decodePng(new Uint8Array(snapshot)), PALETTE_RGB)
    const plans = edgeRectanglePlanner({
      map,
      team,
      painters: groupSize,
      charges: TERRITORY_CHARGES,
    })
    proposals = plans.map((plan, index) => {
      const lines = plan.lines.map((line) =>
        line.flatMap((pixel) => {
          const world = arenaToWorld(pixel)
          return [world.x, world.y]
        }),
      )
      const outcome = simulateCapture(map, team, plan)
      return {
        id: String(index),
        label: edgeLabel(lines),
        gained: outcome.gained,
        pixels: outcome.painted,
        published: false,
        lines,
      }
    })
    if (proposals.length === 0) message = 'No wall fits along an edge your team holds.'
    log(
      'capture proposals',
      proposals.map(({ label, gained, pixels }) => ({ label, gained, pixels })),
    )
  } catch (error) {
    warn('capture proposal failed', String(error))
    message = 'Planning failed. Try again.'
  } finally {
    proposing = false
    render()
    // The previewed plan is drawn on the map, which redraws only when asked.
    requestMapFrame()
  }
}

const sameLines = (a: readonly (readonly number[])[], b: readonly (readonly number[])[]) =>
  a.length === b.length &&
  a.every((line, index) => {
    const other = b[index]
    return (
      other !== undefined && line.length === other.length && line.every((n, i) => n === other[i])
    )
  })

/** Seconds before a slot that tick, after the cue that starts everyone's countdown. */
const TICK_SECONDS = [5, 3, 2, 1] as const

/**
 * One painter's beeps: when Go starts the first painter's ten-second countdown, then 5, 3, 2 and 1
 * seconds before their own slot, then the tone to paint. For the first painter the opening cue is
 * their 10.
 */
const slotCues = (slot: number, go: number): CaptureCue[] => [
  { at: go, tone: 'tick' },
  ...TICK_SECONDS.map((seconds) => ({ at: slot - seconds * 1_000, tone: 'tick' as const })).filter(
    ({ at }) => at > go,
  ),
  { at: slot, tone: 'go' },
]

/**
 * At this painter's slot, press Paint. A timeout wakes it shortly before, then it waits out the
 * rest precisely, because timers in a busy page fire late.
 */
const armSlot = (view: CaptureView, run: CaptureRun, index: number): void => {
  const key = `${run.id}:${index}:${run.startsAt}`
  if (armedSlot === key) return
  const slot = captureSlot(run, index)
  const at = slot === null ? null : localTime(view, slot)
  if (at === null) return
  armedSlot = key
  silence()
  silence = scheduleCaptureCues(slotCues(at, at - index * run.staggerMs - CAPTURE_LEAD_MS))
  if (!simulatedInputAllowed('capture-paint')) return
  const fire = () => {
    while (localClock() < at) {
      // Spin out the last few milliseconds; the page is about to paint anyway.
    }
    const submitted = submitPaintDraft()
    log('capture slot', { index, late: localClock() - at, submitted })
    if (!submitted) message = 'Paint was not ready at your slot.'
    render()
  }
  setTimeout(fire, Math.max(0, at - localClock() - SPIN_MS))
}

const phaseOf = (view: CaptureView | null): CaptureRunModel['phase'] => {
  const run = view?.run ?? null
  if (view === null || run === null) return 'none'
  if (run.startsAt === null) return 'gathering'
  const last = captureSlot(run, Math.max(0, run.lines.length - 1)) ?? run.startsAt
  const end = localTime(view, last + DONE_AFTER_MS)
  return end !== null && localClock() > end ? 'done' : 'countdown'
}

const model = (view: CaptureView | null): CaptureRunModel | null => {
  if (view === null) return null
  const run = view.run
  const admin = hasServerAdminToken(view.server)
  if (run === null && !admin) return null
  const mine = memberIndex(view)
  const phase = phaseOf(view)
  const slot = run !== null && mine >= 0 ? captureSlot(run, mine) : null
  const slotAt = slot === null ? null : localTime(view, slot)
  const startAt = run?.startsAt == null ? null : localTime(view, run.startsAt)
  return {
    phase,
    admin,
    painters: run?.painters ?? painters,
    maxPainters: MAX_CAPTURE_PAINTERS,
    members: (run?.members ?? []).map((member, index) => ({
      id: member.sessionId,
      name: member.painter.displayName,
      colour: presenceCss(member.painter.wplaceUserId),
      drafted: member.drafted,
      length: (run?.lines[index]?.length ?? 0) / 2,
      me: index === mine,
    })),
    joined: mine >= 0,
    canJoin: run !== null && run.startsAt === null && mine < 0 && run.members.length < run.painters,
    proposals: proposals.map((proposal) => ({
      id: proposal.id,
      label: proposal.label,
      gained: proposal.gained,
      pixels: proposal.pixels,
      published: run !== null && run.lines.length > 0 && sameLines(run.lines, proposal.lines),
    })),
    proposing,
    canStart:
      admin &&
      run !== null &&
      run.startsAt === null &&
      run.lines.length > 0 &&
      run.members.length >= run.lines.length,
    mySlotAt: phase === 'countdown' && slotAt !== null ? slotAt - performance.timeOrigin : null,
    myTurn: mine >= 0 ? mine + 1 : null,
    startsAt: phase === 'countdown' && startAt !== null ? startAt - performance.timeOrigin : null,
    autoPaint: simulatedInputAllowed('capture-paint'),
    ...(message === undefined ? {} : { message }),
  }
}

const handleIntent = (intent: CaptureRunIntent): void => {
  const view = active()
  if (view === null) return
  const { server } = view
  switch (intent.type) {
    case 'set-painters':
      painters = Math.min(MAX_CAPTURE_PAINTERS, Math.max(1, Math.round(intent.painters)))
      proposals = []
      break
    case 'open':
      proposals = []
      sendCapture(server, { type: 'capture-open', painters })
      break
    case 'join':
      primeCaptureAudio()
      sendCapture(server, { type: 'capture-join' })
      syncCaptureClock(server)
      break
    case 'leave':
      sendCapture(server, { type: 'capture-leave' })
      break
    case 'move': {
      const order = view.run?.members.map(({ sessionId }) => sessionId) ?? []
      const from = order.indexOf(intent.id)
      const to = from + intent.by
      if (from < 0 || to < 0 || to >= order.length) break
      order.splice(to, 0, ...order.splice(from, 1))
      sendCapture(server, { type: 'capture-order', order })
      break
    }
    case 'propose':
      void propose(view.run?.painters ?? painters)
      break
    case 'publish': {
      const chosen = proposals.find(({ id }) => id === intent.id)
      if (chosen !== undefined) sendCapture(server, { type: 'capture-plan', lines: chosen.lines })
      break
    }
    case 'show-line': {
      const mine = memberIndex(view)
      const line = mine < 0 ? undefined : view.run?.lines[mine]
      const pixels = line === undefined ? null : lineMask(line)
      if (pixels !== null)
        navigateTo({
          x: pixels.rect.x + pixels.rect.w / 2,
          y: pixels.rect.y + pixels.rect.h / 2,
          width: Math.max(pixels.rect.w, 40),
          height: Math.max(pixels.rect.h, 40),
        })
      break
    }
    case 'go':
      primeCaptureAudio()
      sendCapture(server, { type: 'capture-go' })
      break
    case 'close':
      proposals = []
      sendCapture(server, { type: 'capture-close' })
      break
    case 'set-auto-paint': {
      // The same switch as in Dangerous settings, written the way that list writes it.
      const { 'capture-paint': _, ...others } = getState().simulatedInput
      setState({ simulatedInput: intent.on ? { ...others, 'capture-paint': true } : others })
      break
    }
  }
  render()
}

const ensureElement = (): CaelestisElement<'caelestis-capture-run'> => {
  if (element?.isConnected) return element
  const created = document.createElement('caelestis-capture-run')
  created.id = ELEMENT_ID
  applyWplaceTheme(created)
  created.addEventListener('caelestis-capture-run-intent', (event) => handleIntent(event.detail))
  document.body.appendChild(created)
  element = created
  return created
}

/** Keep the member's readiness, clock and slot current; runs while a run is shown. */
const tick = (): void => {
  const view = active()
  const run = view?.run ?? null
  if (view !== null && run !== null) {
    const mine = memberIndex(view)
    if (mine >= 0) {
      // A painter who joined from another tab, or whose socket reconnected, still needs a sync.
      if (joinedRun !== run.id || view.clockOffset === null) {
        joinedRun = run.id
        syncCaptureClock(view.server)
      }
      const line = run.lines[mine]
      // Report only what the run does not already say, once per value until it does.
      const drafted = line === undefined ? 0 : draftedOn(line)
      const reported = run.members[mine]?.drafted
      if (drafted === reported) lastDrafted = drafted
      else if (drafted !== lastDrafted && run.startsAt === null) {
        lastDrafted = drafted
        sendCapture(view.server, { type: 'capture-drafted', drafted })
      }
      if (run.startsAt !== null) armSlot(view, run, mine)
    }
  }
  render()
}

const render = (): void => {
  const next = model(active())
  if (next === null || accountIdentity() === null) {
    element?.remove()
    element = null
    if (timer !== null) clearInterval(timer)
    timer = null
    return
  }
  ensureElement().model = next
  timer ??= setInterval(tick, TICK_MS)
}

/** Install once, after presence. */
export const installCaptureRuns = (): void => {
  let lastRun: string | null = null
  onPresenceChange(() => {
    const view = active()
    const run = view?.run ?? null
    // A started run re-syncs the clock once more, just before the countdown matters.
    const key = run === null ? null : `${run.id}:${run.startsAt}`
    if (view !== null && run !== null && key !== lastRun && run.startsAt !== null)
      syncCaptureClock(view.server)
    lastRun = key
    if (run === null) {
      lastDrafted = -1
      silence()
    }
    render()
  })
  onStateChange(render)
}
