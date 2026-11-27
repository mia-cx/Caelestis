// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: standalone benchmark configuration.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

// The backend's own dependency, so the driver and both builds share one protocol implementation.
const {
  arenaToWorld,
  decodePresenceDraftMask,
  encodePresenceDraft,
  MAX_PRESENCE_PEERS,
  PRESENCE_DRAFT_MIN_MS,
  PRESENCE_INTEREST_PADDING,
  PRESENCE_TICK_MS,
  padRect,
  quantiseRect,
  rectCentreDistance,
  rectsIntersect,
  TERRITORY_ARENA,
  WORLD_TEMPLATE_SURFACE,
} = await import(
  pathToFileURL(
    createRequire(new URL('../../apps/backend/package.json', import.meta.url)).resolve(
      '@caelestis/shared',
    ),
  ).href
)

// Presence fan-out on an event server, through the real compiled coordinator and Node socket host.
// Sessions are restored attachments, as after hibernation, so no HTTP, database or ws framing is
// measured: only what the room does with viewport and draft updates and the bytes it sends.
//
//   node scripts/runtime-benchmark/presence-event.mjs BASELINE_DIST CANDIDATE_DIST OUTPUT_PREFIX
//   node scripts/runtime-benchmark/presence-event.mjs --run DIST USERS OUTPUT.json
//
// BENCH_USERS (1024,2048), BENCH_PAIRS (3), BENCH_WARMUP_STEPS (20) and BENCH_MEASURE_STEPS (100)
// size the comparison; one step is one 300 ms presence tick. By default the driver runs each tick
// itself after the step's updates. BENCH_CADENCE=1 instead leaves the coordinator's own timer
// running under continuous arrivals, to measure how often deltas actually reach a session.
// BENCH_HASH=1 hashes every byte each session receives, to prove two builds send identical
// messages; it adds driver CPU, so hashed runs are not timing results, and it needs the driven
// ticks. BENCH_CPU_PROFILE=DIR writes a Node CPU profile per run.

const TEAMS = 4
/** Share of sessions that crowd the borders between team quadrants; the rest roam the arena. */
const BORDER_SHARE = 0.75
/**
 * In every group of this many sessions, the first `TEAMS` parse their messages and are checked
 * against the expected peers. Teams are assigned round-robin, so every team has observers.
 */
const OBSERVER_GROUP = 64
/** Pixels one painter drafts at once: Territory Weekend's full charge. */
const DRAFT_PIXELS = 60
/** Updates are spread over the step in this many slices, as sockets deliver them between ticks. */
const SLICES = 10

async function compare(baseline, candidate, output) {
  assert(baseline && candidate && output, 'Usage: presence-event.mjs BASELINE CANDIDATE OUTPUT')
  const userCounts = (process.env.BENCH_USERS ?? '1024,2048').split(',').map(Number)
  const pairs = Number(process.env.BENCH_PAIRS ?? 3)
  await mkdir(dirname(resolve(output)), { recursive: true })
  const results = []
  for (const users of userCounts)
    for (let pair = 0; pair < pairs; pair++)
      for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const build = resolve(variant === 'baseline' ? baseline : candidate)
        const file = resolve(`${output}-${users}-${pair}-${variant}.json`)
        const profile = process.env.BENCH_CPU_PROFILE
        await new Promise((done, fail) => {
          const child = spawn(
            process.execPath,
            [
              ...(profile ? ['--cpu-prof', `--cpu-prof-dir=${profile}`] : []),
              new URL(import.meta.url).pathname,
              '--run',
              build,
              String(users),
              file,
            ],
            { stdio: 'inherit' },
          )
          child.on('error', fail)
          child.on('exit', (code) =>
            code === 0 ? done() : fail(new Error(`${variant} ${users} exited ${code}`)),
          )
        })
        const result = JSON.parse(await readFile(file, 'utf8'))
        const previous = results.find((entry) => entry.variant === variant)
        if (previous) assert.equal(result.buildSha256, previous.buildSha256, `${variant} changed`)
        const same = results.find((entry) => entry.users === users)
        if (same) {
          assert.equal(result.traceSha256, same.traceSha256, 'trace changed')
          if (result.streamSha256 !== null && same.streamSha256 !== null)
            assert.equal(result.streamSha256, same.streamSha256, 'builds sent different bytes')
        }
        results.push({ pair, variant, ...result })
        await writeFile(`${output}-comparison.json`, JSON.stringify(results, null, 2))
        console.log(
          `${users} ${pair} ${variant}: tick p50 ${result.tickMs.p50.toFixed(1)} p95 ${result.tickMs.p95.toFixed(1)} ms, ` +
            `delivery gap p50 ${result.deliveryGapMs.p50?.toFixed(0)} p95 ${result.deliveryGapMs.p95?.toFixed(0)} ms, ` +
            `CPU ${result.cpuMsPerTick.toFixed(0)} ms/tick, select ${result.stageMs.select.toFixed(0)} serialize ${result.stageMs.serialize.toFixed(0)} ms, loop p99 ${result.eventLoopMs.p99.toFixed(1)} ms, ` +
            `${(result.bytesPerSecond / 1e6).toFixed(1)} MB/s`,
        )
      }
}

