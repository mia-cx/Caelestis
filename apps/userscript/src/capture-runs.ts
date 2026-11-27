import {
  anchorStrips,
  arenaToWorld,
  CAPTURE_LEAD_MS,
  type CaptureRun,
  captureSlot,
  decodePng,
  edgeRectanglePlanner,
  isCaptureGuard,
  MAX_CAPTURE_GUARDS,
  MAX_CAPTURE_PAINTERS,
  PALETTE_RGB,
  type RegionShapePixels,
  simulateCapture,
  TERRITORY_ARENA,
  TERRITORY_CHARGES,
  TERRITORY_TEAMS,
  type TerritoryMap,
  type TerritoryTeam,
  TILE_SIZE,
  territoryMapFromImage,
  worldToArena,
} from '@caelestis/shared'
import type {
  CaelestisElement,
  CaptureProposal,
  CaptureRunIntent,
  CaptureRunModel,
} from '@caelestis/ui/elements'
import { type CaptureCue, primeCaptureAudio, scheduleCaptureCues } from './capture-cues.js'
import {
  anchorRect,
  approachPath,
  type CaptureItem,
  type CaptureItemKind,
  caterpillarFrames,
  enclosedArea,
  linePixels,
  pixelMask,
} from './capture-scene.js'
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
import { getState, onStateChange } from './settings.js'
import { navigateTo } from './templates/navigate.js'
import { applyWplaceTheme } from './ui/theme.js'
import { accountIdentity } from './wplace-account.js'
import { submitWorldPaintDraft } from './wplace-paint.js'
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
/** Pixels in a guard's strip: half their charges, so the other half can repaint the anchor. */
const GUARD_STRIP = TERRITORY_CHARGES / 2
/** How often a guard reads Wplace's territory map: as often as Wplace refreshes it. */
const WATCH_MS = 5_000
/** How long after a guard's slot their anchor is first checked, so the start can land. */
const WATCH_GRACE_MS = 3_000
/** How often a member's drafted count is re-read and the countdown redrawn. */
const TICK_MS = 100
/** How long the card stays on "done" after the last slot before it may be closed. */
const DONE_AFTER_MS = 3_000
/** How long before a slot the precise wait starts; setTimeout alone can be late by this much. */
const SPIN_MS = 30
/** A slot this far behind when the tab wakes is skipped: the next painter has gone already. */
const MISSED_SLOT_MS = 250
/** The most often a member reports their drafted count; the latest count goes each time. */
const DRAFTED_REPORT_MS = 1_000

interface Proposal extends CaptureProposal {
  /** Each painter's line as flat world coordinates. */
  readonly lines: readonly (readonly number[])[]
  /** What the wall would enclose. */
  readonly area: RegionShapePixels | null
}

let painters = 3
let guards = MAX_CAPTURE_GUARDS
let proposals: readonly Proposal[] = []
let proposing = false
let message: string | undefined
let element: CaelestisElement<'caelestis-capture-run'> | null = null
let timer: ReturnType<typeof setInterval> | null = null
/** Run id and member index whose slot this tab has already acted on, or armed. */
let armedSlot: string | null = null
/** Cancels the armed slot's beeps and Paint, when the run restarts, changes or closes. */
let disarm: () => void = () => {}
/** When this tab last reported its drafted count, so drafting never floods the socket. */
let draftedSentAt = Number.NEGATIVE_INFINITY
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

/** This painter's event team, once read; only its colour and dark shade claim territory. */
let myTeam: TerritoryTeam | null = null

/** How many of a line's pixels this tab has drafted in a colour that claims for its team. */
const draftedOn = (line: readonly number[]): number => {
  const team = myTeam === null ? null : TERRITORY_TEAMS[myTeam]
  return linePixels(line).filter(({ x, y }) => {
    const tile = { x: Math.floor(x / TILE_SIZE), y: Math.floor(y / TILE_SIZE) }
    const offset = (y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE)
    const drafted = comparisonDraftPixelAt(tile, offset)
    if (drafted === UNPAINTED) return false
    return team === null || drafted === team.colour || drafted === team.dark
  }).length
}

/** Wplace's map and the team, read for the plan on screen, with what the map shows from them. */
interface PlanView {
  readonly key: string
  readonly area: RegionShapePixels | null
  /** This painter's caterpillar demo, frame by frame; empty when they are not drafting a line. */
  readonly demo: readonly (readonly { x: number; y: number }[])[]
}
let planView: PlanView | null = null
let planLoading: string | null = null
let demoStep = 0

const planKey = (run: CaptureRun, mine: number): string =>
  `${run.id}:${mine}:${run.lines.map((line) => line.join(',')).join(';')}`

