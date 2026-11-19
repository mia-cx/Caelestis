import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readNodeConfig } from '../../src/node/config.js'
import { parseServerConfig } from '../../src/server/config.js'
import { JOB_NAMES, JOBS } from '../../src/server/jobs.js'

const WRANGLER_FILES = ['wrangler.toml', 'wrangler.self-hosted.example.toml']

/** The `KEY = "value"` lines of one top-level TOML table; enough for wrangler's flat `[vars]`. */
const vars = (file: string): Record<string, string> => {
  const text = readFileSync(join(import.meta.dirname, '../..', file), 'utf8')
  const table = text.split(/^\[vars\]$/m)[1]?.split(/^\[/m)[0] ?? ''
  return Object.fromEntries(
    [...table.matchAll(/^([A-Z_]+) = "(.*)"$/gm)].map(([, name, value]) => [name, value]),
  )
}

const crons = (file: string): string[] => {
  const text = readFileSync(join(import.meta.dirname, '../..', file), 'utf8')
  return JSON.parse(/^crons = (\[.*\])$/m.exec(text)?.[1] ?? '[]')
}

describe('server configuration', () => {
  it.each(WRANGLER_FILES)('accepts the [vars] %s ships', (file) => {
    expect(() => parseServerConfig(vars(file))).not.toThrow()
  })

  it('reads an empty variable as unset, as the self-hosted example writes its description', () => {
    expect(vars('wrangler.self-hosted.example.toml').SERVER_DESCRIPTION).toBe('')
    const config = parseServerConfig({ SERVER_DESCRIPTION: '', SERVER_NAME: '', SEASON: '' })
    expect(config.serverDescription).toBeUndefined()
    expect(config.serverName).toBe('Caelestis')
    expect(config.season).toBe(0)
  })

  it('refuses values the wire schema or the hosts would refuse later', () => {
    expect(() => parseServerConfig({ SEASON: '-1' })).toThrow('SEASON')
    expect(() => parseServerConfig({ OPEN_ACCESS: 'TRUE' })).toThrow('OPEN_ACCESS')
    expect(() => parseServerConfig({ SERVER_ID: 'not-a-uuid' })).toThrow('SERVER_ID')
    expect(() => parseServerConfig({ SHARD_STRATEGY: 'region' })).toThrow('SHARD_STRATEGY')
    expect(() => parseServerConfig({ TILE_BLOB_GC_MODE: 'purge' })).toThrow('TILE_BLOB_GC_MODE')
    expect(() => parseServerConfig({ BASE_PATH: '/backend/' })).toThrow('BASE_PATH')
    expect(() => parseServerConfig({ CAELESTIS_LIVE_SUBSCRIBER_LIMIT: '0' })).toThrow(
      'CAELESTIS_LIVE_SUBSCRIBER_LIMIT',
    )
  })

  it('refuses unsupported Node replica and base-path configurations before opening storage', () => {
    expect(() => readNodeConfig({ REPLICAS: '2' })).toThrow('Only one active application replica')
    expect(() => readNodeConfig({ BASE_PATH: '/' })).toThrow('BASE_PATH')
  })
})

describe('job table', () => {
  it.each(WRANGLER_FILES)('%s triggers exactly the crons the job table names', (file) => {
    expect(new Set(crons(file))).toEqual(new Set(JOB_NAMES.map((name) => JOBS[name].cron)))
  })

  it.each(JOB_NAMES)('runs %s on Node as often as its Worker cron fires', (name) => {
    const [minute, hour, ...daily] = JOBS[name].cron.split(' ')
    expect(minute).toMatch(/^\d+$/)
    expect(daily).toEqual(['*', '*', '*'])
    const hours = hour?.startsWith('*/') ? Number(hour.slice(2)) : 24
    expect(JOBS[name].every).toBe(hours * 60 * 60 * 1_000)
  })
})
