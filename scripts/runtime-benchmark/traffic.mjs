import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  decodePresenceDraftMask,
  encodeIndexedPng,
  encodeLiveTileUpload,
  encodePresenceDraft,
  PRESENCE_DRAFT_MIN_MS,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_INTEREST_PADDING,
  PRESENCE_VIEWPORT_MIN_MS,
  padRect,
  quantiseRect,
  rectsIntersect,
  sameRect,
  uuidV7,
} from '../../packages/shared/dist/index.js'

export const description = {
  users: 10,
  explorers: 7,
  painters: 3,
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
  fixture:
    '256x128 published template at 100,100; one 1000x1000 canvas tile with deterministic palette pattern',
}
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
export function schedule(durationMs) {
  const events = []
  for (let user = 0; user < 10; user++) {
    const offset = user * 37
    events.push({ at: offset, user, kind: 'viewport', rect: viewport(user, 0) })
    if (user < 7) {
      for (
        let at = PRESENCE_VIEWPORT_MIN_MS + offset;
        at < durationMs;
        at += PRESENCE_VIEWPORT_MIN_MS
      ) {
        const phase = (at + user * 900) % 9000
        if (phase <= 5400) events.push({ at, user, kind: 'viewport', rect: viewport(user, at) })
      }
      for (let at = 1700 + user * 181; at < durationMs; at += 9000) {
        // Only observations in template coverage reach Caelestis; distant Wplace tiles stay on Wplace.
        if (rectsIntersect(padRect(viewport(user, at), 200), { x: 0, y: 0, w: 1000, h: 1000 }))
          events.push({ at, user, kind: 'tile' })
      }
    } else {
      for (let at = 12000 + offset; at < durationMs; at += 12000)
        events.push({ at, user, kind: 'viewport', rect: viewport(user, at) })
      for (let at = 1000 + offset; at < durationMs; at += PRESENCE_DRAFT_MIN_MS) {
        const second = Math.floor((at - offset) / 1000)
        const count = second % 30
        const cycle = Math.floor(second / 30)
        events.push({
          at,
          user,
          kind: 'draft',
          draft: encodePresenceDraft(pixels(user, cycle, count)),
        })
        if (count === 0) events.push({ at: at + 10, user, kind: 'paint', cycle: cycle - 1 })
      }
    }
  }
  return events
    .filter((event) => event.at < durationMs)
    .sort((a, b) => a.at - b.at || a.user - b.user)
}
function viewport(user, at) {
  if (user >= 7)
    return { x: 96 + (user - 7) * 64 + (Math.floor(at / 12000) % 3) * 8, y: 96, w: 96, h: 80 }
  const angle = at / 11000 + user * 0.65
  const radius = [350, 600, 1100, 1800, 3000, 500, 2500][user]
  const zoom = Math.floor(at / 18000 + user) % 2
  return quantiseRect({
    x: Math.max(0, 300 + radius * (1 + Math.cos(angle))),
    y: Math.max(0, 200 + radius * (1 + Math.sin(angle))),
    w: zoom ? 800 : 400,
    h: zoom ? 600 : 320,
  })
}
const pixels = (user, cycle, count = 30) =>
  Array.from({ length: count }, (_, i) => ({ x: 112 + (user - 7) * 64 + i, y: 112 + cycle }))

