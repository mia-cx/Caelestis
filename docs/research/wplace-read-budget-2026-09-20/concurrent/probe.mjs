import { connect } from 'node:http2'
import { writeFile, appendFile } from 'node:fs/promises'
import { once } from 'node:events'

// Measure whether both routes sustain their individual passing rates together.
// Stop dispatch immediately on rejection; allow already-started reads to finish.
const directory = process.env.WPLACE_PROBE_OUTPUT_DIR ?? new URL('.', import.meta.url).pathname
const rates = { tile: 29, pixel: 5 }
const phaseSeconds = 300
const maxConcurrency = 32
const routeMode = 'concurrent'
const tileGridSide = 32
if (!Number.isInteger(tileGridSide) || tileGridSide < 0 || tileGridSide > 32) throw new Error('Tile grid side must be an integer from 0 to 32')
// Normal tile URLs across a region model monitoring many tiles without cache-busting.
const tiles = tileGridSide ? Array.from({ length: tileGridSide ** 2 }, (_, index) => `${603 - Math.floor(tileGridSide / 2) + Math.floor(index / tileGridSide)}/${769 - Math.floor(tileGridSide / 2) + index % tileGridSide}`) : ['603/769', '603/770', '602/769', '602/770']
if (!directory.endsWith('/')) {
  throw new Error('Use an output directory ending in /')
}
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ rates, phaseSeconds, maxConcurrency, routeMode, tilePaths: tiles.length, firstTile: tiles[0], lastTile: tiles.at(-1), transport: 'persistent HTTP/2 over IPv4', retries: 0 }))
  process.exit(0)
}
const rows = []
const pending = new Set()
const phases = []
const startedAt = new Date().toISOString()
let nextAttempt = 0
const routeCounts = { tile: 0, pixel: 0 }
let stopped = null
let logTail = Promise.resolve()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
await writeFile(`${directory}attempts.jsonl`, '', { flag: 'wx' })
let currentSession = null
let connecting = null
let connectionCount = 0
const sessions = new Set()

async function getSession() {
  if (currentSession && !currentSession.closed && !currentSession.destroyed) return currentSession
  if (connecting) return connecting
  connecting = (async () => {
    const session = connect('https://backend.wplace.live', { family: 4 })
    session.probeConnectionId = ++connectionCount
    sessions.add(session)
    session.on('close', () => sessions.delete(session))
    session.on('error', error => {
      stopped ??= { error: error.message, kind: 'session-error', at: new Date().toISOString() }
    })
    session.on('goaway', code => {
      if (currentSession === session) currentSession = null
      // Normal GOAWAY rotates the connection, never retries a request.
      // A nonzero code stops the experiment instead of reconnecting through it.
      if (code !== 0) stopped ??= { error: `HTTP/2 GOAWAY ${code}`, at: new Date().toISOString() }
      session.close()
    })
    const timer = setTimeout(() => session.destroy(new Error('Connection timed out')), 20000)
    try { await once(session, 'connect') } finally { clearTimeout(timer) }
    if (session.socket.remoteFamily !== 'IPv4') throw new Error('Expected an IPv4 connection')
    currentSession = session
    return session
  })()
  try { return await connecting } finally { connecting = null }
}

// Connect before the clock starts, so initial DNS/TLS setup cannot lower a step's rate.
await getSession()

