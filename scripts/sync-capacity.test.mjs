import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { projectSyncCapacity } from './sync-capacity.mjs'

test('five healthy clients retain a ninety-percent steady-state invocation reduction', () => {
  const report = projectSyncCapacity()

  assert.equal(report.scenario.clients, 5)
  assert.equal(report.baseline.avoidableWorkerRequests, 12_570)
  assert.equal(report.baseline.requiredTileOfferBatches, 2_075)
  assert.equal(report.projected.avoidableWorkerRequests, 5)
  assert.ok(report.projected.reductionPercent >= 90)
  assert.equal(report.projected.reductionPercent, 99.9602)
  assert.equal(report.storage.initialProjectionSnapshots, 15)
  assert.equal(report.storage.dashboardSnapshotQueries, 10)
  assert.equal(report.durableObject.incomingHeartbeatMessages, 480)
  assert.equal(report.durableObject.projectedBillableRequestUnits, 33)
  assert.equal(report.durableObject.heartbeatWakeups, 0)
})

test('live telemetry volume stays off the Worker request budget', () => {
  const report = projectSyncCapacity({
    projectedTileOfferBatches: 100_000,
    projectedPaintReports: 20_000,
    projectedTileUploads: 10_000,
  })

  assert.equal(report.projected.liveTileOfferBatches, 100_000)
  assert.equal(report.durableObject.incomingTelemetryMessages, 130_000)
  assert.equal(report.projected.avoidableWorkerRequests, 5)
  assert.equal(report.projected.reductionPercent, 99.9602)
})

test('both runtime importers use the same exact Effect pin', async () => {
  const packages = await Promise.all(
    ['../apps/backend/package.json', '../packages/wire-schema/package.json'].map(async (relative) =>
      JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8')),
    ),
  )
  // Dependabot may update the pin, but ranges and mismatched runtime versions are unsafe.
  const version = packages[0].dependencies.effect
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/)
  for (const manifest of packages) assert.equal(manifest.dependencies.effect, version)

  const lockfile = await readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')
  assert.ok(lockfile.includes(`  effect@${version}:`))
})