export async function fixtures(durationMs) {
  const template = await encodeIndexedPng(256, 128, new Uint8Array(256 * 128).fill(31))
  const canvas = new Uint8Array(1000 * 1000)
  for (let y = 0; y < 1000; y++)
    for (let x = 0; x < 1000; x++)
      canvas[y * 1000 + x] = (Math.floor(x / 7) * 13 + Math.floor(y / 11) * 17) % 31
  const tiles = []
  for (let cycle = 0; cycle <= Math.ceil(durationMs / 30000); cycle++) {
    if (cycle)
      for (let user = 7; user < 10; user++)
        for (const { x, y } of pixels(user, cycle - 1)) canvas[y * 1000 + x] = 31
    const bytes = await encodeIndexedPng(1000, 1000, canvas)
    tiles.push({ bytes, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  return { template, tiles }
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
}) {
  const api = `${site}/backend/v1`
  const clients = []
  const allSockets = []
  const jobs = new Set()
  const errors = []
  let measuring = false
  let closing = false
  let sentBytes = 0
  let receivedBytes = 0
  const sent = {},
    received = {},
    latencies = {},
    viewportTimes = new Map()
  const dispatchDelay = [],
    presenceLatency = []
  const expectedPaints = []
  const timestamp = () => Math.floor(Date.now() / 1000)
  const record = (kind, ms) => {
    if (!measuring) return
    latencies[kind] ??= []
    latencies[kind].push(ms)
  }
  const request = async (path, body, method = 'GET', token = adminToken) => {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    })
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
    return response.status === 204 ? null : response.json()
  }
  const connect = async (user, channel, token) => {
    const url = new URL(`${api}/telemetry/${channel}`)
    url.protocol = 'ws:'
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
      lastSend: 0,
    }
    allSockets.push(socket)
    socket.addEventListener('error', () => errors.push(`user ${user} ${channel} socket error`))
    socket.addEventListener('close', (event) => {
      if (!closing) errors.push(`user ${user} ${channel} closed ${event.code} ${event.reason}`)
    })
    socket.addEventListener('message', ({ data }) => {
      try {
        const message = data === 'pong' ? { type: 'pong' } : JSON.parse(data)
        if (measuring) {
          receivedBytes += Buffer.byteLength(data)
          received[message.type] = (received[message.type] ?? 0) + 1
        }
        if (message.error) errors.push(`${message.type}: ${message.error}`)
        if (message.type === 'presence-ready') state.sessionId = message.sessionId
        if (message.type === 'presence-ready' || message.type === 'presence-delta') {
          state.online = message.online
          for (const id of message.remove ?? []) state.peers.delete(id)
          for (const peer of message.upsert ?? message.peers) {
            state.peers.set(peer.sessionId, peer)
            const sample = viewportTimes.get(`${peer.sessionId}:${key(peer.viewport)}`)
            if (measuring && sample?.measured && !sample.seen.has(user)) {
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
      const payload = binary ? message : JSON.stringify(message)
      if (measuring) {
        sentBytes += typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength
        const type = binary ? 'tile-upload' : message.type
        sent[type] = (sent[type] ?? 0) + 1
      }
      socket.send(payload)
      state.lastSend = performance.now()
    }
    const timeout = async (promise, label) => {
      let timer
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10000)
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
      try {
        const result = new Promise((resolve) => pending.set(requestId, { resolve }))
        state.send(
          binary
            ? encodeLiveTileUpload({ ...message, requestId }, binary)
            : { ...message, requestId },
          !!binary,
        )
        const reply = await timeout(result, message.type)
        assert.equal(reply.error, undefined, JSON.stringify(reply))
        record(message.type, performance.now() - started)
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
  const offer = async (client, tile) => {
    const observation = { deliveryId: uuidV7(), tile: '0/0', sha256: tile.sha256, ts: timestamp() }
    const identity = { wplaceUserId: client.id, displayName: client.name, season: 0 }
    const reply = await client.live.command({
      type: 'tile-offer',
      batch: { ...identity, offers: [observation] },
    })
    assert.deepEqual(reply.response.rejectedDeliveryIds, [])
    assert.equal(reply.response.acknowledgedDeliveryIds.length + reply.response.wanted.length, 1)
    for (const wanted of reply.response.wanted) {
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
      originX: '100',
      originY: '100',
    }))
      form.set(field, value)
    const template = await request('/admin/templates', form, 'POST')
    await request(`/admin/templates/${template.templateId}`, { published: true }, 'PATCH')
    for (let user = 0; user < 10; user++) {
      const { token } = await request(
        '/admin/tokens',
        { label: `Benchmark ${user}`, scope: 'report' },
        'POST',
      )
      const client = {
        id: 800000 + user,
        name: `Benchmark ${user}`,
        token,
        presence: await connect(user, 'presence', token),
        live: await connect(user, 'live', token),
      }
      clients.push(client)
      await client.presence.next('presence-ready')
      client.live.send({
        type: 'state-vector',
        requestId: uuidV7(),
        revision: null,
        projections: [{ resource: 'world-manifest', scope: 'world', version: null }],
      })
      await client.live.next('status-snapshot')
      if (user >= 7)
        await request(
          `/work/regions/${uuidV7()}?season=0`,
          {
            actor: { wplaceUserId: client.id, displayName: client.name },
            label: client.name,
            document: {
              items: [
                {
                  id: 'area',
                  op: 'add',
                  shape: { kind: 'rectangle', x: 112 + (user - 7) * 64, y: 112, w: 32, h: 16 },
                },
              ],
            },
          },
          'PUT',
          token,
        )
    }
    await offer(clients[0], fixture.tiles[0])
    const start = performance.now()
    const fullTrace = [
      ...trace,
      { at: warmupMs, kind: 'begin' },
      { at: durationMs, kind: 'end' },
    ].sort((a, b) => a.at - b.at)
    let serverMetrics
    for (const event of fullTrace) {
      await sleep(start + event.at - performance.now())
      if (event.kind === 'begin') {
        await begin()
        measuring = true
        continue
      }
      if (event.kind === 'end') {
        await Promise.all(jobs)
        serverMetrics = await end()
        measuring = false
        break
      }
      if (measuring) dispatchDelay.push(Math.max(0, performance.now() - start - event.at))
      const client = clients[event.user]
      if (event.kind === 'viewport') sendViewport(client, event.rect)
      if (event.kind === 'draft') {
        client.presence.draft = event.draft
        client.presence.send({ type: 'presence-update', draft: event.draft })
      }
      if (event.kind === 'tile') launch(offer(client, fixture.tiles[Math.floor(event.at / 30000)]))
      if (event.kind === 'paint') {
        const batch = pixels(event.user, event.cycle)
        const paint = {
          eventId: uuidV7(),
          wplaceUserId: client.id,
          displayName: client.name,
          season: 0,
          ts: timestamp(),
          painted: batch.length,
          tiles: [
            {
              x: 0,
              y: 0,
              pixels: {
                x: batch.map((p) => p.x),
                y: batch.map((p) => p.y),
                colors: batch.map(() => 31),
              },
            },
          ],
        }
        expectedPaints.push(paint)
        launch(
          client.live
            .command({ type: 'paint-report', event: paint })
            .then((reply) => assert.equal(reply.result, 'recorded')),
        )
      }
      for (const quiet of clients)
        if (performance.now() - quiet.presence.lastSend >= PRESENCE_HEARTBEAT_MS)
          quiet.presence.send(
            quiet.presence.draft
              ? {
                  type: 'presence-update',
                  viewport: quiet.presence.viewport,
                  draft: quiet.presence.draft,
                }
              : { type: 'presence-heartbeat' },
          )
      if (errors.length) throw new Error(errors.join('\n'))
    }
    // Let the final batch settle, then compare every client's peer set and state with the interest rules.
    await sleep(1000)
    for (const client of clients) {
      assert.equal(client.presence.online, 10)
      const expected = clients.filter(
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
      for (const client of clients.slice(7))
        assert.equal(
          totals.painters.find((p) => p.wplaceUserId === client.id)?.placed,
          expectedPaints.filter((paint) => paint.wplaceUserId === client.id).length * 30,
        )
      assert.equal(
        (await clients[7].live.command({ type: 'paint-report', event: first })).result,
        'duplicate',
      )
    }
    assert.deepEqual(errors, [])
    return {
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
        online: 10,
        sockets: allSockets.length,
        finalPeerSetsAndDrafts: true,
        paintEvents: expectedPaints.length,
        paintPixels: expectedPaints.length * 30,
        duplicateRejected: expectedPaints.length > 0,
        errors,
      },
      raw: { latencies, presenceLatency, dispatchDelay },
    }
  } finally {
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
