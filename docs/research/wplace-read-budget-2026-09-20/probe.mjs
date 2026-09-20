import { execFile } from 'node:child_process'
import { appendFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

// Observe a bounded fixed workload, not the failure threshold of a shared production egress.
const run = promisify(execFile)
const directory = process.env.WPLACE_BUDGET_OUTPUT_DIR ?? '/tmp/wplace-budget-probe.7p665S'
const tilePaths = ['/files/s0/tiles/603/769.png', '/files/s0/tiles/603/770.png', '/files/s0/tiles/602/769.png', '/files/s0/tiles/602/770.png']
const stages = [
  { name: 'tile-baseline', count: 10, spacingMs: 5000, route: 'tile' },
  { name: 'pixel-baseline', count: 10, spacingMs: 5000, route: 'pixel' },
  { name: 'tile-1rps', count: 20, spacingMs: 1000, route: 'tile' },
  { name: 'pixel-1rps', count: 20, spacingMs: 1000, route: 'pixel' },
  { name: 'mixed-1rps', count: 20, spacingMs: 1000, route: 'mixed' },
  { name: 'conditional-1rps', count: 20, spacingMs: 1000, route: 'conditional' },
]
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ attempts: stages.reduce((n, s) => n + s.count, 0), concurrency: 1, stages }))
  process.exit(0)
}
const rows = []
const validators = new Map()
const startedAt = Date.now()
let previousStart = 0
let stopped = null
await writeFile(`${directory}/attempts.jsonl`, '')
outer: for (const stage of stages) {
  const phase = []
  for (let i = 0; i < stage.count; i++) {
    if (rows.length >= 100 || Date.now() - startedAt >= 20 * 60 * 1000) { stopped = 'experiment cap'; break outer }
    const remaining = previousStart + stage.spacingMs - Date.now()
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
    const route = stage.route === 'pixel' || (stage.route === 'mixed' && i % 2 === 1) ? 'pixel' : 'tile'
    const path = route === 'pixel'
      ? `/s0/pixel/603/769?x=${500 + (i % 10)}&y=${500 + Math.floor(i / 10)}`
      : tilePaths[(stage.route === 'conditional' ? Math.floor(i / 2) : i) % tilePaths.length]
    const conditional = stage.route === 'conditional' && i % 2 === 1 && validators.has(path)
    const args = ['-4', '--silent', '--show-error', '--max-time', '20', '--user-agent', 'Caelestis-Tile-Fetcher/1.0', '--dump-header', '-', '--output', '/dev/null', '--write-out', '\nCURL_METRICS_JSON%{json}', ...(conditional ? ['--header', `If-None-Match: ${validators.get(path)}`] : []), `https://backend.wplace.live${path}`]
    previousStart = Date.now()
    let row
    try {
      const { stdout } = await run('curl', args, { maxBuffer: 1024 * 1024 })
      const split = stdout.lastIndexOf('\nCURL_METRICS_JSON')
      if (split < 0) throw new Error('Missing curl metrics')
      const metrics = JSON.parse(stdout.slice(split + '\nCURL_METRICS_JSON'.length))
      const headers = Object.fromEntries(stdout.slice(0, split).split(/\r?\n/).flatMap(line => {
        const match = /^([^:]+):\s*(.*)$/.exec(line)
        if (!match) return []
        const name = match[1].toLowerCase()
        return /^(retry-after|ratelimit.*|x-ratelimit.*|cache-control|age|etag|last-modified|date|cf-cache-status|cf-mitigated|content-type|x-block-reason)$/.test(name) ? [[name, match[2]]] : []
      }))
      if (headers.etag) validators.set(path, headers.etag)
      row = { attempt: rows.length + 1, stage: stage.name, route, path, conditional, startedAt: new Date(previousStart).toISOString(), completedAt: new Date().toISOString(), status: metrics.http_code, elapsedSeconds: metrics.time_total, bytes: metrics.size_download, httpVersion: metrics.http_version, remoteIp: metrics.remote_ip, proxyUsed: metrics.proxy_used, headers }
    } catch (error) {
      row = { attempt: rows.length + 1, stage: stage.name, route, path, startedAt: new Date(previousStart).toISOString(), error: error.message }
    }
    rows.push(row)
    phase.push(row)
    await appendFile(`${directory}/attempts.jsonl`, `${JSON.stringify(row)}\n`)
    // Any unexpected status ends the experiment. There are no automatic retries.
    if (row.error || ![200, 304].includes(row.status) || row.headers['cf-mitigated']) {
      stopped = { attempt: row.attempt, status: row.status, error: row.error, headers: row.headers }
      console.log(JSON.stringify({ stopped }))
      break outer
    }
    if (phase.length % 10 === 0) console.log(JSON.stringify({ stage: stage.name, completed: phase.length, statuses: phase.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {}) }))
  }
}
const summary = { startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(), attempted: rows.length, stopped, statuses: rows.reduce((a, r) => ({ ...a, [r.status ?? 'error']: (a[r.status ?? 'error'] ?? 0) + 1 }), {}), stages: stages.map(stage => { const subset = rows.filter(row => row.stage === stage.name); return { name: stage.name, planned: stage.count, attempted: subset.length, scheduledSpacingMs: stage.spacingMs, conditional: subset.filter(row => row.conditional).length } }) }
await writeFile(`${directory}/summary.json`, JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
