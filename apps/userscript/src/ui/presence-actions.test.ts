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
const claim = (id: string, who: ReturnType<typeof painter>, r = rect(500, 500)) => ({
  id,
  season: 1,
  surface: { kind: 'world', allianceId: null },
  templateId: null,
  claimant: who,
  document: { items: [{ id, op: 'add', shape: { kind: 'rectangle', ...r } }] },
  rect: r,
  label: '',
  createdAt: 1,
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
  it('lists the nearby peers: painters first, then browsers, then the unlocated', () => {
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
    expect(players.map((row) => [row.key, row.name, row.activity, row.canFly])).toEqual([
      ['a', 'Al', 'painting 12 px', true],
      ['b', 'Bo', 'browsing', true],
      ['c', 'Cy', 'online', false],
    ])
  })

  it('hides the drawer without the socket, even with cached claims', () => {
    harness.view.connected = false
    harness.view.regions = [claim('r1', painter(9, 'Zed'))]
    expect(presenceSummaryModel()).toBeUndefined()
  })

  it('leaves out anyone known only by a claim, and you', () => {
    harness.view.me = painter(7, 'Mia')
    harness.view.regions = [claim('r1', painter(9, 'Zed')), claim('mine', painter(7, 'Mia'))]
    expect(presenceSummaryModel()?.players).toEqual([])
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

  it('frames the viewport when nothing is drafted', () => {
    harness.view.peers = [
      { sessionId: 'a', painter: painter(1, 'Al'), viewport: rect(100, 100, 20, 20), draft: null },
    ]
    expect(flyToPainter('a')).toBe(true)
    expect(harness.navigateTo).toHaveBeenCalledWith({ x: 110, y: 110, width: 20, height: 20 })
  })

  it('never flies to a claim, and refuses once the painter has left', () => {
    harness.view.peers = [
      { sessionId: 'a', painter: painter(1, 'Al'), viewport: null, draft: null },
    ]
    harness.view.regions = [claim('r', painter(1, 'Al'))]
    expect(flyToPainter('a')).toBe(false)
    expect(flyToPainter('gone')).toBe(false)
    expect(harness.navigateTo).not.toHaveBeenCalled()
    expect(harness.toast).toHaveBeenCalledWith('That painter is no longer here.', 'error')
  })
})
