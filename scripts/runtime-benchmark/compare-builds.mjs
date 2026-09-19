// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: standalone benchmark configuration.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// node scripts/runtime-benchmark/compare-builds.mjs browser|browser-profile|backend|helm baseline candidate output-prefix [frontend-image]
// Browser builds are complete userscript files; backend builds are compiled directories.
const [mode, baseline, candidate, output, frontend] = process.argv.slice(2)
assert(
  ['browser', 'browser-profile', 'backend', 'helm'].includes(mode) &&
    baseline &&
    candidate &&
    output,
)
const profileComparison = mode === 'browser-profile'
if (profileComparison)
  assert.equal(baseline, candidate, 'Profiler overhead requires the same build')
assert(mode !== 'helm' || frontend, 'Helm comparisons require the same frontend image')
await mkdir(dirname(output), { recursive: true })
const results = []
for (let pair = 0; pair < 3; pair++) {
  for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const build = variant === 'baseline' ? baseline : candidate
    const destination = `${output}-${pair}-${variant}`
    const browser = mode === 'browser' || profileComparison
    const helm = mode === 'helm'
    const file = browser
      ? `${destination}.json`
      : `${destination}/${helm ? 'benchmark' : 'results'}.json`
    const args = browser
      ? ['scripts/benchmark-wplace-collaboration.mjs', build, file, '1', '--raid']
      : helm
        ? ['scripts/test-helm-stack.mjs', build, frontend, 'cnpg', destination]
        : ['scripts/runtime-benchmark/run.mjs', destination]
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        stdio: 'inherit',
        env: {
          ...process.env,
          ...(browser
            ? profileComparison
              ? { RAID_PROFILE: variant === 'baseline' ? '1' : '0' }
              : {}
            : helm
              ? {
                  CAELESTIS_KUBE_CONTEXT: '',
                  CAELESTIS_TEST_ORIGIN: '',
                  CAELESTIS_TEST_KEEP: 'false',
                  CAELESTIS_TEST_EXTENDED: 'true',
                  CAELESTIS_TEST_STORAGE: 's3',
                  CAELESTIS_TEST_BENCHMARK: 'true',
                  CAELESTIS_TEST_BENCHMARK_OBSERVE: 'false',
                  // Kind's cached container stats can refresh only every 20 seconds. Keep a
                  // long enough window to satisfy the unchanged 50% CPU coverage requirement.
                  CAELESTIS_TEST_BENCHMARK_MEASURE_MS:
                    process.env.CAELESTIS_TEST_BENCHMARK_MEASURE_MS ?? '120000',
                  BENCH_SCENARIO: process.env.BENCH_SCENARIO ?? 'raid',
                }
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
      ? [
          'environment',
          'templateSha256',
          ...(profileComparison ? [] : ['workloadSha256']),
          'camera',
          'browser',
        ]
      : helm
        ? ['traceSha256', 'fixture', 'sourceHashes', 'runtime', 'description', 'transport']
        : ['traceSha256', 'fixtures', 'sourceHashes', 'capacity', 'versions', 'host']
    // Driver PIDs differ between backend runs, while CPU placement must remain fixed.
    if (!browser && !helm)
      result.host.driverAffinity = result.host.driverAffinity.replace(/pid \d+/, 'pid')
    if (results.length)
      for (const key of keys) assert.deepEqual(result[key], results[0][key], `${key} changed`)
    const previous = results.find((entry) => entry.variant === variant)
    if (profileComparison && previous)
      assert.equal(result.workloadSha256, previous.workloadSha256, 'Profiler workload changed')
    if (helm)
      result.backendImageID = result.containers.find(
        (container) => container.name === 'backend',
      ).imageID
    const hash = browser ? 'bundleSha256' : helm ? 'backendImageID' : 'backendSha256'
    if (previous) assert.equal(result[hash], previous[hash], `${variant} build changed`)
    results.push({ pair, variant, file, ...result })
    await writeFile(`${output}-comparison.json`, JSON.stringify(results, null, 2))
  }
}
