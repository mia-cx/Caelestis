// @vitest-environment happy-dom

import type { RegionClaim, RegionDocument } from '@caelestis/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaimEditorHost } from '../claim-editor.js'

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
  editor: null as ClaimEditorHost | null,
  saveAll: vi.fn(async (ids: readonly string[]) => ({ ids, error: null })),
}))

vi.mock('../claim-routing.js', () => ({
  claimRouter: () => ({
    mine: () => harness.view.regions,
    saveAll: harness.saveAll,
  }),
}))

vi.mock('../presence-client.js', () => ({
  presenceView: () => harness.view,
  presenceLiveServer: () => null,
  presenceRegionServer: () => null,
  presenceServers: () => [{ season: 1 }],
  claimRegion: vi.fn(),
  releaseRegion: vi.fn(),
}))
vi.mock('../claim-editor.js', () => ({
  installClaimEditor: (host: ClaimEditorHost) => {
    harness.editor = host
  },
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

import { flyToPainter, installClaimToolHost, presenceSummaryModel } from './presence-actions.js'

const rect = (x: number, y: number, w = 10, h = 10) => ({ x, y, w, h })
const painter = (wplaceUserId: number, displayName: string) => ({ wplaceUserId, displayName })
const claim = (id: string, who: ReturnType<typeof painter>, r = rect(500, 500)): RegionClaim => ({
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
  harness.saveAll.mockClear()
})

describe('presenceSummaryModel players', () => {
  it('loads all logical claims once and routes editor writes through the claim owner', async () => {
    const region = claim('mine', painter(7, 'Mia'))
    harness.view.regions = [region, claim('other-server', painter(7, 'Mia'))]
    installClaimToolHost()
    expect(harness.editor?.myRegions().map((region) => region.id)).toEqual(['mine', 'other-server'])
    await harness.editor?.save([region.id], [region.document])
    expect(harness.saveAll).toHaveBeenCalledWith([region.id], [region.document])
  })

  it('names a saved batch by its real pixels and toasts once', async () => {
    installClaimToolHost()
    const near: RegionDocument = {
      items: [{ id: 'n', op: 'add', shape: { kind: 'rectangle', x: 0, y: 0, w: 1, h: 1 } }],
    }
    const far: RegionDocument = {
      items: [{ id: 'f', op: 'add', shape: { kind: 'rectangle', x: 2_000, y: 2_000, w: 1, h: 1 } }],
    }
    await harness.editor?.save([], [near, far])
    expect(harness.saveAll).toHaveBeenCalledOnce()
    expect(harness.saveAll).toHaveBeenCalledWith([], [near, far])
    expect(harness.toast).toHaveBeenCalledTimes(1)
    expect(harness.toast).toHaveBeenCalledWith(expect.stringContaining('2 px'))
  })

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
