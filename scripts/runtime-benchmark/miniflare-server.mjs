// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: standalone benchmark process.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { uuidV7 } from '../../packages/shared/dist/index.js'

const backendRequire = createRequire(new URL('../../apps/backend/package.json', import.meta.url))
const { unstable_splitSqlQuery: splitSqlQuery } = backendRequire('wrangler')
const wranglerRequire = createRequire(backendRequire.resolve('wrangler/package.json'))
const miniflareRequire = createRequire(wranglerRequire.resolve('miniflare'))
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare')
const esbuild = createRequire(new URL('../../apps/userscript/package.json', import.meta.url))(
  'esbuild',
)
const bundle = await esbuild.build({
  entryPoints: [fileURLToPath(new URL('../../apps/backend/src/worker.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  external: ['cloudflare:*', 'node:*'],
})
esbuild.stop()
const script = bundle.outputFiles[0].text
const mf = new Miniflare(
  convertV4MiniflareOptions({
    name: 'runtime-benchmark',
    host: '127.0.0.1',
    port: 0,
    modules: true,
    script,
    compatibilityDate: '2026-08-03',
    compatibilityFlags: ['nodejs_compat'],
    inspectorPort: 0,
    d1Databases: ['DB'],
    r2Buckets: ['BLOBS'],
    d1Persist: false,
    r2Persist: false,
    durableObjectsPersist: false,
    durableObjects: Object.fromEntries(
      [
        ['STATUS_READ_MODEL', 'StatusReadModelObject'],
        ['TELEMETRY', 'TelemetryShard'],
        ['ALARM_WATCHER', 'AlarmWatcher'],
        ['TEMPLATE_BACKFILL', 'TemplateBackfillObject'],
        ['PRESENCE', 'PresenceObject'],
      ].map(([binding, className]) => [binding, { className, useSQLite: true }]),
    ),
    bindings: {
      ADMIN_TOKEN: process.env.ADMIN_TOKEN,
      SERVER_ID: uuidV7(),
      SERVER_NAME: 'Runtime benchmark',
      SEASON: '0',
      SHARD_STRATEGY: 'single',
      OPEN_ACCESS: 'false',
      BASE_PATH: '/backend',
    },
    outboundService: () => {
      throw new Error('Runtime benchmark must not access external services')
    },
  }),
)
process.once('SIGTERM', () => void mf.dispose().finally(() => process.exit(143)))
process.once('SIGINT', () => void mf.dispose().finally(() => process.exit(130)))
try {
  const address = await mf.ready
  const database = await mf.getD1Database('DB')
  const migrationRoot = new URL('../../apps/backend/migrations/', import.meta.url)
  for (const name of (await readdir(migrationRoot)).filter((x) => x.endsWith('.sql')).sort()) {
    const source = await readFile(new URL(name, migrationRoot), 'utf8')
    for (const statement of splitSqlQuery(source)) await database.prepare(statement).run()
  }
  // Include workerd and the Miniflare controller. Measuring Node alone misses the actual runtime.
  const children = async (pid) => {
    const source = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim()
    const direct = source ? source.split(/\s+/).map(Number) : []
    return [...direct, ...(await Promise.all(direct.map(children))).flat()]
  }
  const descendants = await children(process.pid)
  const workerPids = []
  for (const pid of descendants) {
    const command = await readFile(`/proc/${pid}/comm`, 'utf8')
    if (command.trim() === 'workerd') workerPids.push(pid)
  }
  assert.equal(workerPids.length, 1, 'expected one workerd runtime process')
  const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
  const workerCpu = async () => {
    const source = await readFile(`/proc/${workerPids[0]}/stat`, 'utf8')
    const fields = source.slice(source.lastIndexOf(')') + 2).split(' ')
    return { user: Number(fields[11]) / ticks, system: Number(fields[12]) / ticks }
  }
  const reply = (data) => console.log(JSON.stringify({ benchmark: true, ...data }))
  const status = await readFile(
    new URL('../../apps/backend/src/status-coordinator.ts', import.meta.url),
    'utf8',
  )
  reply({
    type: 'ready',
    port: Number(address.port),
    runtime: {
      controllerNode: process.versions.node,
      miniflare: wranglerRequire('miniflare/package.json').version,
      workerd: miniflareRequire('workerd/package.json').version,
      compatibilityDate: '2026-08-03',
      bundleSha256: createHash('sha256').update(script).digest('hex'),
    },
    metricsPids: [process.pid, ...workerPids],
    metricsProcessRoles: ['miniflareController', 'workerd'],
    liveSubscriberLimit: Number(status.match(/export const MAX_LIVE_SUBSCRIBERS = (\d+)/)[1]),
  })
  let baseline
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === 'begin') {
      baseline = { cpu: process.cpuUsage(), worker: await workerCpu(), at: performance.now() }
      reply({ type: 'begin' })
    }
    if (line === 'end') {
      const worker = await workerCpu()
      const workerUser = worker.user - baseline.worker.user
      const workerSystem = worker.system - baseline.worker.system
      const cpu = process.cpuUsage(baseline.cpu)
      reply({
        type: 'end',
        cpu: { user: cpu.user + workerUser * 1e6, system: cpu.system + workerSystem * 1e6 },
        elapsedMs: performance.now() - baseline.at,
        processCpuSeconds: {
          workerd: workerUser + workerSystem,
          miniflareController: (cpu.user + cpu.system) / 1e6,
        },
        delaySamples: [],
      })
    }
    if (line === 'stop') break
  }
} finally {
  await mf.dispose()
}
