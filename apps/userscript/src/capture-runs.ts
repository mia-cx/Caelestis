import plannerSource from 'worker:capture-planner'
import {
  CAPTURE_LEAD_MS,
  type CaptureRun,
  captureSlot,
  captureStep,
  captureSteps,
  decodePng,
  GUARD_MARGIN,
  isCaptureGuard,
  isEventServer,
  latLngToCanvasPixel,
  MAX_CAPTURE_GUARDS,
  MAX_CAPTURE_PAINTERS,
  PALETTE_RGB,
  type RegionShapePixels,
  TERRITORY_ARENA,
  TERRITORY_TEAMS,
  type TerritoryMap,
  type TerritoryTeam,
  TILE_SIZE,
  territoryEventLive,
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
import { type PlannedProposal, type PlanRequest, planProposals } from './capture-planning.js'
import {
  anchorRects,
  anchorWatch,
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
import { getMap, type MapLike, onMapAttached } from './map-handle.js'
import { requestMapFrame, viewportCentre } from './map-view.js'
import {
  type CaptureView,
  captureViews,
  localClock,
  onPresenceChange,
  sendCapture,
  setPresenceTeam,
  syncCaptureClock,
} from './presence-client.js'
import { presenceCss } from './presence-colour.js'
import { canRunServerCaptures } from './server-connections.js'
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
/** How often Wplace refreshes its territory map; guards and planning read it no more often. */
const SNAPSHOT_MS = 5_000
/** How long after a guard's slot their anchor is first checked, so the start can land. */
const WATCH_GRACE_MS = 3_000
/** How often a member's drafted count is re-read and the countdown redrawn. */
const TICK_MS = 100
/** How long the card stays on "done" after the last slot before it may be closed. */
const DONE_AFTER_MS = 3_000
/** How long before a slot the precise wait starts; setTimeout alone can be late by this much. */
const SPIN_MS = 30
/** Room to schedule a cue that is due now, so Web Audio does not drop it as already past. */
const CUE_LEAD_MS = 20
/** A slot this far behind when the tab wakes is skipped: the next painter has gone already. */
const MISSED_SLOT_MS = 250
/** The most often a member reports their drafted count; the latest count goes each time. */
const DRAFTED_REPORT_MS = 1_000
/** How long a failed team lookup waits before trying again. */
const TEAM_RETRY_MS = 5_000
/** How long a failed plan map load waits before trying again. */
const PLAN_RETRY_MS = 5_000
/** The share of the view the arena must fill for the card to show. */
const ARENA_VIEW_SHARE = 0.25

interface Proposal extends CaptureProposal {
  /** Each painter's line as flat world coordinates. */
  readonly lines: readonly (readonly number[])[]
  /** What the wall would enclose. */
  readonly area: RegionShapePixels | null
}

let painters = 3
let guards = MAX_CAPTURE_GUARDS
let proposals: readonly Proposal[] = []
let message: string | undefined
let element: CaelestisElement<'caelestis-capture-run'> | null = null
let timer: ReturnType<typeof setInterval> | null = null
/** Run id and member index whose slot this tab has already acted on, or armed. */
let armedSlot: string | null = null
/** Cancels the armed slot's beeps and Paint, when the run restarts, changes or closes. */
let disarm: () => void = () => {}
/** When this tab last reported its drafted count, so drafting never floods the socket. */
let draftedSentAt = Number.NEGATIVE_INFINITY
let teamTriedAt = Number.NEGATIVE_INFINITY
let joinedRun: string | null = null
let lastDrafted = -1

/**
 * The event server this tab coordinates on, with its run: the one whose run it has joined, else one
 * it runs captures on (as an administrator or event runner), one with a run first, else the first.
 * A tab works on one event server at a time, so runs on any other stay out of the card rather than
 * competing for it.
 */
const active = (): CaptureView | null => {
  const views = captureViews().filter((view) => isEventServer(view.server.info))
  const administered = views.filter((view) => canRunServerCaptures(view.server))
  return (
    views.find((view) => memberIndex(view) >= 0) ??
    administered.find((view) => view.run !== null) ??
    administered[0] ??
    views[0] ??
    null
  )
}

const memberIndex = (view: CaptureView): number =>
  view.run?.members.findIndex((member) => member.sessionId === view.sessionId) ?? -1

/** Local `localClock()` time of a server time, once this tab's clock is synced. */
const localTime = (view: CaptureView, serverTime: number): number | null =>
  view.clockOffset === null ? null : serverTime - view.clockOffset

/**
 * This painter's event team, once read. Event servers share presence and capture runs within a
 * team, so it decides which run this tab sees; everything about a run itself uses the run's own
 * team.
 */
let myTeam: TerritoryTeam | null = null

/** Read this painter's team from Wplace's own leaderboard, until it is known. */
const refreshTeam = async (): Promise<TerritoryTeam | null> => {
  if (myTeam !== null) return myTeam
  teamTriedAt = localClock()
  const team = await loadTeam()
  // Lookups can overlap; a late answer from before the painter joined never undoes a known team.
  myTeam ??= team
  return myTeam
}

/** Keep event servers told this painter's team, reading it until it is known. */
const syncTeam = (): void => {
  setPresenceTeam(myTeam)
  if (myTeam !== null || accountIdentity() === null) return
  if (localClock() - teamTriedAt < TEAM_RETRY_MS) return
  if (!captureViews().some((view) => isEventServer(view.server.info))) return
  void refreshTeam()
    .then(setPresenceTeam)
    .catch(() => undefined)
}

/** Whether this tab has drafted a pixel in a colour that claims for `team`. */
const draftedPixel = (team: TerritoryTeam, { x, y }: { x: number; y: number }): boolean => {
  const { colour, dark } = TERRITORY_TEAMS[team]
  const tile = { x: Math.floor(x / TILE_SIZE), y: Math.floor(y / TILE_SIZE) }
  const offset = (y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE)
  const drafted = comparisonDraftPixelAt(tile, offset)
  return drafted === colour || drafted === dark
}

const draftedOn = (team: TerritoryTeam, line: readonly number[]): number =>
  linePixels(line).filter((pixel) => draftedPixel(team, pixel)).length

/** This painter's own line, split into what they have drafted and what is left to draft. */
const mineCache = new Map<string, readonly CaptureItem[]>()
const mineItems = (
  team: TerritoryTeam,
  line: readonly number[],
  colour: Rgb,
): readonly CaptureItem[] => {
  const pixels = linePixels(line)
  const done = pixels.map((pixel) => draftedPixel(team, pixel))
  const key = `${team}|${line.join(',')}|${done.map(Number).join('')}`
  const cached = mineCache.get(key)
  if (cached !== undefined) return cached
  const drafted = pixelMask(pixels.filter((_, index) => done[index]))
  const left = pixelMask(pixels.filter((_, index) => !done[index]))
  const items = [
    ...(drafted === null ? [] : [masked('mine', drafted, colour)]),
    ...(left === null ? [] : [masked('todo', left, colour)]),
  ]
  // One line at a time: the previous split is never drawn again.
  mineCache.clear()
  mineCache.set(key, items)
  return items
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
let planFailed: { readonly key: string; readonly at: number } | null = null
let demoStep = 0

const planKey = (run: CaptureRun, mine: number): string =>
  `${run.id}:${mine}:${run.lines.map((line) => line.join(',')).join(';')}`

/** Read the map for a published plan once, for its enclosed area and this painter's demo. */
const loadPlanView = (run: CaptureRun, mine: number): void => {
  const key = planKey(run, mine)
  if (planView?.key === key || planLoading === key) return
  // A new plan or a new place in it: the old guide and area point at the wrong pixels.
  planView = null
  // A failed load waits before trying again rather than refetching on every tick.
  if (planFailed?.key === key && localClock() - planFailed.at < PLAN_RETRY_MS) return
  planLoading = key
  const { team } = run
  void loadTerritory()
    .then((map) => {
      if (planLoading !== key) return
      if (map === null) {
        planFailed = { key, at: localClock() }
        return
      }
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
    .catch((error) => {
      planFailed = { key, at: localClock() }
      warn('capture plan view failed', String(error))
    })
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

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Whether this painter's demo shows: while gathering, until their line is drafted. */
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

type Rgb = readonly [number, number, number]

/** A team's colour and its dark shade as unit RGB. */
const teamShades = (team: TerritoryTeam): { readonly colour: Rgb; readonly dark: Rgb } => {
  const { colour, dark } = TERRITORY_TEAMS[team]
  const unit = (index: number): Rgb => {
    const [r, g, b] = PALETTE_RGB[index] ?? [255, 255, 255]
    return [r / 255, g / 255, b / 255]
  }
  return { colour: unit(colour), dark: unit(dark) }
}

const masked = (kind: CaptureItemKind, pixels: RegionShapePixels, colour: Rgb): CaptureItem => ({
  kind,
  rect: pixels.rect,
  pixels,
  colour,
})

const NO_ITEMS: readonly CaptureItem[] = []

/**
 * Remembers the value last built from the same parts, compared by identity. The map asks for the
 * capture items every frame; handing back the same masks lets it skip rebuilding the scene and
 * re-uploading their textures until something they come from changes.
 */
const lastBuilt = <T>(): ((parts: readonly unknown[], build: () => T) => T) => {
  let held: { readonly parts: readonly unknown[]; readonly value: T } | null = null
  return (parts, build) => {
    if (
      held === null ||
      held.parts.length !== parts.length ||
      held.parts.some((part, index) => part !== parts[index])
    )
      held = { parts, value: build() }
    return held.value
  }
}
const candidatesBuilt = lastBuilt<readonly CaptureItem[]>()
const demoBuilt = lastBuilt<CaptureItem | null>()
const shownBuilt = lastBuilt<readonly CaptureItem[]>()

/** Each candidate plan's masks and the team they are coloured for, kept as long as the plan is. */
const proposalItems = new WeakMap<
  Proposal,
  { readonly team: TerritoryTeam; readonly items: readonly CaptureItem[] }
>()

/** A candidate's area and lines in its team's colour, built once per plan and team. */
const itemsOf = (proposal: Proposal, team: TerritoryTeam, colour: Rgb): readonly CaptureItem[] => {
  const held = proposalItems.get(proposal)
  if (held?.team === team) return held.items
  const items = [
    ...(proposal.area === null ? [] : [masked('area', proposal.area, colour)]),
    ...proposal.lines.flatMap((line) => {
      const pixels = pixelMask(linePixels(line))
      return pixels === null ? [] : [masked('pending', pixels, colour)]
    }),
  ]
  proposalItems.set(proposal, { team, items })
  return items
}

/**
 * The plans an administrator is choosing between, while the run they were planned for gathers,
 * less the one already published. A teammate's progress arrives as a new run with the same plans,
 * so the same masks come back and the map uploads nothing again. Once the previews hide, the last
 * ones are let go rather than held until the next time plans show.
 */
const candidateItems = (run: CaptureRun, colour: Rgb): readonly CaptureItem[] => {
  if (run.startsAt !== null || proposalsRun !== run.id)
    return candidatesBuilt(NO_ITEMS, () => NO_ITEMS)
  const shown = proposals
    .filter((proposal) => !sameLines(run.lines, proposal.lines))
    .map((proposal) => itemsOf(proposal, run.team, colour))
  return candidatesBuilt(shown, () => shown.flat())
}

/**
 * What the shown run, or the plans an administrator is choosing between, puts on the map, all in
 * the run's team colours: the colour painters paint in for this painter's own leg, their anchor
 * and the shape, and the team's dark shade for everyone else's legs.
 */
export const captureItems = (): readonly CaptureItem[] => {
  const view = active()
  const run = view?.run ?? null
  if (view === null || run === null) return NO_ITEMS
  const { colour, dark } = teamShades(run.team)
  if (run.lines.length === 0) return candidateItems(run, colour)
  const mine = memberIndex(view)
  const key = `${planView?.key ?? ''}|${run.members.map(({ drafted }) => drafted).join(',')}`
  let held = itemsCache.get(run)
  if (held?.key !== key) {
    const items: CaptureItem[] = []
    if (planView?.area) items.push(masked('area', planView.area, colour))
    run.lines.forEach((line, index) => {
      const pixels = pixelMask(linePixels(line))
      if (pixels !== null) {
        const kind = kindOf(run, index, mine)
        // This painter's own line is added per frame below, split by what they have drafted.
        if (kind !== 'mine') items.push(masked(kind, pixels, dark))
      }
    })
    for (let index = run.painters; index < run.lines.length; index++)
      for (const rect of anchorRects(run, index, GUARD_MARGIN))
        items.push({ kind: 'anchor', rect, pixels: null, colour: index === mine ? colour : dark })
    held = { key, items }
    itemsCache.set(run, held)
  }
  // Candidates from Propose again show beside the published plan until Go.
  const myLine = mine < 0 ? undefined : run.lines[mine]
  const own = myLine === undefined ? NO_ITEMS : mineItems(run.team, myLine, colour)
  const candidates = candidateItems(run, colour)
  const plan = planView
  // Under reduced motion the guide holds still on the whole route instead of crawling.
  const step =
    plan === null || !demoPlaying(view) ? null : reducedMotion() ? -1 : demoStep % plan.demo.length
  const demo =
    plan === null || step === null
      ? null
      : demoBuilt([plan, step, run.team], () => {
          const frame = pixelMask(step < 0 ? plan.demo.flat() : (plan.demo[step] ?? []))
          return frame === null ? null : masked('demo', frame, colour)
        })
  return shownBuilt([held.items, own, candidates, demo], () => [
    ...held.items,
    ...own,
    ...candidates,
    ...(demo === null ? [] : [demo]),
  ])
}

/** This painter's team in the event, from Wplace's own leaderboard. */
const loadTeam = async (): Promise<TerritoryTeam | null> => {
  const response = await fetch(`${BACKEND_ORIGIN}/territory/leaderboard`, {
    credentials: 'include',
  })
  // Null means Wplace answered and this painter has no team; anything else is a failed lookup.
  if (!response.ok) throw new Error(`territory leaderboard ${response.status}`)
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
/** Read the map once and sound the alarm when any anchor pixel has left the team. */
const checkAnchor = async (run: CaptureRun, index: number, key: string): Promise<void> => {
  const { team } = run
  const map = await loadTerritory()
  // The run may have closed or moved on while the map was on its way.
  if (map === null || watching !== key) return
  const cut = anchorWatch(run, index, GUARD_MARGIN).some((pixel) => {
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
const watchAnchor = (view: CaptureView | null, run: CaptureRun | null, index: number): void => {
  const key =
    view !== null &&
    run !== null &&
    run.startsAt !== null &&
    index >= 0 &&
    isCaptureGuard(run, index)
      ? `${run.id}:${index}:${run.startsAt}`
      : null
  if (key === watching) return
  if (watcher !== null) clearInterval(watcher)
  watcher = null
  watching = key
  anchor = 'intact'
  if (key === null || run === null || view === null) return
  const last = captureSlot(run, run.painters - 1)
  const from = last === null ? null : localTime(view, last + WATCH_GRACE_MS)
  const check = () =>
    void checkAnchor(run, index, key).catch((error) => warn('anchor check failed', String(error)))
  setTimeout(
    () => {
      if (watching !== key) return
      check()
      watcher = setInterval(check, SNAPSHOT_MS)
    },
    Math.max(0, (from ?? localClock()) - localClock()),
  )
}

/** How often live planning checks where the map is centred; it re-plans only when that moved. */
const PLAN_INTERVAL_MS = 500

/** The server and run live planning works for, or null when it is not planning. */
type Planning = { readonly server: string; readonly run: string }
let planningFor: Planning | null = null
/** The run the shown proposals were planned for; they show only while it gathers. */
let proposalsRun: string | null = null
let planBusy = false
/** Group, focus and snapshot of the last plan, so nothing is planned twice. */
let planInputs = ''
let planTimer: ReturnType<typeof setInterval> | null = null
/** Wplace's map as planning last read it, reused until Wplace refreshes it. */
let snapshotRead: {
  readonly bytes: Uint8Array
  readonly hash: number
  readonly at: number
} | null = null
let snapshotFailedAt = Number.NEGATIVE_INFINITY

/** FNV-1a over the snapshot: enough to tell one five-second map from the next. */
const hashBytes = (bytes: Uint8Array): number => {
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193)
  return hash >>> 0
}

let plannerWorker: Worker | null = null
let plannerFailed = false
let plannerJob = 0
const plannerWaiting = new Map<
  number,
  (reply: { proposals?: PlannedProposal[]; error?: string }) => void
>()

/** Plan on the worker, or inline where the page allows no worker. */
const runPlanner = async (request: PlanRequest): Promise<PlannedProposal[]> => {
  if (plannerWorker === null && !plannerFailed && plannerSource !== '') {
    try {
      const url = URL.createObjectURL(new Blob([plannerSource], { type: 'text/javascript' }))
      plannerWorker = new Worker(url)
      URL.revokeObjectURL(url)
      plannerWorker.onmessage = ({ data }) => {
        plannerWaiting.get(data.id)?.(data)
        plannerWaiting.delete(data.id)
      }
      plannerWorker.onerror = () => {
        plannerFailed = true
        plannerWorker?.terminate()
        plannerWorker = null
        for (const settle of plannerWaiting.values()) settle({ error: 'planner worker failed' })
        plannerWaiting.clear()
      }
    } catch (error) {
      plannerFailed = true
      warn('capture planner runs on the page', String(error))
    }
  }
  const worker = plannerWorker
  if (worker === null) return planProposals(request)
  const id = ++plannerJob
  const reply = await new Promise<{ proposals?: PlannedProposal[]; error?: string }>((settle) => {
    plannerWaiting.set(id, settle)
    worker.postMessage({ id, ...request }, [request.snapshot.buffer])
  })
  if (reply.proposals === undefined) throw new Error(reply.error ?? 'planner failed')
  return reply.proposals
}

/** A proposal's id: its wall's two anchors, so it names the same shape across passes. */
const proposalId = ({ lines }: PlannedProposal): string => {
  const a = lines[0] ?? []
  const b = lines[1] ?? []
  return `${a[0]},${a[1]}:${b[0]},${b[1]}`
}

/** Wplace's map, read again only once Wplace has refreshed it, and not soon after a failure. */
const plannedSnapshot = async (): Promise<typeof snapshotRead> => {
  const now = localClock()
  if (snapshotRead !== null && now - snapshotRead.at < SNAPSHOT_MS) return snapshotRead
  if (now - snapshotFailedAt < PLAN_RETRY_MS) return null
  const response = await fetch(`${BACKEND_ORIGIN}/territory/snapshot`)
  if (!response.ok) {
    snapshotFailedAt = now
    return null
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  snapshotRead = { bytes, hash: hashBytes(bytes), at: now }
  return snapshotRead
}

/** One pass: re-plan the run if the map or where it is centred changed since the last plan. */
const planPass = async (run: CaptureRun, bound: Planning): Promise<void> => {
  if (planBusy) return
  planBusy = true
  try {
    // Plans hold the pixel at the middle of the view, so panning picks the stretch of border.
    const centre = viewportCentre()
    const focus = centre === null ? null : worldToArena(centre)
    if (focus === null) {
      proposals = []
      planInputs = ''
      message = 'Centre the map on the arena where you want a wall.'
      render()
      return
    }
    const snapshot = await plannedSnapshot()
    if (snapshot === null || planningFor !== bound) return
    const inputs = `${run.painters}|${run.guards}|${focus.x},${focus.y}|${snapshot.hash}`
    if (inputs === planInputs) return
    const planned = await runPlanner({
      // The worker takes the bytes it is sent; later passes reuse the original.
      snapshot: snapshot.bytes.slice(),
      team: run.team,
      painters: run.painters,
      guards: run.guards,
      focus,
    })
    if (planningFor !== bound) return
    // Only a finished plan counts as done, so a failed one runs again on the next pass.
    planInputs = inputs
    proposalsRun = run.id
    proposals = planned.map((proposal) => ({
      ...proposal,
      id: proposalId(proposal),
      published: false,
    }))
    message =
      proposals.length === 0
        ? 'No wall fits here. Centre the map just outside your border.'
        : undefined
    log(
      'capture proposals',
      proposals.map(({ label, gained, pixels }) => ({ label, gained, pixels })),
    )
    render()
    requestMapFrame()
  } catch (error) {
    warn('capture planning failed', String(error))
    message = 'Planning failed. It tries again shortly.'
  } finally {
    planBusy = false
  }
}

/**
 * Re-plan continuously until the administrator locks a plan in, starts, or closes the run. Planning
 * belongs to the run it started for: it stops when the card shows another run, or this tab is no
 * longer that server's administrator.
 */
const startPlanning = (view: CaptureView, run: CaptureRun): void => {
  stopPlanning()
  const bound: Planning = { server: view.server.url, run: run.id }
  planningFor = bound
  planInputs = ''
  message = undefined
  const pass = () => {
    const now = active()
    const current = now?.run ?? null
    if (
      now === null ||
      current === null ||
      now.server.url !== bound.server ||
      current.id !== bound.run ||
      current.startsAt !== null ||
      !canRunServerCaptures(now.server)
    ) {
      stopPlanning()
      render()
      return
    }
    void planPass(current, bound)
  }
  pass()
  planTimer = setInterval(pass, PLAN_INTERVAL_MS)
}

const stopPlanning = (): void => {
  planningFor = null
  if (planTimer !== null) clearInterval(planTimer)
  planTimer = null
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
const slotCues = (slot: number, go: number): CaptureCue[] => {
  const now = localClock()
  // Go reaches this tab a moment after the server stamped it; the opening cue plays on arrival,
  // unless the tab woke too late for it to come before the slot.
  const opening = Math.max(go, now + CUE_LEAD_MS)
  return [
    ...(opening < slot ? [{ at: opening, tone: 'tick' as const }] : []),
    ...TICK_SECONDS.map((seconds) => ({
      at: slot - seconds * 1_000,
      tone: 'tick' as const,
    })).filter(({ at }) => at > go && at > now),
    ...(slot > now ? [{ at: slot, tone: 'go' as const }] : []),
  ]
}

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

const TEAM_NAMES = ['Blue', 'Orange', 'Green', 'Purple'] as const satisfies Record<
  TerritoryTeam,
  string
>

/** Why an event server shows this tab nothing: its token belongs to another team. */
const refusedMessage = (team: TerritoryTeam): string =>
  `This token is for team ${TEAM_NAMES[team]}. Switch to a Wplace account on team ${TEAM_NAMES[team]} to see its runs.`

const model = (view: CaptureView | null): CaptureRunModel | null => {
  if (view === null) return null
  const run = view.run
  const admin = canRunServerCaptures(view.server)
  const refused = view.refusedTeam === null ? undefined : refusedMessage(view.refusedTeam)
  if (run === null && !admin && refused === undefined) return null
  const status = refused ?? message
  const mine = memberIndex(view)
  const phase = phaseOf(view)
  // A wall shorter than the group leaves a line empty: that member has nothing to paint.
  const idle = run !== null && run.lines.length > 0 && (run.lines[mine]?.length ?? 0) === 0
  const slot = run !== null && mine >= 0 && !idle ? captureSlot(run, mine) : null
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
      view.canWrite &&
      run !== null &&
      run.startsAt === null &&
      mine < 0 &&
      run.members.length < run.painters + run.guards,
    proposals: (run !== null && proposalsRun === run.id ? proposals : []).map((proposal) => ({
      id: proposal.id,
      label: proposal.label,
      gained: proposal.gained,
      pixels: proposal.pixels,
      published: run !== null && run.lines.length > 0 && sameLines(run.lines, proposal.lines),
    })),
    proposing: planningFor !== null,
    canStart:
      admin &&
      run !== null &&
      run.startsAt === null &&
      run.lines.length > 0 &&
      run.members.length >= run.lines.length,
    mySlotAt: phase === 'countdown' && slotAt !== null ? slotAt - performance.timeOrigin : null,
    myTurn:
      run !== null && mine >= 0 && !idle && !isCaptureGuard(run, mine)
        ? captureStep(run, mine) + 1
        : null,
    turns: run === null ? Math.ceil(painters / 2) : captureSteps(run),
    startsAt: phase === 'countdown' && startAt !== null ? startAt - performance.timeOrigin : null,
    ...(status === undefined ? {} : { message: status }),
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
    case 'open': {
      // The run is for this administrator's team.
      void refreshTeam()
        .then((team) => {
          // The administrator chose this server; a change while Wplace answered drops it.
          if (active()?.server.url !== server.url) return
          setPresenceTeam(team)
          if (team === null) message = 'Join a team in the event first.'
          else {
            proposals = []
            sendCapture(server, { type: 'capture-open', painters, guards })
          }
        })
        .catch(() => {
          message = "Couldn't read your event team from Wplace. Try again."
        })
        .finally(render)
      break
    }
    case 'join':
      if (view.run === null) break
      primeCaptureAudio()
      // The session's reported team picks the run; the id stops a join to one since replaced.
      sendCapture(server, { type: 'capture-join', run: view.run.id })
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
      if (planningFor !== null) stopPlanning()
      else if (view.run !== null) startPlanning(view, view.run)
      break
    case 'publish': {
      const chosen = proposals.find(({ id }) => id === intent.id)
      // Locking a plan in ends live planning; the other candidates stay on screen until Go.
      if (chosen !== undefined) {
        stopPlanning()
        sendCapture(server, { type: 'capture-plan', lines: chosen.lines })
      }
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
      stopPlanning()
      proposals = []
      primeCaptureAudio()
      sendCapture(server, { type: 'capture-go' })
      break
    case 'close':
      stopPlanning()
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
        joinedRun = run.id
        syncCaptureClock(view.server)
      }
      const line = run.lines[mine]
      // Report only what the run does not already say, once per value until it does.
      const drafted = line === undefined ? 0 : draftedOn(run.team, line)
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
  watchAnchor(view, run, view === null ? -1 : memberIndex(view))
  if (view !== null) {
    if (run !== null && run.lines.length > 0) loadPlanView(run, memberIndex(view))
    if (demoPlaying(view) && !reducedMotion()) {
      demoStep++
      requestMapFrame()
    }
  }
  render()
}

/** Whether the event arena fills enough of the map's view to be what the painter is looking at. */
const arenaInView = (): boolean => {
  const map = getMap()
  if (map === null) return false
  const { clientWidth, clientHeight } = map.getCanvas()
  const a = latLngToCanvasPixel(map.unproject([0, 0]))
  const b = latLngToCanvasPixel(map.unproject([clientWidth, clientHeight]))
  const left = TERRITORY_ARENA.tileX * TILE_SIZE
  const top = TERRITORY_ARENA.tileY * TILE_SIZE
  const overlap = (lo: number, hi: number, start: number) =>
    Math.max(0, Math.min(hi, start + TERRITORY_ARENA.size) - Math.max(lo, start))
  const view = (b.x - a.x) * (b.y - a.y)
  return view > 0 && overlap(a.x, b.x, left) * overlap(a.y, b.y, top) >= ARENA_VIEW_SHARE * view
}

const removeElement = (): void => {
  element?.remove()
  element = null
}

/**
 * Show the card only while the event runs and its arena is in view. Panning away hides the card but
 * keeps the run ticking, so a member's slot and a guard's watch never depend on where they look.
 */
const render = (): void => {
  if (!territoryEventLive(Date.now())) {
    // The event is over: nothing plans, waits for a slot or watches an anchor any more.
    stopPlanning()
    disarm()
    watchAnchor(null, null, -1)
  }
  const next = territoryEventLive(Date.now()) ? model(active()) : null
  if (next === null || accountIdentity() === null) {
    removeElement()
    if (timer !== null) clearInterval(timer)
    timer = null
    return
  }
  timer ??= setInterval(tick, TICK_MS)
  if (arenaInView()) ensureElement().model = next
  else removeElement()
}

/** Install once, after presence. */
export const installCaptureRuns = (): void => {
  let lastRun: string | null = null
  onPresenceChange(() => {
    syncTeam()
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
    watchAnchor(view, run, view === null ? -1 : memberIndex(view))
    render()
  })
  onStateChange(render)
  // The account can load after the last presence change; the team is read once it has, whether
  // or not anything else changes.
  setInterval(syncTeam, TEAM_RETRY_MS)
  // A style swap attaches the same map again; follow each map once.
  let followed: MapLike | null = null
  onMapAttached((map) => {
    if (map === followed) return
    followed?.off('moveend', render)
    map.on('moveend', render)
    followed = map
  })
}
