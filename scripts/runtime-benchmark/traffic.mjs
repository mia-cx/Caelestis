import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import {
  decodePng,
  decodePresenceDraftMask,
  encodeIndexedPng,
  encodeLiveTileUpload,
  encodePresenceDraft,
  latLngToCanvasPixel,
  MAX_PRESENCE_PEERS,
  PRESENCE_DRAFT_MIN_MS,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_INTEREST_PADDING,
  PRESENCE_VIEWPORT_MIN_MS,
  padRect,
  quantiseRect,
  quantiseToPalette,
  rectCentreDistance,
  rectsIntersect,
  sameRect,
  uuidV7,
} from '../../packages/shared/dist/index.js'
import { assertClaims, claimId, raidClaim, raidClaimSchedule } from './raid-claims.mjs'

export const description = {
  socketsPerUser: 2,
  explorerCycleMs: 9000,
  explorerMovingMs: 5400,
  viewportMinimumMs: PRESENCE_VIEWPORT_MIN_MS,
  draftMinimumMs: PRESENCE_DRAFT_MIN_MS,
  presenceHeartbeatMs: PRESENCE_HEARTBEAT_MS,
  painterViewportMs: 12000,
  painterNudgePixels: 8,
  paintBatchPixels: 30,
  paintBatchMs: 30000,
  tileObservationMs: 9000,
  canvasSnapshotMs: 5000,
  fixture: 'Box Art 1612x2584 at its original canvas coordinates; eight full canvas tiles',
}
export const CLIENT_COMMAND_TIMEOUT_MS = 5000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
export const distribution = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? null
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? null,
  }
}
const key = (rect) => JSON.stringify(rect)
export function schedule(durationMs, model) {
  const events = []
  for (let user = 0; user < model.users; user++) {
    const offset = (user * 37) % 300
    events.push({ at: offset, user, kind: 'viewport', rect: viewport(user, 0, model) })
    if (user < model.explorers) {
      for (
        let at = PRESENCE_VIEWPORT_MIN_MS + offset;
        at < durationMs;
        at += PRESENCE_VIEWPORT_MIN_MS
      ) {
        const phase = (at + user * 900) % 9000
        if (phase <= 5400)
          events.push({ at, user, kind: 'viewport', rect: viewport(user, at, model) })
      }
      for (let at = 1700 + ((user * 181) % 7000); at < durationMs; at += 9000) {
        // Only observations in template coverage reach Caelestis; distant Wplace tiles stay on Wplace.
        const tiles = model.frames[0]
          .filter((tile) => rectsIntersect(padRect(viewport(user, at, model), 200), tile.rect))
          .map((tile) => tile.tile)
        if (tiles.length) events.push({ at, user, kind: 'tile', tiles })
      }
    } else {
      for (
        let at = 12000 + (((user - model.explorers) * 1543) % 12000);
        at < durationMs;
        at += 12000
      )
        events.push({ at, user, kind: 'viewport', rect: viewport(user, at, model) })
      const phase = paintPhase(user, model)
      for (let at = 1000 - (phase % 1000); at < durationMs; at += PRESENCE_DRAFT_MIN_MS) {
        const second = Math.floor((at + phase) / 1000)
        const count = second % 30
        const cycle = Math.floor(second / 30)
        events.push({
          at,
          user,
          kind: 'draft',
          draft: encodePresenceDraft(pixels(user, cycle, count, model)),
        })
        if (count === 0) events.push({ at: at + 10, user, kind: 'paint', cycle: cycle - 1 })
      }
    }
  }
  if (model.raid) {
    events.push(...raidClaimSchedule(durationMs, model))
    for (let user = 0; user < Math.min(model.explorers, 2); user++)
      for (let at = 27000 + user * 1000; at < durationMs; at += 30000)
        events.push({ at, user, kind: 'reconnect' })
  }
  return events
    .filter((event) => event.at < durationMs)
    .sort((a, b) => a.at - b.at || a.user - b.user)
}
function viewport(user, at, model) {
  if (user >= model.explorers) {
    const area = areaFor(user, model)
    return quantiseRect({
      x: area.x - 16 + (Math.floor(at / 12000) % 3) * 8,
      y: area.y - 16,
      w: 96,
      h: 80,
    })
  }
  const shifted = at + user * 900
  const moving = Math.floor(shifted / 9000) * 5400 + Math.min(shifted % 9000, 5400)
  const angle = moving / 11000 + user * 0.65
  const radius = [350, 600, 1100, 1800, 3000, 500, 2500][user % 7]
  const zoom = Math.floor(at / 18000 + user) % 2
  return quantiseRect({
    x: Math.max(0, model.origin.x + 800 + radius * Math.cos(angle)),
    y: Math.max(0, model.origin.y + 900 + radius * Math.sin(angle)),
    w: zoom ? 800 : 400,
    h: zoom ? 600 : 320,
  })
}
const areaFor = (user, model) => ({
  x: model.origin.x + 320 + ((user - model.explorers) % 15) * 64,
  y: model.origin.y + 400 + Math.floor((user - model.explorers) / 15) * 32,
  w: 32,
  h: 16,
})
const paintPhase = (user, model) => ((user - model.explorers) * 7919) % 30000
const pixels = (user, cycle, count, model) => {
  const area = areaFor(user, model)
  return Array.from({ length: count }, (_, i) => {
    const x = area.x + i,
      y = area.y + cycle
    const color = model.indices[(y - model.origin.y) * model.width + x - model.origin.x]
    assert.ok(color < 63, 'paint must overlap opaque artwork')
    return { x, y, color }
  })
}
export async function fixtures(durationMs, users, { raid = false } = {}) {
  const source = JSON.parse(
    await readFile(new URL('../../fixtures/stack-tests/box-art.wplace', import.meta.url), 'utf8'),
  )
  const template = Buffer.from(source.image.dataUrl.split(',')[1], 'base64')
  const image = await decodePng(template)
  const originFloat = latLngToCanvasPixel({ lat: source.bounds.north, lng: source.bounds.west })
  const origin = { x: Math.round(originFloat.x), y: Math.round(originFloat.y) }
  const { indices } = quantiseToPalette(image.pixels)
  const explorers = Math.round(users * 0.7)
  const model = {
    raid,
    users,
    explorers,
    painters: users - explorers,
    origin,
    width: image.width,
    height: image.height,
    indices,
  }
  const canvases = new Map()
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const worldX = origin.x + x,
        worldY = origin.y + y
      const tile = `${Math.floor(worldX / 1000)}/${Math.floor(worldY / 1000)}`
      if (!canvases.has(tile)) canvases.set(tile, new Uint8Array(1000000))
      const color = indices[y * image.width + x]
      canvases.get(tile)[(worldY % 1000) * 1000 + (worldX % 1000)] = color === 63 ? 0 : color
    }
  const setPixel = (pixel, color) =>
    (canvases.get(`${Math.floor(pixel.x / 1000)}/${Math.floor(pixel.y / 1000)}`)[
      (pixel.y % 1000) * 1000 + (pixel.x % 1000)
    ] = color)
  for (let cycle = 0; cycle <= Math.ceil(durationMs / 30000); cycle++)
    for (let user = model.explorers; user < users; user++)
      for (const pixel of pixels(user, cycle, 30, model)) setPixel(pixel, (pixel.color + 1) % 63)
  const paints = []
  for (let user = model.explorers; user < users; user++)
    for (let cycle = 0; cycle <= Math.ceil(durationMs / 30000); cycle++)
      paints.push({ at: (cycle + 1) * 30000 - paintPhase(user, model) + 10, user, cycle })
  paints.sort((a, b) => a.at - b.at)
  let paintIndex = 0
  const encoded = new Map()
  const frames = []
  for (let at = 0; at <= durationMs; at += description.canvasSnapshotMs) {
    const dirty = new Set()
    while (paintIndex < paints.length && paints[paintIndex].at <= at) {
      const paint = paints[paintIndex++]
      for (const pixel of pixels(paint.user, paint.cycle, 30, model)) {
        setPixel(pixel, pixel.color)
        dirty.add(`${Math.floor(pixel.x / 1000)}/${Math.floor(pixel.y / 1000)}`)
      }
    }
    const frame = []
    for (const [tile, canvas] of canvases) {
      if (!encoded.has(tile) || dirty.has(tile)) {
        const bytes = await encodeIndexedPng(1000, 1000, canvas)
        encoded.set(tile, { bytes, sha256: createHash('sha256').update(bytes).digest('hex') })
      }
      const [x, y] = tile.split('/').map(Number)
      frame.push({
        tile,
        rect: { x: x * 1000, y: y * 1000, w: 1000, h: 1000 },
        ...encoded.get(tile),
      })
    }
    frames.push(frame)
  }
  return { ...model, template, frames }
}