/** Read the map for a published plan once, for its enclosed area and this painter's demo. */
const loadPlanView = (run: CaptureRun, mine: number): void => {
  const key = planKey(run, mine)
  if (planView?.key === key || planLoading === key) return
  planLoading = key
  void Promise.all([myTeam ?? loadTeam(), loadTerritory()])
    .then(([team, map]) => {
      if (planLoading !== key || team === null || map === null) return
      myTeam = team
      const line = mine >= 0 ? linePixels(run.lines[mine] ?? []) : []
      const first = line[0]
      planView = {
        key,
        area: enclosedArea(map, team, run.lines),
        demo: first === undefined ? [] : caterpillarFrames(approachPath(map, team, first), line),
      }
      demoStep = 0
      requestMapFrame()
    })
    .catch((error) => warn('capture plan view failed', String(error)))
    .finally(() => {
      if (planLoading === key) planLoading = null
    })
}

const kindOf = (run: CaptureRun, index: number, mine: number): CaptureItemKind => {
  if (index === mine) return 'mine'
  const member = run.members[index]
  const length = (run.lines[index]?.length ?? 0) / 2
  return member !== undefined && length > 0 && member.drafted >= length ? 'ready' : 'pending'
}

/** Whether this painter's demo plays: while gathering, until their line is drafted. */
const demoPlaying = (view: CaptureView): boolean => {
  const run = view.run
  const mine = memberIndex(view)
  if (run === null || run.startsAt !== null || mine < 0 || planView === null) return false
  const length = (run.lines[mine]?.length ?? 0) / 2
  return planView.demo.length > 0 && (run.members[mine]?.drafted ?? 0) < length
}

const itemsCache = new WeakMap<
  CaptureRun,
  { readonly key: string; readonly items: CaptureItem[] }
>()