/** Mulberry32: a small deterministic generator, so every build replays the same trace. */
function generator(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const distribution = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? null
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) }
}

const align = (value) => Math.round(value / 8) * 8
const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

/**
 * Deterministic sessions on the Territory Weekend arena. Teams own the four quadrants; border
 * painters crowd hotspots on the midlines their quadrant shares with its neighbours, with small
 * zoomed-in viewports. Roamers pan larger viewports across the whole arena. Every session moves
 * its viewport each tick and redrafts its 60-pixel charge each second.
 */
function model(users) {
  const origin = arenaToWorld({ x: 0, y: 0 })
  const half = TERRITORY_ARENA.size / 2
  return Array.from({ length: users }, (_, index) => {
    const random = generator(index + 1)
    const team = index % TEAMS
    const corner = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ][team]
    const border = random() < BORDER_SHARE
    // Three hotspots per midline segment; painters gather around one, on their own side.
    const vertical = random() < 0.5
    const along = (Math.floor(random() * 3) + 0.5) * (half / 3) + (random() - 0.5) * 120
    const across = half + (corner[vertical ? 'x' : 'y'] ? 1 : -1) * random() * 80
    const anchor = border
      ? {
          x: (vertical ? across : corner.x * half + along) + origin.x,
          y: (vertical ? corner.y * half + along : across) + origin.y,
        }
      : {
          x: origin.x + random() * TERRITORY_ARENA.size,
          y: origin.y + random() * TERRITORY_ARENA.size,
        }
    const size = border ? { w: 480, h: 288 } : { w: 1280, h: 768 }
    return {
      index,
      sessionId: index.toString(16).padStart(16, '0'),
      team,
      border,
      random,
      anchor,
      size,
      centre: { ...anchor },
      viewport: null,
      draft: null,
      draftOffset: Math.floor(random() * PRESENCE_DRAFT_MIN_MS),
      viewportOffset: Math.floor(random() * PRESENCE_TICK_MS),
    }
  })
}

/** Move one session's viewport by at least one grid cell; border painters stay by their anchor. */
function moveViewport(session) {
  const { random, anchor, centre, size, border } = session
  const reach = border ? 64 : 600
  const stride = border ? 16 : 48
  const origin = arenaToWorld({ x: 0, y: 0 })
  centre.x = clamp(centre.x + (random() - 0.5) * 2 * stride, anchor.x - reach, anchor.x + reach)
  centre.y = clamp(centre.y + (random() - 0.5) * 2 * stride, anchor.y - reach, anchor.y + reach)
  if (!border) {
    centre.x = clamp(centre.x, origin.x, origin.x + TERRITORY_ARENA.size)
    centre.y = clamp(centre.y, origin.y, origin.y + TERRITORY_ARENA.size)
  }
  let next = {
    x: align(centre.x - size.w / 2),
    y: align(centre.y - size.h / 2),
    w: size.w,
    h: size.h,
  }
  if (session.viewport && next.x === session.viewport.x && next.y === session.viewport.y)
    next = { ...next, x: next.x + 8 }
  session.viewport = next
  return next
}