/** Replay a fixed arrival schedule against real authenticated application endpoints. */
export async function traffic({
  site,
  adminToken,
  trace,
  fixture,
  warmupMs,
  durationMs,
  begin,
  end,
  commandTimeoutMs = CLIENT_COMMAND_TIMEOUT_MS,
  dropClaims = false,
}) {
  const api = `${site}/backend/v1`
  const clients = []
  const allSockets = []
  const jobs = new Set()
  const errors = []
  let measuring = false
  let serverMetrics
  let backendStages
  let phase = 'warmup'
  const clientDeadlineMisses = { warmup: 0, measured: 0 }
  let warmupJobsDrained = null
  let closing = false
  let sentBytes = 0
  let receivedBytes = 0
  const receivedBytesByType = {}
  const sent = {},
    received = {},
    latencies = {},
    viewportTimes = new Map()
  const dispatchDelay = [],
    presenceLatency = []
  const expectedPaints = []
  const expectedClaims = new Map()
  const claimDeliveries = new Map()
  const hasClaim = (state, id, document, owner, user) =>
    isDeepStrictEqual(state.regions.get(id)?.document ?? null, document) &&
    state.ownedRegionIds.includes(id) === (document !== null && owner === user)
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      const state = client.presence
      if (
        state.socket.readyState !== WebSocket.OPEN ||
        performance.now() - state.lastSend < PRESENCE_HEARTBEAT_MS
      )
        continue
      state.send(
        state.draft
          ? { type: 'presence-update', viewport: state.viewport, draft: state.draft }
          : { type: 'presence-heartbeat' },
      )
    }
  }, 1000)
  const timestamp = () => Math.floor(Date.now() / 1000)
  const record = (kind, ms) => {
    if (!measuring) return
    latencies[kind] ??= []
    latencies[kind].push(ms)
  }
  const request = async (path, body, method = 'GET', token = adminToken, deadlineMs = 30000) => {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(deadlineMs),
    })
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
    return response.status === 204 ? null : response.json()
  }
  const connect = async (user, channel, token) => {
    const url = new URL(`${api}/telemetry/${channel}`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.search = new URLSearchParams({
      season: '0',
      scope: 'public',
      stateVector: '1',
      painterId: String(800000 + user),
      painterName: `Benchmark ${user}`,
      clientId: uuidV7(),
    }).toString()
    const socket = new WebSocket(url, [
      channel === 'presence' ? 'caelestis.presence.v1' : 'caelestis.live.v2',
      `caelestis.auth.b64.${Buffer.from(token).toString('base64url')}`,
    ])
    const pending = new Map()
    const backlog = []
    const waiters = []
    const state = {
      socket,
      peers: new Map(),
      viewport: null,
      draft: null,
      sessionId: null,
      online: 0,
      regions: new Map(),
      ownedRegionIds: [],
      lastSend: 0,
      reconnecting: false,
    }
    allSockets.push(socket)
    socket.addEventListener('error', () => errors.push(`user ${user} ${channel} socket error`))
    socket.addEventListener('close', (event) => {
      if (!closing && !state.reconnecting)
        errors.push(`user ${user} ${channel} closed ${event.code} ${event.reason}`)
    })
    socket.addEventListener('message', ({ data }) => {
      try {
        const message = data === 'pong' ? { type: 'pong' } : JSON.parse(data)
        if (measuring) {
          receivedBytes += Buffer.byteLength(data)
          receivedBytesByType[message.type] =
            (receivedBytesByType[message.type] ?? 0) + Buffer.byteLength(data)
          received[message.type] = (received[message.type] ?? 0) + 1
        }
        if (message.error) errors.push(`${message.type}: ${message.error}`)
        // Deliberate delivery regression proves the raid convergence gate can fail.
        if (dropClaims && user === 0 && message.type === 'regions') return
        if (message.type === 'presence-ready') state.sessionId = message.sessionId
        if (message.type === 'presence-ready' || message.type === 'regions') {
          state.regions = new Map(message.regions.map((region) => [region.id, region]))
          state.ownedRegionIds = message.ownedRegionIds
          for (const id of state.ownedRegionIds)
            assert.equal(state.regions.get(id)?.claimant.wplaceUserId, 800000 + user)
          for (const delivery of claimDeliveries.values()) {
            if (!delivery.remaining.has(user)) continue
            if (!hasClaim(state, delivery.id, delivery.document, delivery.owner, user)) continue
            delivery.remaining.delete(user)
            record('claim-delivery', performance.now() - delivery.started)
            if (delivery.remaining.size === 0) delivery.resolve()
          }
        }
        if (message.type === 'presence-ready' || message.type === 'presence-delta') {
          state.online = message.online
          for (const id of message.remove ?? []) state.peers.delete(id)
          for (const peer of message.upsert ?? message.peers) {
            const previousPeer = state.peers.get(peer.sessionId)
            state.peers.set(peer.sessionId, peer)
            const sample = viewportTimes.get(`${peer.sessionId}:${key(peer.viewport)}`)
            if (
              measuring &&
              previousPeer &&
              !sameRect(previousPeer.viewport, peer.viewport) &&
              sample?.measured &&
              !sample.seen.has(user)
            ) {
              sample.seen.add(user)
              presenceLatency.push(performance.now() - sample.at)
            }
          }
        }
        const command = pending.get(message.requestId)
        if (command) {
          pending.delete(message.requestId)
          command.resolve(message)
        } else {
          const index = waiters.findIndex((waiter) => waiter.type === message.type)
          if (index >= 0) waiters.splice(index, 1)[0].resolve(message)
          else if (message.type === 'presence-ready' || message.type === 'status-snapshot')
            backlog.push(message)
        }
      } catch (error) {
        errors.push(String(error))
      }
    })
    state.send = (message, binary = false) => {
      // Presence state changes during the gap coalesce into the replacement socket's first update.
      if (state.reconnecting) return
      const payload = binary ? message : JSON.stringify(message)
      if (measuring) {
        sentBytes += typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength
        const type = binary ? 'tile-upload' : message.type
        sent[type] = (sent[type] ?? 0) + 1
      }
      socket.send(payload)
      state.lastSend = performance.now()
    }
    const timeout = async (promise, label, deadlineMs = 10000) => {
      let timer
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out`)), deadlineMs)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    state.next = (type) => {
      const index = backlog.findIndex((message) => message.type === type)
      if (index >= 0) return Promise.resolve(backlog.splice(index, 1)[0])
      return timeout(new Promise((resolve) => waiters.push({ type, resolve })), type)
    }
    state.command = async (message, binary) => {
      const requestId = uuidV7()
      const started = performance.now()
      const sentInPhase = phase
      try {
        const result = new Promise((resolve) => pending.set(requestId, { resolve }))
        state.send(
          binary
            ? encodeLiveTileUpload({ ...message, requestId }, binary)
            : { ...message, requestId },
          !!binary,
        )
        const reply = await timeout(result, message.type, commandTimeoutMs)
        assert.equal(reply.error, undefined, JSON.stringify(reply))
        const elapsed = performance.now() - started
        if (elapsed > CLIENT_COMMAND_TIMEOUT_MS) clientDeadlineMisses[sentInPhase]++
        if (sentInPhase === phase) record(message.type, elapsed)
        return reply
      } finally {
        pending.delete(requestId)
      }
    }
    await timeout(
      new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true })
        socket.addEventListener('error', reject, { once: true })
      }),
      'open',
    )
    return state
  }
  const offer = async (client, tiles) => {
    const observations = tiles.map((tile) => ({
      deliveryId: uuidV7(),
      tile: tile.tile,
      sha256: tile.sha256,
      ts: timestamp(),
    }))
    const identity = { wplaceUserId: client.id, displayName: client.name, season: 0 }
    const reply = await client.live.command({
      type: 'tile-offer',
      batch: { ...identity, offers: observations },
    })
    assert.deepEqual(reply.response.rejectedDeliveryIds, [])
    assert.equal(
      reply.response.acknowledgedDeliveryIds.length + reply.response.wanted.length,
      observations.length,
    )
    for (const wanted of reply.response.wanted) {
      const observation = observations.find((item) => item.deliveryId === wanted.deliveryId)
      const tile = tiles.find((item) => item.tile === observation.tile)
      const upload = await client.live.command(
        { type: 'tile-upload', ...identity, ...observation, ...wanted },
        tile.bytes,
      )
      assert.equal(upload.accepted, true)
    }
  }
  const sendViewport = (client, rect) => {
    if (sameRect(client.presence.viewport, rect)) return
    client.presence.viewport = rect
    viewportTimes.set(`${client.presence.sessionId}:${key(rect)}`, {
      at: performance.now(),
      measured: measuring,
      seen: new Set(),
    })
    client.presence.send({ type: 'presence-update', viewport: rect })
  }
  const launch = (work) => {
    const job = work.catch((error) => errors.push(String(error))).finally(() => jobs.delete(job))
    jobs.add(job)
  }
  try {
    const form = new FormData()
    form.set('png', new File([fixture.template], 'benchmark.png', { type: 'image/png' }))
    for (const [field, value] of Object.entries({
      name: 'Runtime benchmark',
      season: '0',
      originX: String(fixture.origin.x),
      originY: String(fixture.origin.y),
    }))
      form.set(field, value)
    const template = await request('/admin/templates', form, 'POST')
    assert.equal(template.chunks.length, fixture.frames[0].length)
    await request(`/admin/templates/${template.templateId}`, { published: true }, 'PATCH')
    const credentials = []
    for (let user = 0; user < fixture.users; user++) {
      const { token } = await request(
        '/admin/tokens',
        { label: `Benchmark ${user}`, scope: 'report' },
        'POST',
      )
      credentials.push(token)
      if (user >= fixture.explorers) {
        const claim = fixture.raid
          ? raidClaim(user, fixture.origin, 1)
          : {
              actor: { wplaceUserId: 800000 + user, displayName: `Benchmark ${user}` },
              label: `Benchmark ${user}`,
              document: {
                items: [
                  {
                    id: 'area',
                    op: 'add',
                    shape: { kind: 'rectangle', ...areaFor(user, fixture) },
                  },
                ],
              },
            }
        expectedClaims.set(claimId(user), claim)
        await request(`/work/regions/${claimId(user)}?season=0`, claim, 'PUT', token)
      }
    }
    if (fixture.raid) {
      for (let extra = fixture.painters; extra < 37; extra++) {
        const user = fixture.explorers + (extra % fixture.painters)
        const id = claimId(user, 1000 + extra)
        const claim = raidClaim(user, { x: fixture.origin.x + extra * 80, y: fixture.origin.y }, 1)
        expectedClaims.set(id, claim)
        await request(`/work/regions/${id}?season=0`, claim, 'PUT', credentials[user])
      }
    }
    const initialClaims = {
      count: expectedClaims.size,
      documentBytes: [...expectedClaims.values()].reduce(
        (sum, claim) => sum + Buffer.byteLength(JSON.stringify(claim.document)),
        0,
      ),
    }
    for (let user = 0; user < fixture.users; user++) {
      const token = credentials[user]
      const client = {
        id: 800000 + user,
        name: `Benchmark ${user}`,
        token,
        presence: await connect(user, 'presence', token),
        live: await connect(user, 'live', token),
      }
      clients.push(client)
      const ready = await client.presence.next('presence-ready')
      assert.equal(ready.regions.length, expectedClaims.size)
      client.live.send({
        type: 'state-vector',
        requestId: uuidV7(),
        revision: null,
        projections: [{ resource: 'world-manifest', scope: 'world', version: null }],
      })
      await client.live.next('status-snapshot')
    }
    await offer(clients[0], fixture.frames[0])
    await request('/admin/server/ingest-timings?reset=true')
    await begin()
    measuring = true
    let start = performance.now()
    const fullTrace = [
      ...trace,
      { at: warmupMs, kind: 'begin' },
      { at: durationMs, kind: 'end' },
    ].sort((a, b) => a.at - b.at)
    for (const event of fullTrace) {
      const remaining = start + event.at - performance.now()
      if (remaining > 0) await sleep(remaining)
      if (event.kind === 'begin') {
        // Offers include their follow-up uploads; settle the whole warmup command chain.
        warmupJobsDrained = jobs.size
        await Promise.all(jobs)
        if (errors.length) throw new Error(errors.join('\n'))
        await end()
        for (const counter of [sent, received, receivedBytesByType, latencies])
          for (const key of Object.keys(counter)) delete counter[key]
        sentBytes = 0
        receivedBytes = 0
        dispatchDelay.length = 0
        presenceLatency.length = 0
        viewportTimes.clear()
        await request('/admin/server/ingest-timings?reset=true')
        await begin()
        phase = 'measured'
        // Draining must not shorten the measured trace or cause a catch-up burst.
        start = performance.now() - warmupMs
        continue
      }
      if (event.kind === 'end') {
        await Promise.all(jobs)
        serverMetrics = await end()
        measuring = false
        backendStages = await request('/admin/server/ingest-timings')
        break
      }
      if (measuring) dispatchDelay.push(Math.max(0, performance.now() - start - event.at))
      const client = clients[event.user]
      if (event.kind === 'reconnect') {
        const previous = client.presence
        previous.reconnecting = true
        previous.socket.close(1000, 'benchmark reconnect')
        const started = performance.now()
        launch(
          (async () => {
            const replacement = await connect(event.user, 'presence', client.token)
            await replacement.next('presence-ready')
            client.presence = replacement
            if (previous.viewport !== null) sendViewport(client, previous.viewport)
            replacement.draft = previous.draft
            if (replacement.draft !== null)
              replacement.send({ type: 'presence-update', draft: replacement.draft })
            record('presence-reconnect', performance.now() - started)
          })(),
        )
      }
      if (event.kind === 'claim') {
        const id = event.id
        const claim = raidClaim(event.user, fixture.origin, event.version)
        const deleting = event.operation === 'delete'
        if (deleting) expectedClaims.delete(id)
        else expectedClaims.set(id, claim)
        const started = performance.now()
        let timer
        const delivered = new Promise((resolve, reject) => {
          // Consecutive edits can overlap within the five-second delivery deadline.
          claimDeliveries.set(event, {
            id,
            document: deleting ? null : claim.document,
            owner: event.user,
            started,
            remaining: new Set(
              clients
                .filter(
                  (client) =>
                    !hasClaim(
                      client.presence,
                      id,
                      deleting ? null : claim.document,
                      event.user,
                      client.id - 800000,
                    ),
                )
                .map((client) => client.id - 800000),
            ),
            resolve,
          })
          if (claimDeliveries.get(event).remaining.size === 0) resolve()
          timer = setTimeout(
            () => reject(new Error(`Claim ${event.operation} delivery timed out`)),
            commandTimeoutMs,
          )
        })
        launch(
          Promise.all([
            request(
              `/work/regions/${id}?season=0`,
              deleting ? { actor: claim.actor } : claim,
              deleting ? 'DELETE' : 'PUT',
              client.token,
              commandTimeoutMs,
            ).then(() => record(`claim-${event.operation}`, performance.now() - started)),
            delivered,
          ]).finally(() => {
            clearTimeout(timer)
            claimDeliveries.delete(event)
          }),
        )
      }
      if (event.kind === 'viewport') sendViewport(client, event.rect)
      if (event.kind === 'draft') {
        client.presence.draft = event.draft
        client.presence.send({ type: 'presence-update', draft: event.draft })
      }
      if (event.kind === 'tile')
        launch(
          offer(
            client,
            fixture.frames[Math.floor(event.at / description.canvasSnapshotMs)].filter((tile) =>
              event.tiles.includes(tile.tile),
            ),
          ),
        )
      if (event.kind === 'paint') {
        const batch = pixels(event.user, event.cycle, 30, fixture)
        const grouped = Map.groupBy(
          batch,
          (pixel) => `${Math.floor(pixel.x / 1000)}/${Math.floor(pixel.y / 1000)}`,
        )
        const paint = {
          eventId: uuidV7(),
          wplaceUserId: client.id,
          displayName: client.name,
          season: 0,
          ts: timestamp(),
          painted: batch.length,
          tiles: [...grouped].map(([tile, entries]) => {
            const [x, y] = tile.split('/').map(Number)
            return {
              x,
              y,
              pixels: {
                x: entries.map((p) => p.x % 1000),
                y: entries.map((p) => p.y % 1000),
                colors: entries.map((p) => p.color),
              },
            }
          }),
        }
        expectedPaints.push(paint)
        launch(
          client.live
            .command({ type: 'paint-report', event: paint })
            .then((reply) => assert.equal(reply.result, 'recorded')),
        )
      }
      if (errors.length) throw new Error(errors.join('\n'))
    }
    // Let the final batch settle, then compare every client's peer set and state with the interest rules.
    await sleep(1000)
    for (const client of clients) {
      assertClaims(client.presence, expectedClaims, client.id - 800000)
      assert.equal(client.presence.online, fixture.users)
      const expected = clients
        .filter(
          (other) =>
            other !== client &&
            [other.presence.viewport, other.presence.draft?.rect].some(
              (rect) =>
                rect &&
                rectsIntersect(
                  padRect(client.presence.viewport, PRESENCE_INTEREST_PADDING),
                  quantiseRect(rect),
                ),
            ),
        )
        .sort((a, b) => {
          const distance = (other) =>
            Math.min(
              ...[other.presence.viewport, other.presence.draft?.rect]
                .filter(Boolean)
                .map((rect) => rectCentreDistance(client.presence.viewport, quantiseRect(rect))),
            )
          return (
            distance(a) - distance(b) || a.presence.sessionId.localeCompare(b.presence.sessionId)
          )
        })
        .slice(0, MAX_PRESENCE_PEERS)
      assert.deepEqual(
        [...client.presence.peers.keys()].sort(),
        expected.map((other) => other.presence.sessionId).sort(),
      )
      for (const other of expected) {
        const peer = client.presence.peers.get(other.presence.sessionId)
        assert.deepEqual(peer.viewport, other.presence.viewport)
        assert.deepEqual(draftPixels(peer.draft), draftPixels(other.presence.draft))
      }
    }
    if (expectedPaints.length) {
      const first = expectedPaints[0]
      const last = expectedPaints.at(-1)
      const totals = await request(
        `/telemetry/painters?templateIds=${template.templateId}&from=${first.ts - 120}&to=${last.ts + 120}`,
      )
      for (const client of clients.slice(fixture.explorers))
        assert.equal(
          totals.painters.find((p) => p.wplaceUserId === client.id)?.placed,
          expectedPaints.filter((paint) => paint.wplaceUserId === client.id).length * 30,
        )
      assert.equal(
        (await clients[fixture.explorers].live.command({ type: 'paint-report', event: first }))
          .result,
        'duplicate',
      )
    }
    assert.deepEqual(errors, [])
    return {
      phase,
      warmupJobsDrained,
      serverMetrics,
      backendStages,
      sent,
      received,
      sentBytes,
      receivedBytes,
      receivedBytesByType,
      initialClaims,
      latencies: Object.fromEntries(
        Object.entries(latencies).map(([kind, values]) => [kind, distribution(values)]),
      ),
      presenceDeliveryMs: distribution(presenceLatency),
      dispatchDelayMs: distribution(dispatchDelay),
      correctness: {
        online: fixture.users,
        sockets: allSockets.length,
        finalPeerSetsAndDrafts: true,
        finalClaimsAndOwnership: true,
        claims: expectedClaims.size,
        paintEvents: expectedPaints.length,
        paintPixels: expectedPaints.length * 30,
        duplicateRejected: expectedPaints.length > 0,
        clientDeadlineMs: CLIENT_COMMAND_TIMEOUT_MS,
        clientDeadlineMisses,
        errors,
      },
      raw: { latencies, presenceLatency, dispatchDelay },
    }
  } catch (error) {
    if (measuring) {
      try {
        serverMetrics = await end()
      } catch (metricsError) {
        errors.push(`Resource collection failed: ${String(metricsError)}`)
      }
      measuring = false
    }
    error.benchmarkResult = {
      phase,
      warmupJobsDrained,
      serverMetrics,
      sent,
      received,
      sentBytes,
      receivedBytes,
      latencies: Object.fromEntries(
        Object.entries(latencies).map(([kind, values]) => [kind, distribution(values)]),
      ),
      presenceDeliveryMs: distribution(presenceLatency),
      dispatchDelayMs: distribution(dispatchDelay),
      correctness: {
        online: clients.filter((client) => client.presence.socket.readyState === WebSocket.OPEN)
          .length,
        sockets: allSockets.filter((socket) => socket.readyState === WebSocket.OPEN).length,
        finalPeerSetsAndDrafts: false,
        clientDeadlineMs: CLIENT_COMMAND_TIMEOUT_MS,
        clientDeadlineMisses,
        errors: [...errors, String(error)],
      },
      raw: { latencies, presenceLatency, dispatchDelay },
    }
    throw error
  } finally {
    clearInterval(heartbeat)
    closing = true
    for (const socket of allSockets) socket.close()
    await Promise.all(jobs)
  }
}

// The server snaps draft bounds outward to its grid. Compare the actual painted coordinates.
function draftPixels(draft) {
  if (draft === null) return null
  const mask = decodePresenceDraftMask(draft)
  assert.ok(mask)
  const coordinates = []
  for (let i = 0; i < mask.length; i++) {
    if (mask[i])
      coordinates.push([
        draft.rect.x + (i % draft.rect.w),
        draft.rect.y + Math.floor(i / draft.rect.w),
      ])
  }
  assert.equal(coordinates.length, draft.pixels)
  return coordinates
}
