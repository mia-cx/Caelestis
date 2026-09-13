// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  view: {
    peers: [] as unknown[],
    regions: [] as unknown[],
    online: 0,
    connected: true,
    me: null as { wplaceUserId: number; displayName: string } | null,
  },
  navigateTo: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../presence-client.js', () => ({
  presenceView: () => harness.view,
  presenceLiveServer: () => null,
  presenceRegionServer: () => null,
  presenceServers: () => [],
  claimRegion: vi.fn(),
  releaseRegion: vi.fn(),
}))
vi.mock('../claim-editor.js', () => ({
  installClaimEditor: vi.fn(),
  isClaimModeActive: () => false,
  startClaimMode: vi.fn(),
}))
vi.mock('../state.js', () => ({ activeServerToken: () => null }))
vi.mock('../templates/local-store.js', () => ({
  isServerTemplate: () => false,
  localTemplates: () => [],
}))
vi.mock('../templates/navigate.js', () => ({ navigateTo: harness.navigateTo }))
vi.mock('../wplace-account.js', () => ({ accountIdentity: () => harness.view.me }))
vi.mock('./toast.js', () => ({ toast: harness.toast }))

import { flyToPainter, presenceSummaryModel } from './presence-actions.js'

const rect = (x: number, y: number, w = 10, h = 10) => ({ x, y, w, h })
const painter = (wplaceUserId: number, displayName: string) => ({ wplaceUserId, displayName })
const claim = (id: string, who: ReturnType<typeof painter>, at: number, r = rect(500, 500)) => ({
  id,
  season: 1,
  surface: { kind: 'world', allianceId: null },
  templateId: null,
  claimant: who,
  document: { items: [{ id, op: 'add', shape: { kind: 'rectangle', ...r } }] },
  rect: r,
  label: '',
  createdAt: at,
})

beforeEach(() => {
  harness.view.peers = []
  harness.view.regions = []
  harness.view.online = 0
  harness.view.connected = true
  harness.view.me = null
  harness.navigateTo.mockClear()
  harness.toast.mockClear()
})

describe('presenceSummaryModel players', () => {
  it('lists live peers, painters first, then browsers, then the unlocated', () => {
    harness.view.peers = [
      { sessionId: 'b', painter: painter(2, 'Bo'), viewport: rect(0, 0), draft: null },
      { sessionId: 'c', painter: painter(3, 'Cy'), viewport: null, draft: null },
      {
        sessionId: 'a',
        painter: painter(1, 'Al'),
        viewport: rect(1, 1),
        draft: { rect: rect(2, 2, 4, 4), pixels: 12 },
      },
    ]
    const players = presenceSummaryModel()?.players ?? []
    expect(players.map((row) => [row.key, row.activity, row.canFly])).toEqual([
      ['a', 'painting 12 px', true],
      ['b', 'browsing', true],
      ['c', 'online', false],
    ])
    expect(players.every((row) => row.online)).toBe(true)
  })

  it('keeps painters known only by a claim, offline, after everyone live', () => {
    harness.view.peers = [
      { sessionId: 'b', painter: painter(2, 'Bo'), viewport: null, draft: null },
    ]
    harness.view.regions = [
      claim('r1', painter(9, 'Zed'), 1),
      claim('r2', painter(9, 'Zed'), 2),
      claim('r3', painter(2, 'Bo'), 3),
    ]
    const players = presenceSummaryModel()?.players ?? []
    expect(players.map((row) => [row.key, row.online, row.activity, row.canFly])).toEqual([
      ['b', true, 'rectangle · 100 px', true],
      ['user:9', false, '2 claims', true],
    ])
  })

  it('puts you first and offers Edit on your own claim', () => {
    harness.view.me = painter(7, 'Mia')
    harness.view.peers = [
      { sessionId: 'a', painter: painter(1, 'Al'), viewport: rect(1, 1), draft: null },
    ]
    harness.view.regions = [claim('mine', painter(7, 'Mia'), 5)]
    const players = presenceSummaryModel()?.players ?? []
    expect(players[0]).toMatchObject({
      key: 'user:7',
      mine: true,
      canFly: true,
      editRegionId: 'mine',
    })
    expect(players[1]?.key).toBe('a')
  })
})

describe('flyToPainter', () => {
  it('frames the drafted pixels over the viewport', () => {
    harness.view.peers = [
      {
        sessionId: 'a',
        painter: painter(1, 'Al'),
        viewport: rect(0, 0, 100, 100),
        draft: { rect: rect(20, 30, 4, 6), pixels: 3 },
      },
    ]
    expect(flyToPainter('a')).toBe(true)
    expect(harness.navigateTo).toHaveBeenCalledWith({ x: 22, y: 33, width: 4, height: 6 })
  })

  it('falls back to the newest claim when a peer has no viewport', () => {
    harness.view.peers = [
      { sessionId: 'a', painter: painter(1, 'Al'), viewport: null, draft: null },
    ]
    harness.view.regions = [
      claim('old', painter(1, 'Al'), 1, rect(0, 0)),
      claim('new', painter(1, 'Al'), 2, rect(100, 100, 20, 20)),
    ]
    expect(flyToPainter('a')).toBe(true)
    expect(harness.navigateTo).toHaveBeenCalledWith({ x: 110, y: 110, width: 20, height: 20 })
  })

  it('refuses to fly to someone who has left', () => {
    expect(flyToPainter('gone')).toBe(false)
    expect(harness.navigateTo).not.toHaveBeenCalled()
    expect(harness.toast).toHaveBeenCalledWith(expect.stringContaining('no longer known'), 'error')
  })
})