/** What the shown run, or the plans an administrator is choosing between, puts on the map. */
export const captureItems = (): readonly CaptureItem[] => {
  const view = active()
  if (view === null) return []
  const run = view.run
  if (run === null || run.lines.length === 0)
    return proposals.flatMap((proposal) => [
      ...(proposal.area === null
        ? []
        : [
            {
              kind: 'area' as const,
              rect: proposal.area.rect,
              pixels: proposal.area,
              painter: null,
            },
          ]),
      ...proposal.lines.flatMap((line) => {
        const pixels = pixelMask(linePixels(line))
        return pixels === null
          ? []
          : [{ kind: 'pending' as const, rect: pixels.rect, pixels, painter: null }]
      }),
    ])
  const mine = memberIndex(view)
  const key = `${planView?.key ?? ''}|${run.members.map(({ drafted }) => drafted).join(',')}`
  let held = itemsCache.get(run)
  if (held?.key !== key) {
    const items: CaptureItem[] = []
    if (planView?.area)
      items.push({ kind: 'area', rect: planView.area.rect, pixels: planView.area, painter: null })
    run.lines.forEach((line, index) => {
      const pixels = pixelMask(linePixels(line))
      if (pixels !== null)
        items.push({
          kind: kindOf(run, index, mine),
          rect: pixels.rect,
          pixels,
          painter: run.members[index]?.painter ?? null,
        })
    })
    for (let index = run.painters; index < run.lines.length; index++) {
      const rect = anchorRect(run, index, GUARD_STRIP)
      if (rect !== null)
        items.push({
          kind: 'anchor',
          rect,
          pixels: null,
          painter: run.members[index]?.painter ?? null,
        })
    }
    held = { key, items }
    itemsCache.set(run, held)
  }
  if (!demoPlaying(view) || planView === null) return held.items
  const frame = pixelMask(planView.demo[demoStep % planView.demo.length] ?? [])
  return frame === null
    ? held.items
    : [
        ...held.items,
        {
          kind: 'demo',
          rect: frame.rect,
          pixels: frame,
          painter: run.members[mine]?.painter ?? null,
        },
      ]
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

/** Fly the map to a box of world pixels, with room around a thin line. */
const flyTo = (rect: { x: number; y: number; w: number; h: number }): void =>
  navigateTo({
    x: rect.x + rect.w / 2,
    y: rect.y + rect.h / 2,
    width: Math.max(rect.w, 40),
    height: Math.max(rect.h, 40),
  })

/** Wplace's live territory map. */
const loadTerritory = async (): Promise<TerritoryMap | null> => {
  const response = await fetch(`${BACKEND_ORIGIN}/territory/snapshot`)
  if (!response.ok) return null
  const image = await decodePng(new Uint8Array(await response.arrayBuffer()))
  return territoryMapFromImage(image, PALETTE_RGB)
}

/** For a guard: whether their anchor still belongs to the team, as last read. */
let anchor: 'intact' | 'cut' = 'intact'
let watcher: ReturnType<typeof setInterval> | null = null
let watching: string | null = null

/** The pixels a guard holds: their strip and the end of the wall it thickens. */
const anchorPixels = (run: CaptureRun, index: number): { x: number; y: number }[] => {
  const wall = run.lines.slice(0, run.painters).flatMap(linePixels)
  const end = index === run.painters ? wall.slice(0, GUARD_STRIP) : wall.slice(-GUARD_STRIP)
  return [...linePixels(run.lines[index] ?? []), ...end]
}

/** Read the map once and sound the alarm when any anchor pixel has left the team. */
const checkAnchor = async (run: CaptureRun, index: number): Promise<void> => {
  const team = myTeam
  const map = team === null ? null : await loadTerritory()
  if (map === null || team === null) return
  const cut = anchorPixels(run, index).some((pixel) => {
    const local = worldToArena(pixel)
    return local !== null && map.owner[local.y * map.size + local.x] !== team
  })
  if (cut && anchor === 'intact') {
    const now = localClock()
    scheduleCaptureCues([0, 250, 500].map((after) => ({ at: now + 20 + after, tone: 'go' })))
  }
  anchor = cut ? 'cut' : 'intact'
  render()
}

/** Watch this guard's anchor from just after the wall's last slot until the run ends. */
const watchAnchor = (view: CaptureView, run: CaptureRun | null, index: number): void => {
  const key =
    run !== null && run.startsAt !== null && index >= 0 && isCaptureGuard(run, index)
      ? `${run.id}:${index}:${run.startsAt}`
      : null
  if (key === watching) return
  if (watcher !== null) clearInterval(watcher)
  watcher = null
  watching = key
  anchor = 'intact'
  if (key === null || run === null) return
  const last = captureSlot(run, run.painters - 1)
  const from = last === null ? null : localTime(view, last + WATCH_GRACE_MS)
  const check = () =>
    void checkAnchor(run, index).catch((error) => warn('anchor check failed', String(error)))
  setTimeout(
    () => {
      if (watching !== key) return
      check()
      watcher = setInterval(check, WATCH_MS)
    },
    Math.max(0, (from ?? localClock()) - localClock()),
  )
}

/** Plan walls for the run's group size from the live map, best first. */
const propose = async (groupSize: number, guardCount: number): Promise<void> => {
  proposing = true
  message = undefined
  render()
  try {
    const [team, map] = await Promise.all([loadTeam(), loadTerritory()])
    myTeam = team
    if (team === null) {
      message = 'Join a team in the event first.'
      return
    }
    if (map === null) {
      message = 'Wplace did not send the territory map. Try again.'
      return
    }
    const plans = edgeRectanglePlanner({
      map,
      team,
      painters: groupSize,
      charges: TERRITORY_CHARGES,
    })
    proposals = plans.map((plan, index) => {
      // The guards' strips go after the wall's lines, in the order the guards join.
      const strips = anchorStrips(map, team, plan, GUARD_STRIP).slice(0, guardCount)
      const lines = [...plan.lines, ...strips].map((line) =>
        line.flatMap((pixel) => {
          const world = arenaToWorld(pixel)
          return [world.x, world.y]
        }),
      )
      const outcome = simulateCapture(map, team, { lines: [...strips, ...plan.lines] })
      return {
        id: String(index),
        label: edgeLabel(lines),
        gained: outcome.gained,
        pixels: outcome.painted,
        published: false,
        lines,
        area: enclosedArea(map, team, lines),
      }
    })
    if (proposals.length === 0) message = 'No wall fits along an edge your team holds.'
    // Fly to the best plan, so the shape being chosen is on screen.
    const best = proposals[0]
    const box = best === undefined ? null : pixelMask(best.lines.flatMap(linePixels))?.rect
    if (box != null) flyTo(box)
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

/** Whether this tab's painter switched on "Paint at my capture slot" in Dangerous settings. */
const autoPaintOn = (): boolean => getState().simulatedInput['capture-paint'] === true

/**
 * Arm this painter's slot: schedule the beeps, and at the slot press Paint if the switch is on
 * then. A timeout wakes it shortly before and it waits out the rest precisely, because timers in a
 * busy page fire late. At the deadline it checks again that the run, this painter's place in it and
 * the switch are all as they were, and skips a slot a suspended tab woke too late for.
 */
const armSlot = (view: CaptureView, run: CaptureRun, index: number): void => {
  const key = `${view.server.url}:${run.id}:${index}:${run.startsAt}`
  if (armedSlot === key) return
  const slot = captureSlot(run, index)
  const at = slot === null ? null : localTime(view, slot)
  if (at === null) return
  disarm()
  armedSlot = key
  const go = run.startsAt === null ? null : localTime(view, run.startsAt - CAPTURE_LEAD_MS)
  const silenceCues = scheduleCaptureCues(slotCues(at, go ?? at - CAPTURE_LEAD_MS))
  const fire = () => {
    while (localClock() < at) {
      // Spin out the last few milliseconds; the page is about to paint anyway.
    }
    const now = active()
    const still =
      armedSlot === key &&
      now !== null &&
      now.server.url === view.server.url &&
      now.run?.id === run.id &&
      now.run.startsAt === run.startsAt &&
      memberIndex(now) === index
    if (!still || !autoPaintOn()) return
    const late = localClock() - at
    if (late > MISSED_SLOT_MS) {
      message = 'Your slot passed while this tab was asleep.'
      render()
      return
    }
    const submitted = submitWorldPaintDraft()
    log('capture slot', { index, late, submitted })
    if (!submitted) message = 'Paint was not ready at your slot.'
    render()
  }
  const timeout = setTimeout(fire, Math.max(0, at - localClock() - SPIN_MS))
  disarm = () => {
    clearTimeout(timeout)
    silenceCues()
    armedSlot = null
    disarm = () => {}
  }
}

const phaseOf = (view: CaptureView | null): CaptureRunModel['phase'] => {
  const run = view?.run ?? null
  if (view === null || run === null) return 'none'
  if (run.startsAt === null) return 'gathering'
  const last = captureSlot(run, Math.max(0, run.painters - 1)) ?? run.startsAt
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
    guards: run?.guards ?? guards,
    maxGuards: MAX_CAPTURE_GUARDS,
    anchor:
      run !== null && run.startsAt !== null && mine >= 0 && isCaptureGuard(run, mine)
        ? anchor
        : null,
    members: (run?.members ?? []).map((member, index) => ({
      id: member.sessionId,
      name: member.painter.displayName,
      colour: presenceCss(member.painter.wplaceUserId),
      drafted: member.drafted,
      length: (run?.lines[index]?.length ?? 0) / 2,
      me: index === mine,
      guard: run !== null && isCaptureGuard(run, index),
    })),
    joined: mine >= 0,
    role: run === null || mine < 0 ? null : isCaptureGuard(run, mine) ? 'guard' : 'painter',
    canJoin:
      run !== null &&
      run.startsAt === null &&
      mine < 0 &&
      run.members.length < run.painters + run.guards,
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
    myTurn: run !== null && mine >= 0 && !isCaptureGuard(run, mine) ? mine + 1 : null,
    startsAt: phase === 'countdown' && startAt !== null ? startAt - performance.timeOrigin : null,
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
    case 'set-guards':
      guards = Math.min(MAX_CAPTURE_GUARDS, Math.max(0, Math.round(intent.guards)))
      proposals = []
      break
    case 'open':
      proposals = []
      sendCapture(server, { type: 'capture-open', painters, guards })
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
      void propose(view.run?.painters ?? painters, view.run?.guards ?? guards)
      break
    case 'publish': {
      const chosen = proposals.find(({ id }) => id === intent.id)
      if (chosen !== undefined) sendCapture(server, { type: 'capture-plan', lines: chosen.lines })
      break
    }
    case 'show-line': {
      const mine = memberIndex(view)
      const line = mine < 0 ? undefined : view.run?.lines[mine]
      const box = line === undefined ? null : pixelMask(linePixels(line))?.rect
      if (box != null) flyTo(box)
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
        if (joinedRun !== run.id && myTeam === null)
          void loadTeam()
            .then((team) => {
              myTeam = team
            })
            .catch(() => undefined)
        joinedRun = run.id
        syncCaptureClock(view.server)
      }
      const line = run.lines[mine]
      // Report only what the run does not already say, once per value until it does.
      const drafted = line === undefined ? 0 : draftedOn(line)
      const reported = run.members[mine]?.drafted
      const due = localClock() - draftedSentAt >= DRAFTED_REPORT_MS
      if (drafted === reported) lastDrafted = drafted
      else if (drafted !== lastDrafted && run.startsAt === null && due) {
        lastDrafted = drafted
        draftedSentAt = localClock()
        sendCapture(view.server, { type: 'capture-drafted', drafted })
      }
      // Only a member with pixels to place is armed; an empty line has nothing to submit.
      if (run.startsAt !== null && (run.lines[mine]?.length ?? 0) > 0) armSlot(view, run, mine)
    }
  }
  if (view !== null) {
    watchAnchor(view, run, memberIndex(view))
    if (run !== null && run.lines.length > 0) loadPlanView(run, memberIndex(view))
    if (demoPlaying(view)) {
      demoStep++
      requestMapFrame()
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
      disarm()
    }
    if (view !== null) watchAnchor(view, run, memberIndex(view))
    render()
  })
  onStateChange(render)
}
