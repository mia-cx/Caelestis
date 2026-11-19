import { MAX_PRESENCE_SUBSCRIBERS } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { MAX_LIVE_SUBSCRIBERS } from '../live/session.js'
import {
  AdmissionCounters,
  admissionChannel,
  type CapacityCoordinator,
  EventLoopLag,
  type Occupant,
  renderCapacityMetrics,
  snapshotCapacity,
} from './capacity.js'

const hash = (seed: string) => seed.repeat(64).slice(0, 64)
const coordinator = (
  kind: CapacityCoordinator['kind'],
  occupants: readonly (Occupant | null)[],
  pendingWork = 0,
): CapacityCoordinator => ({ kind, key: '0', occupants, pendingWork })

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
      coordinator('live-sync', [mia, mia, browser, secondBrowser], 3),
      coordinator('presence', [mia], 1),
    ])
    expect(snapshot).toEqual({
      users: 3,
      liveSlots: 4,
      presenceSlots: 1,
      pendingWork: 4,
      coordinators: [
        { kind: 'live-sync', key: '0', connections: 4, limit: MAX_LIVE_SUBSCRIBERS },
        { kind: 'presence', key: '0', connections: 1, limit: MAX_PRESENCE_SUBSCRIBERS },
      ],
    })
  })

  it('reports the fullest host when several rooms share a series key', () => {
    const mia = { tokenHash: hash('a'), clientHash: hash('a'), anonymous: false }
    const eve = { tokenHash: hash('e'), clientHash: hash('e'), anonymous: false }
    const snapshot = snapshotCapacity([
      coordinator('presence', [mia]),
      coordinator('presence', [mia, eve]),
      coordinator('presence', []),
    ])
    expect(snapshot.presenceSlots).toBe(3)
    expect(snapshot.users).toBe(2)
    expect(snapshot.coordinators).toEqual([
      { kind: 'presence', key: '0', connections: 2, limit: MAX_PRESENCE_SUBSCRIBERS },
    ])
  })

  it('reports the live-sync limit admission uses when a deployment overrides it', () => {
    const snapshot = snapshotCapacity([coordinator('live-sync', [])], 7)
    expect(snapshot.coordinators).toEqual([
      { kind: 'live-sync', key: '0', connections: 0, limit: 7 },
    ])
  })

  it('counts no user for a socket without a well-formed identity', () => {
    const snapshot = snapshotCapacity([
      coordinator('live-sync', [
        null,
        { tokenHash: 'short', anonymous: false },
        { tokenHash: hash('a'), anonymous: true },
      ]),
    ])
    expect(snapshot.users).toBe(0)
    expect(snapshot.liveSlots).toBe(3)
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

  it('maps the unversioned alias to its channel too', () => {
    expect(admissionChannel('/backend/telemetry/live')).toBe('live-sync')
    expect(admissionChannel('/backend/telemetry/presence')).toBe('presence')
    expect(admissionChannel('/backend/telemetry/presence/online')).toBeNull()
  })
})

describe('EventLoopLag', () => {
  it('starts a fresh window on every read', () => {
    const lag = new EventLoopLag()
    try {
      lag.read()
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
        { ...coordinator('presence', []), key: 'quoted:"7"' },
        coordinator('live-sync', []),
      ]),
      counters,
      { p99: 0, max: 0.002 },
    )
    expect(text).toContain('caelestis_connected_users 0\n')
    expect(text).toContain('caelestis_live_sync_connections 0\n')
    expect(text).toContain('caelestis_presence_connections 0\n')
    expect(text).toContain('caelestis_live_pending_work 0\n')
    expect(text).toContain(
      'caelestis_coordinator_connections{kind="presence",coordinator="quoted:\\"7\\""} 0\n',
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
