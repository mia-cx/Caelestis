import { MAX_PRESENCE_SUBSCRIBERS } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { type LiveSocket, MAX_LIVE_SUBSCRIBERS } from '../status-coordinator.js'
import {
  AdmissionCounters,
  admissionChannel,
  type CapacityHost,
  EventLoopLag,
  renderCapacityMetrics,
  snapshotCapacity,
  userKey,
} from './capacity.js'

const hash = (seed: string) => seed.repeat(64).slice(0, 64)
const socket = (attachment: unknown, readyState = 1): LiveSocket => ({
  readyState,
  send() {},
  close() {},
  serializeAttachment() {},
  deserializeAttachment: () => attachment,
})
const host = (sockets: LiveSocket[], pendingWork = 0): CapacityHost => ({
  getWebSockets: () => sockets,
  pendingWork,
})

describe('snapshotCapacity', () => {
  it('reports zero for an empty pod', () => {
    expect(snapshotCapacity([])).toEqual({
      users: 0,
      liveSlots: 0,
      presenceSlots: 0,
      pendingWork: 0,
      coordinators: [],
    })
  })

  it('counts a user once across channels and tabs while counting every live slot', () => {
    const mia = { tokenHash: hash('a'), clientHash: hash('a'), anonymous: false }
    const browser = { tokenHash: hash('b'), clientHash: hash('c'), anonymous: true }
    const secondBrowser = { tokenHash: hash('b'), clientHash: hash('d'), anonymous: true }
    const snapshot = snapshotCapacity([
      {
        kind: 'live-sync',
        key: '0',
        host: host([socket(mia), socket(mia), socket(browser), socket(secondBrowser)], 3),
      },
      {
        kind: 'presence',
        key: '0:world',
        host: host([socket({ ...mia, sessionId: '1' }), socket({ ...browser, closed: true })], 1),
      },
    ])
    expect(snapshot).toEqual({
      users: 3,
      liveSlots: 4,
      presenceSlots: 1,
      pendingWork: 4,
      coordinators: [
        { kind: 'live-sync', key: '0', connections: 4, limit: MAX_LIVE_SUBSCRIBERS },
        { kind: 'presence', key: '0:world', connections: 1, limit: MAX_PRESENCE_SUBSCRIBERS },
      ],
    })
  })

  it('excludes presence sockets that are not open, matching room admission', () => {
    const mia = { tokenHash: hash('a'), clientHash: hash('a'), anonymous: false }
    const snapshot = snapshotCapacity([
      { kind: 'presence', key: '0:world', host: host([socket(mia, 3), socket(mia, 0)]) },
    ])
    expect(snapshot.presenceSlots).toBe(0)
    expect(snapshot.users).toBe(0)
  })

  it('ignores sockets without a well-formed identity', () => {
    expect(userKey(null)).toBeNull()
    expect(userKey({ tokenHash: 'short', anonymous: false })).toBeNull()
    expect(userKey({ tokenHash: hash('a'), anonymous: true })).toBeNull()
    expect(userKey({ tokenHash: hash('a'), clientHash: hash('b'), anonymous: true })).toBe(
      `client:${hash('b')}`,
    )
    expect(userKey({ tokenHash: hash('a'), clientHash: hash('b') })).toBe(`token:${hash('a')}`)
  })
})

describe('AdmissionCounters', () => {
  it('counts admitted upgrades and capacity rejections per channel only', () => {
    const counters = new AdmissionCounters()
    counters.record('live-sync', 200)
    counters.record('live-sync', 503)
    counters.record('live-sync', 401)
    counters.record('presence', 503)
    expect(counters.read('live-sync')).toEqual({ admitted: 1, rejected: 1 })
    expect(counters.read('presence')).toEqual({ admitted: 0, rejected: 1 })
  })

  it('maps upgrade paths under any mount to their channel', () => {
    expect(admissionChannel('/backend/v1/telemetry/live')).toBe('live-sync')
    expect(admissionChannel('/api/v1/telemetry/live')).toBe('live-sync')
    expect(admissionChannel('/custom/v1/telemetry/presence')).toBe('presence')
    expect(admissionChannel('/backend/v1/telemetry/presence/online')).toBeNull()
    expect(admissionChannel('/backend/v1/manifest')).toBeNull()
  })
})

describe('EventLoopLag', () => {
  it('reports finite non-negative seconds and resets between reads', async () => {
    const lag = new EventLoopLag()
    try {
      await new Promise((resolve) => setTimeout(resolve, 60))
      const first = lag.read()
      expect(first.max).toBeGreaterThanOrEqual(0)
      expect(first.p99).toBeGreaterThanOrEqual(0)
      expect(first.max).toBeLessThan(5)
      expect(lag.read()).toEqual({ p99: 0, max: 0 })
    } finally {
      lag.stop()
    }
  })
})

describe('renderCapacityMetrics', () => {
  it('renders every series with zero values for an empty pod and escapes labels', () => {
    const counters = new AdmissionCounters()
    const text = renderCapacityMetrics(
      snapshotCapacity([
        { kind: 'presence', key: '0:alliance:"7"', host: host([]) },
        { kind: 'live-sync', key: '0', host: host([]) },
      ]),
      counters,
      { p99: 0, max: 0.002 },
    )
    expect(text).toContain('caelestis_connected_users 0\n')
    expect(text).toContain('caelestis_live_sync_connections 0\n')
    expect(text).toContain('caelestis_presence_connections 0\n')
    expect(text).toContain('caelestis_live_pending_work 0\n')
    expect(text).toContain(
      'caelestis_coordinator_connections{kind="presence",coordinator="0:alliance:\\"7\\""} 0\n',
    )
    expect(text).toContain(
      `caelestis_coordinator_connection_limit{kind="live-sync",coordinator="0"} ${MAX_LIVE_SUBSCRIBERS}\n`,
    )
    expect(text).toContain('caelestis_admissions_total{channel="live-sync"} 0\n')
    expect(text).toContain('caelestis_admission_rejections_total{channel="presence"} 0\n')
    expect(text).toContain('caelestis_event_loop_lag_seconds{stat="max"} 0.002\n')
    expect(text.endsWith('\n')).toBe(true)
  })
})
