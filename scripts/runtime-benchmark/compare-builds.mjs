// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: standalone benchmark configuration.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// node scripts/runtime-benchmark/compare-builds.mjs browser|backend baseline candidate output-prefix
// Browser builds are complete userscript files; backend builds are compiled directories.
const [mode, baseline, candidate, output] = process.argv.slice(2)
assert(['browser', 'backend'].includes(mode) && baseline && candidate && output)
await mkdir(dirname(output), { recursive: true })
const results = []
for (let pair = 0; pair < 3; pair++) {
  for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const build = variant === 'baseline' ? baseline : candidate
    const destination = `${output}-${pair}-${variant}`
    const browser = mode === 'browser'
    const file = browser ? `${destination}.json` : `${destination}/results.json`
    const args = browser
      ? ['scripts/benchmark-wplace-collaboration.mjs', build, file, '1', '--raid']
      : ['scripts/runtime-benchmark/run.mjs', destination]
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        stdio: 'inherit',
        env: {
          ...process.env,
          ...(browser
            ? {}
            : {
                BENCH_BUILD: build,
                BENCH_REPEATS: '1',
                BENCH_SCENARIO: process.env.BENCH_SCENARIO ?? 'raid',
                BENCH_USERS: process.env.BENCH_USERS ?? '256',
                BENCH_VARIANTS: process.env.BENCH_VARIANTS ?? 'node,bun-compat',
              }),
        },
      })
      child.on('error', reject)
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Benchmark exited ${code}; retain ${file}`)),
      )
    })
    const result = JSON.parse(await readFile(file, 'utf8'))
    if (!browser) assert.equal(result.passed, true)
    const keys = browser
      ? ['environment', 'templateSha256', 'workloadSha256', 'camera', 'browser']
      : ['traceSha256', 'fixtures', 'sourceHashes', 'capacity', 'versions', 'host']
    // Driver PIDs differ between backend runs, while CPU placement must remain fixed.
    if (!browser) result.host.driverAffinity = result.host.driverAffinity.replace(/pid \d+/, 'pid')
    if (results.length)
      for (const key of keys) assert.deepEqual(result[key], results[0][key], `${key} changed`)
    const previous = results.find((entry) => entry.variant === variant)
    const hash = browser ? 'bundleSha256' : 'backendSha256'
    if (previous) assert.equal(result[hash], previous[hash], `${variant} build changed`)
    results.push({ pair, variant, file, ...result })
    await writeFile(`${output}-comparison.json`, JSON.stringify(results, null, 2))
  }
}