/** A fresh 60-pixel draft inside the session's viewport, unaligned as the userscript packs it. */
function redraft(session) {
  const { random, viewport } = session
  const left = viewport.x + Math.floor(random() * (viewport.w - 40))
  const top = viewport.y + Math.floor(random() * (viewport.h - 40))
  const pixels = []
  const seen = new Set()
  while (pixels.length < DRAFT_PIXELS) {
    const x = left + Math.floor(random() * 37)
    const y = top + Math.floor(random() * 37)
    if (seen.has(`${x},${y}`)) continue
    seen.add(`${x},${y}`)
    pixels.push({ x, y })
  }
  session.draft = encodePresenceDraft(pixels)
  return session.draft
}

const draftPixels = (draft) => {
  if (draft == null) return null
  const bits = decodePresenceDraftMask(draft)
  const pixels = []
  for (let bit = 0; bit < bits.length; bit++)
    if (bits[bit] === 1)
      pixels.push(
        `${draft.rect.x + (bit % draft.rect.w)},${draft.rect.y + Math.floor(bit / draft.rect.w)}`,
      )
  return pixels.sort()
}

/** The peers the server must leave an observer with, by the protocol's own selection rule. */
function expectedPeers(observer, sessions) {
  const interest = padRect(observer.viewport, PRESENCE_INTEREST_PADDING)
  const rects = (session) =>
    [session.viewport, session.draft && quantiseRect(session.draft.rect)].filter(Boolean)
  return sessions
    .filter(
      (other) =>
        other !== observer &&
        other.team === observer.team &&
        rects(other).some((rect) => rectsIntersect(interest, rect)),
    )
    .map((other) => ({
      other,
      distance: Math.min(
        ...rects(other).map((rect) => rectCentreDistance(observer.viewport, rect)),
      ),
    }))
    .sort((a, b) => a.distance - b.distance || a.other.sessionId.localeCompare(b.other.sessionId))
    .slice(0, MAX_PRESENCE_PEERS)
    .map(({ other }) => other)
}

