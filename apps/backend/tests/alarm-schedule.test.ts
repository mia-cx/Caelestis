import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { JOBS } from '../src/server/jobs.js'
import { ALARM_SCAN_INTERVAL_SECONDS } from '../src/telemetry/alarms/policy.js'

const SECONDS_PER_HOUR = 3_600

/** The `crons` list a wrangler config's `[triggers]` table declares. */
const cronsOf = async (file: string): Promise<readonly string[]> => {
  const toml = await readFile(join(import.meta.dirname, '..', file), 'utf8')
  const line = /^crons\s*=\s*(\[.*\])\s*$/m.exec(toml)
  if (line?.[1] === undefined) throw new Error(`${file} declares no crons`)
  return JSON.parse(line[1]) as readonly string[]
}

it('runs the tile mirror at the alarm scan interval on every host', async () => {
  const scan = `0 */${ALARM_SCAN_INTERVAL_SECONDS / SECONDS_PER_HOUR} * * *`
  expect(JOBS.mirror.cron).toBe(scan)
  expect(JOBS.mirror.every).toBe(ALARM_SCAN_INTERVAL_SECONDS * 1_000)
  for (const file of ['wrangler.toml', 'wrangler.self-hosted.example.toml']) {
    expect(await cronsOf(file)).toContain(scan)
  }
})
