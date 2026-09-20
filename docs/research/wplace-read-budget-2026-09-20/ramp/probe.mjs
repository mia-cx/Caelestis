import { execFile } from 'node:child_process'
import { writeFile, appendFile } from 'node:fs/promises'
import { promisify } from 'node:util'

// Measure the first rejection while increasing one shared IPv4 workload.
// Stop dispatch immediately on rejection; allow already-started reads to finish.
const run = promisify(execFile)
const directory = process.env.WPLACE_PROBE_OUTPUT_DIR ?? new URL('.', import.meta.url).pathname
const rates = JSON.parse(process.env.WPLACE_PROBE_RATES ?? '[2,4,8,16,32,64]')
const phaseSeconds = Number(process.env.WPLACE_PROBE_SECONDS ?? 60)
const maxConcurrency = 8
const tiles = ['603/769', '603/770', '602/769', '602/770']
if (!directory.endsWith('/') || !Array.isArray(rates) || !rates.length || rates.some(rate => !Number.isFinite(rate) || rate <= 0 || rate > 64) || !Number.isFinite(phaseSeconds) || phaseSeconds <= 0 || phaseSeconds > 3600) {
  throw new Error('Use an output directory ending in /, rates in (0,64], and a duration in (0,3600] seconds')
}
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ rates, phaseSeconds, maxConcurrency, routeMix: 'alternating tile/pixel', retries: 0 }))
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
  const route = attempt % 2 === 1 ? 'tile' : 'pixel'
  const pixelIndex = Math.floor((attempt - 1) / 2)
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
      return /^(retry-after|ratelimit.*|x-ratelimit.*|cache-control|age|etag|last-modified|date|cf-cache-status|cf-mitigated|content-type|x-block-reason)$/.test(name) ? [[name, match[2]]] : []
    }))
    Object.assign(row, { completedAt: new Date().toISOString(), status: metrics.http_code, elapsedSeconds: metrics.time_total, bytes: metrics.size_download, httpVersion: metrics.http_version, remoteIp: metrics.remote_ip, proxyUsed: metrics.proxy_used, headers })
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

for (const rate of rates) {
  const phaseStart = Date.now()
  const deadline = phaseStart + phaseSeconds * 1000
  let previousStart = 0
  let lastProgress = phaseStart
  console.log(JSON.stringify({ phaseStarted: rate, at: new Date(phaseStart).toISOString() }))
  while (!stopped && Date.now() < deadline) {
    const delay = previousStart + 1000 / rate - Date.now()
    if (delay > 0) await sleep(delay)
    while (!stopped && pending.size >= maxConcurrency) await Promise.race(pending)
    if (stopped || Date.now() >= deadline) break
    previousStart = Date.now()
    const job = request(rate)
    pending.add(job)
    job.finally(() => pending.delete(job))
    if (Date.now() - lastProgress >= 15000) {
      console.log(JSON.stringify({ progressRate: rate, dispatched: nextAttempt, completed: rows.length }))
      lastProgress = Date.now()
    }
  }
  await Promise.all(pending)
  const subset = rows.filter(row => row.scheduledRate === rate)
  phases.push({ rate, startedAt: new Date(phaseStart).toISOString(), endedAt: new Date().toISOString(), attempted: subset.length, statuses: subset.reduce((all, row) => ({ ...all, [row.status ?? 'error']: (all[row.status ?? 'error'] ?? 0) + 1 }), {}) })
  console.log(JSON.stringify({ phaseCompleted: phases.at(-1) }))
  if (stopped) break
}
await logTail
const summary = { startedAt, endedAt: new Date().toISOString(), attempted: nextAttempt, maxConcurrency, phases, stopped, stopReason: stopped ? 'first unexpected response or transport failure' : 'bounded ramp exhausted without rejection' }
await writeFile(`${directory}summary.json`, JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
