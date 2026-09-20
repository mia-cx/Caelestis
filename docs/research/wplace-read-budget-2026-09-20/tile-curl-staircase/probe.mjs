import { execFile } from 'node:child_process'
import { writeFile, appendFile } from 'node:fs/promises'
import { promisify } from 'node:util'

// Measure the first rejection while increasing one shared IPv4 workload.
// Stop dispatch immediately on rejection; allow already-started reads to finish.
const run = promisify(execFile)
const directory = process.env.WPLACE_PROBE_OUTPUT_DIR ?? new URL('.', import.meta.url).pathname
const rates = Array.from({ length: 17 }, (_, index) => 16 + index)
const phaseSeconds = Number(process.env.WPLACE_PROBE_SECONDS ?? 60)
const maxConcurrency = 32
const routeMode = 'tile'
const tileGridSide = 32
if (!Number.isInteger(tileGridSide) || tileGridSide < 0 || tileGridSide > 32) throw new Error('Tile grid side must be an integer from 0 to 32')
// Normal tile URLs across a region model monitoring many tiles without cache-busting.
const tiles = tileGridSide ? Array.from({ length: tileGridSide ** 2 }, (_, index) => `${603 - Math.floor(tileGridSide / 2) + Math.floor(index / tileGridSide)}/${769 - Math.floor(tileGridSide / 2) + index % tileGridSide}`) : ['603/769', '603/770', '602/769', '602/770']
if (!directory.endsWith('/') || phaseSeconds !== 60) {
  throw new Error('Use an output directory ending in /, rates in (0,64], and a duration in (0,3600] seconds')
}
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ rates, phaseSeconds, maxConcurrency, routeMode, tilePaths: tiles.length, firstTile: tiles[0], lastTile: tiles.at(-1), retries: 0 }))
  process.exit(0)
}
const rows = []
const pending = new Set()
const phases = []
const startedAt = new Date().toISOString()
let nextAttempt = 0
let stopped = null
let logTail = Promise.resolve()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
await writeFile(`${directory}attempts.jsonl`, '', { flag: 'wx' })

async function request(rate) {
  const attempt = ++nextAttempt
  const route = routeMode === 'mixed' ? (attempt % 2 === 1 ? 'tile' : 'pixel') : routeMode
  const pixelIndex = routeMode === 'mixed' ? Math.floor((attempt - 1) / 2) : attempt - 1
  const path = route === 'tile'
    ? `/files/s0/tiles/${tiles[pixelIndex % tiles.length]}.png`
    : `/s0/pixel/603/769?x=${500 + pixelIndex % 100}&y=${500 + Math.floor(pixelIndex / 100) % 100}`
  const row = { attempt, scheduledRate: rate, route, path, startedAt: new Date().toISOString(), inFlightAtDispatch: pending.size + 1 }
  try {
    const { stdout } = await run('curl', ['-4', '--silent', '--show-error', '--max-time', '20', '--user-agent', 'Caelestis-Tile-Fetcher/1.0', '--dump-header', '-', '--output', '/dev/null', '--write-out', '\nCURL_METRICS_JSON%{json}', `https://backend.wplace.live${path}`], { maxBuffer: 1024 * 1024 })
    const split = stdout.lastIndexOf('\nCURL_METRICS_JSON')
    if (split < 0) throw new Error('Missing curl metrics')
    const metrics = JSON.parse(stdout.slice(split + '\nCURL_METRICS_JSON'.length))
    const headers = Object.fromEntries(stdout.slice(0, split).split(/\r?\n/).flatMap(line => {
      const match = /^([^:]+):\s*(.*)$/.exec(line)
      if (!match) return []
      const name = match[1].toLowerCase()
      return /^(retry-after|ratelimit.*|x-ratelimit.*|cache-control|age|etag|last-modified|date|cf-cache-status|cf-mitigated|cf-ray|server|content-type|x-block-reason)$/.test(name) ? [[name, match[2]]] : []
    }))
    Object.assign(row, { completedAt: new Date().toISOString(), status: metrics.http_code, elapsedSeconds: metrics.time_total, dnsSeconds: metrics.time_namelookup, connectSeconds: metrics.time_connect, tlsSeconds: metrics.time_appconnect, firstByteSeconds: metrics.time_starttransfer, bytes: metrics.size_download, httpVersion: metrics.http_version, remoteIp: metrics.remote_ip, proxyUsed: metrics.proxy_used, headers })
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

// A single clock changes rate every 60 seconds. Do not drain requests or pause
// between steps: that would let the upstream counter recover at each boundary.
const dispatchStartedAt = Date.now()
const deadline = dispatchStartedAt + rates.length * phaseSeconds * 1000
let previousStart = 0
let lastRate = null
while (!stopped && Date.now() < deadline) {
  const plannedRate = rates[Math.floor((Date.now() - dispatchStartedAt) / (phaseSeconds * 1000))]
  const delay = previousStart + 1000 / plannedRate - Date.now()
  if (delay > 0) await sleep(delay)
  while (!stopped && pending.size >= maxConcurrency) await Promise.race(pending)
  if (stopped || Date.now() >= deadline) break
  const rate = rates[Math.floor((Date.now() - dispatchStartedAt) / (phaseSeconds * 1000))]
  if (rate !== lastRate) {
    console.log(JSON.stringify({ phaseStarted: rate, at: new Date().toISOString() }))
    lastRate = rate
  }
  previousStart = Date.now()
  const job = request(rate)
  pending.add(job)
  job.finally(() => pending.delete(job))
}
const dispatchEndedAt = Date.now()
await Promise.all(pending)
for (const [index, rate] of rates.entries()) {
  const phaseStart = dispatchStartedAt + index * phaseSeconds * 1000
  if (phaseStart >= dispatchEndedAt) break
  const phaseEnd = Math.min(phaseStart + phaseSeconds * 1000, dispatchEndedAt)
  const subset = rows.filter(row => row.scheduledRate === rate)
  phases.push({ rate, startedAt: new Date(phaseStart).toISOString(), endedAt: new Date(phaseEnd).toISOString(), attempted: subset.length, achievedRate: subset.length / ((phaseEnd - phaseStart) / 1000), statuses: subset.reduce((all, row) => ({ ...all, [row.status ?? 'error']: (all[row.status ?? 'error'] ?? 0) + 1 }), {}) })
}
await logTail
const summary = { startedAt, endedAt: new Date().toISOString(), dispatchStartedAt: new Date(dispatchStartedAt).toISOString(), dispatchEndedAt: new Date(dispatchEndedAt).toISOString(), attempted: nextAttempt, routeMode, maxConcurrency, tilePaths: tiles.length, phases, stopped, stopReason: stopped ? 'first unexpected response or transport failure' : 'bounded workload completed without rejection' }
await writeFile(`${directory}summary.json`, JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
process.exitCode = stopped ? 1 : 0