async function run(root, users, output) {
  const load = (file) => import(pathToFileURL(`${root}/${file}`).href)
  const [{ PresenceCoordinator }, { NodeLiveHost }, { IngestTimings }] = await Promise.all([
    load('presence/coordinator.js'),
    load('node/live.js'),
    load('metrics/ingest-timing.js'),
  ])
  const warmupSteps = Number(process.env.BENCH_WARMUP_STEPS ?? 20)
  const measuredSteps = Number(process.env.BENCH_MEASURE_STEPS ?? 100)
  const hashing = process.env.BENCH_HASH === '1'
  const cadence = process.env.BENCH_CADENCE === '1'
  assert(!(hashing && cadence), 'The timer batches updates by arrival time, so streams differ')
  const sessions = model(users)
  const byId = new Map(sessions.map((session) => [session.sessionId, session]))
  for (const session of sessions) moveViewport(session)

  const stored = new Map()
  const storage = {
    get: async (key) => stored.get(key),
    put: async (key, value) => void stored.set(key, value),
    delete: async (key) => stored.delete(key),
    getAlarm: async () => stored.get('alarm') ?? null,
    setAlarm: async (at) => void stored.set('alarm', at),
    deleteAlarm: async () => void stored.delete('alarm'),
  }
  let room
  const host = new NodeLiveHost(storage, () => room)
  const traffic = { bytes: 0, messages: 0 }
  const traceHash = createHash('sha256')
  const now = Date.now()
  for (const session of sessions) {
    const observer = session.index % OBSERVER_GROUP < TEAMS
    session.inbox = observer ? [] : null
    session.deliveries = observer ? [] : null
    session.peers = observer ? new Map() : null
    session.hash = hashing ? createHash('sha256') : null
    const { client } = host.connect({
      sessionId: session.sessionId,
      season: 0,
      surface: WORLD_TEMPLATE_SURFACE,
      painter: { wplaceUserId: 100_000 + session.index, displayName: `Painter ${session.index}` },
      tokenHash: createHash('sha256').update(String(session.index)).digest('hex'),
      clientHash: createHash('sha256').update(`client ${session.index}`).digest('hex'),
      credentialScope: 'report',
      anonymous: false,
      revocable: false,
      viewport: session.viewport,
      draftRect: null,
      draftPixels: 0,
      lastSeenAt: now,
      renewedAt: now,
      team: session.team,
    })
    client.attach({
      readyState: 1,
      bufferedAmount: 0,
      send(message) {
        traffic.bytes += message.length
        traffic.messages++
        session.inbox?.push(message)
        if (measuring && message.startsWith('{"type":"presence-delta"'))
          session.deliveries?.push(performance.now())
        session.hash?.update(message)
      },
      close(code, reason) {
        assert.fail(`session ${session.index} closed: ${code} ${reason}`)
      },
      on() {},
    })
    session.socket = client
  }
  const regions = {
    listRegions: async () => [],
    regionOwners: async () => [],
    renewRegions: async () => {},
  }
  const timings = new IngestTimings()
  /** Whether the measured phase is running; deliveries and tick samples count only then. */
  let measuring = false
  const ticks = []
  /** Coordinator stage time summed over the measured ticks. */
  const stages = {}
  const record = timings.record.bind(timings)
  timings.record = (command, stage, durationMs) => {
    record(command, stage, durationMs)
    if (!measuring || command !== 'presence') return
    if (stage === 'total') ticks.push(durationMs)
    stages[stage] = (stages[stage] ?? 0) + durationMs
  }
  room = new PresenceCoordinator(
    host,
    { season: 0, surface: WORLD_TEMPLATE_SURFACE },
    { regions, readAccessToken: async () => null },
    timings,
    async () => {},
    true,
  )
  // Unless measuring cadence, the driver runs each tick itself after the step's updates, so every
  // build sees the same updates in the same tick even when a loaded machine delays the slices.
  if (!cadence) room.stop()

  /** Apply what each observer received, and check no other team's session reached it. */
  const drainObservers = () => {
    for (const session of sessions) {
      if (session.inbox === null) continue
      for (const message of session.inbox) {
        const event = JSON.parse(message)
        if (event.type === 'presence-ready') session.peers = new Map()
        if (event.type !== 'presence-ready' && event.type !== 'presence-delta') continue
        for (const id of event.remove ?? []) session.peers.delete(id)
        for (const peer of event.peers ?? event.upsert) {
          assert.notEqual(peer.sessionId, session.sessionId, 'a session received itself')
          assert.equal(byId.get(peer.sessionId).team, session.team, 'a peer crossed teams')
          session.peers.set(peer.sessionId, peer)
        }
        assert(session.peers.size <= MAX_PRESENCE_PEERS)
      }
      session.inbox.length = 0
    }
  }

  // Recovery: every restored session is owed a ready event with its peers.
  await room.alarm()
  drainObservers()

  const messageMs = []
  const loop = monitorEventLoopDelay({ resolution: 10 })
  let cpu
  let started
  let rssTotal = 0
  let bytesAtStart = 0
  let messagesAtStart = 0
  const base = performance.now()
  for (let step = 0; step < warmupSteps + measuredSteps; step++) {
    if (step === warmupSteps) {
      measuring = true
      bytesAtStart = traffic.bytes
      messagesAtStart = traffic.messages
      loop.enable()
      cpu = process.cpuUsage()
      started = performance.now()
    }
    const measured = step >= warmupSteps
    const stepAt = step * PRESENCE_TICK_MS
    const slices = Array.from({ length: SLICES }, () => [])
    for (const session of sessions) {
      const update = { type: 'presence-update', viewport: moveViewport(session) }
      const draftDue =
        Math.floor((stepAt + PRESENCE_TICK_MS - session.draftOffset) / PRESENCE_DRAFT_MIN_MS) >
        Math.floor((stepAt - session.draftOffset) / PRESENCE_DRAFT_MIN_MS)
      if (draftDue) update.draft = redraft(session)
      const text = JSON.stringify(update)
      traceHash.update(text)
      slices[Math.floor((session.viewportOffset * SLICES) / PRESENCE_TICK_MS)].push([session, text])
    }
    // Under the coordinator's timer, arrivals keep to a fixed schedule as real clients would.
    const stepStarted = cadence ? base + step * PRESENCE_TICK_MS : performance.now()
    const until = (offset) =>
      new Promise((done) => setTimeout(done, Math.max(0, stepStarted + offset - performance.now())))
    for (let slice = 0; slice < SLICES; slice++) {
      await until((slice * PRESENCE_TICK_MS) / SLICES)
      for (const [session, text] of slices[slice]) {
        const at = performance.now()
        room.webSocketMessage(session.socket, text)
        if (measured) messageMs.push(performance.now() - at)
      }
    }
    if (!cadence) {
      // The coordinator's own timer would fire one tick interval after the step's first update.
      await until(PRESENCE_TICK_MS)
      await room.alarm()
    }
    if (measured) rssTotal += process.memoryUsage.rss()
    drainObservers()
  }
  if (cadence) await new Promise((done) => setTimeout(done, PRESENCE_TICK_MS))
  const wallMs = performance.now() - started
  const used = process.cpuUsage(cpu)
  measuring = false
  loop.disable()
  if (cadence) {
    // Settle the last arrivals before checking the observers' final state.
    room.stop()
    await new Promise((done) => setTimeout(done, PRESENCE_TICK_MS * 2))
    await room.alarm()
    drainObservers()
  }
  const deliveryGaps = sessions.flatMap(({ deliveries }) =>
    (deliveries ?? []).slice(1).map((at, index) => at - deliveries[index]),
  )

  for (const observer of sessions) {
    if (observer.peers === null) continue
    const expected = expectedPeers(observer, sessions)
    assert.deepEqual(
      [...observer.peers.keys()].sort(),
      expected.map(({ sessionId }) => sessionId).sort(),
      `observer ${observer.index} peers`,
    )
    for (const other of expected) {
      const peer = observer.peers.get(other.sessionId)
      assert.deepEqual(peer.viewport, other.viewport)
      assert.deepEqual(draftPixels(peer.draft), draftPixels(other.draft))
    }
  }

  const buildHash = createHash('sha256')
  for (const file of ['presence/coordinator.js', 'presence/peer-grid.js', 'node/live.js'])
    buildHash.update(await readFile(`${root}/${file}`))
  const cpuMs = (used.user + used.system) / 1_000
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
  const result = {
    users,
    teams: TEAMS,
    mode: cadence ? 'coordinator timer, continuous arrivals' : 'driver-run ticks',
    observers: sessions.filter(({ peers }) => peers !== null).length,
    observerTeams: [
      ...new Set(sessions.filter(({ peers }) => peers !== null).map(({ team }) => team)),
    ],
    warmupSteps,
    measuredSteps,
    runtime: process.version,
    buildSha256: buildHash.digest('hex'),
    traceSha256: traceHash.digest('hex'),
    streamSha256: hashing
      ? createHash('sha256')
          .update(sessions.map(({ hash }) => hash.digest('hex')).join(''))
          .digest('hex')
      : null,
    tickMs: { ...distribution(ticks), mean: mean(ticks) },
    stageMs: stages,
    deliveryGapMs: distribution(deliveryGaps),
    messageMs: { ...distribution(messageMs), totalMs: messageMs.reduce((a, b) => a + b, 0) },
    wallMs,
    realtimeFactor: wallMs / (measuredSteps * PRESENCE_TICK_MS),
    ticks: ticks.length,
    cpuMs,
    cpuPercent: (cpuMs / wallMs) * 100,
    cpuMsPerTick: cpuMs / ticks.length,
    eventLoopMs: {
      p50: loop.percentile(50) / 1e6,
      p99: loop.percentile(99) / 1e6,
      max: loop.max / 1e6,
    },
    meanRssMiB: rssTotal / measuredSteps / 2 ** 20,
    messages: traffic.messages - messagesAtStart,
    bytes: traffic.bytes - bytesAtStart,
    bytesPerSecond: ((traffic.bytes - bytesAtStart) / (measuredSteps * PRESENCE_TICK_MS)) * 1_000,
    correctness: true,
  }
  await writeFile(output, JSON.stringify(result, null, 2))
}

const args = process.argv.slice(2)
if (args[0] === '--run') await run(resolve(args[1]), Number(args[2]), resolve(args[3]))
else await compare(...args)