async function request(route) {
  const attempt = ++nextAttempt
  const rate = rates[route]
  const pixelIndex = routeCounts[route]++
  const path = route === 'tile'
    ? `/files/s0/tiles/${tiles[pixelIndex % tiles.length]}.png`
    : `/s0/pixel/603/769?x=${500 + pixelIndex % 100}&y=${500 + Math.floor(pixelIndex / 100) % 100}`
  const row = { attempt, scheduledRate: rate, route, path, startedAt: new Date().toISOString(), inFlightAtDispatch: pending.size + 1 }
  try {
    const session = await getSession()
    if (stopped) return
    row.startedAt = new Date().toISOString()
    Object.assign(row, { connectionId: session.probeConnectionId, remoteIp: session.socket.remoteAddress, httpVersion: '2', proxyUsed: 0, bytes: 0 })
    await new Promise((resolve, reject) => {
      const stream = session.request({ ':method': 'GET', ':path': path, 'user-agent': 'Caelestis-Tile-Fetcher/1.0' })
      let finished = false
      const timer = setTimeout(() => stream.destroy(new Error('Request timed out after 20 seconds')), 20000)
      const finish = error => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        error ? reject(error) : resolve()
      }
      stream.on('response', headers => {
        row.responseAt = new Date().toISOString()
        row.status = headers[':status']
        row.headers = Object.fromEntries(Object.entries(headers).filter(([name]) => /^(retry-after|ratelimit.*|x-ratelimit.*|cache-control|age|etag|last-modified|date|cf-cache-status|cf-mitigated|cf-ray|server|content-type|x-block-reason)$/.test(name)))
        if (row.status !== 200 || row.headers['cf-mitigated']) stopped ??= row
      })
      stream.on('data', chunk => { row.bytes += chunk.length })
      stream.on('end', () => finish())
      stream.on('error', error => finish(error))
      stream.on('close', () => { if (!finished) finish(new Error('Stream closed before response ended')) })
      stream.end()
    })
    Object.assign(row, { completedAt: new Date().toISOString(), elapsedSeconds: (Date.now() - Date.parse(row.startedAt)) / 1000 })
  } catch (error) {
    Object.assign(row, { completedAt: new Date().toISOString(), error: error.message })
  }
  rows.push(row)
  if (!stopped && (row.error || row.status !== 200 || row.headers?.['cf-mitigated'])) {
    stopped = row
    console.log(JSON.stringify({ stopped }))
  }
  logTail = logTail.then(() => appendFile(`${directory}attempts.jsonl`, `${JSON.stringify(row)}\n`))
  await logTail
}

// Independent deadlines pace both routes continuously. After a stall, resume
// normal spacing instead of sending a burst to catch up missed requests.
const dispatchStartedAt = Date.now()
const deadline = dispatchStartedAt + phaseSeconds * 1000
const nextStarts = { tile: dispatchStartedAt, pixel: dispatchStartedAt }
while (!stopped && Date.now() < deadline) {
  const route = nextStarts.tile <= nextStarts.pixel ? 'tile' : 'pixel'
  const delay = nextStarts[route] - Date.now()
  if (delay > 0) { await sleep(Math.ceil(delay)); continue }
  while (!stopped && pending.size >= maxConcurrency) await Promise.race(pending)
  if (stopped || Date.now() >= deadline) break
  nextStarts[route] = Date.now() + 1000 / rates[route]
  const job = request(route)
  pending.add(job)
  job.finally(() => pending.delete(job))
}
const dispatchEndedAt = Date.now()
await Promise.all(pending)
for (const [route, rate] of Object.entries(rates)) {
  const subset = rows.filter(row => row.route === route)
  phases.push({ route, rate, startedAt: new Date(dispatchStartedAt).toISOString(), endedAt: new Date(dispatchEndedAt).toISOString(), attempted: subset.length, achievedRate: subset.length / ((dispatchEndedAt - dispatchStartedAt) / 1000), statuses: subset.reduce((all, row) => ({ ...all, [row.status ?? 'error']: (all[row.status ?? 'error'] ?? 0) + 1 }), {}) })
}
await logTail
const summary = { startedAt, endedAt: new Date().toISOString(), dispatchStartedAt: new Date(dispatchStartedAt).toISOString(), dispatchEndedAt: new Date(dispatchEndedAt).toISOString(), attempted: nextAttempt, routeMode, maxConcurrency, tilePaths: tiles.length, connectionCount, transport: 'persistent HTTP/2 over IPv4', phases, stopped, stopReason: stopped ? 'first unexpected response or transport failure' : 'bounded workload completed without rejection' }
await writeFile(`${directory}summary.json`, JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
process.exitCode = stopped ? 1 : 0
for (const session of sessions) session.close()
