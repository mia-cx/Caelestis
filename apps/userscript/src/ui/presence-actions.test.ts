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
  mine: [] as RegionClaim[],
  navigateTo: vi.fn(),
  toast: vi.fn(),
  editor: null as ClaimEditorHost | null,
  saveAll: vi.fn(async (ids: readonly string[]) => ({ ids, error: null })),
  remove: vi.fn(async (_id: string): Promise<string | null> => null),
  writable: true,
}))

vi.mock('../claim-routing.js', () => ({
  claimRouter: () => ({
    mine: () => harness.mine,
    saveAll: harness.saveAll,
    remove: harness.remove,
  }),
}))

vi.mock('../presence-client.js', () => ({
  presenceView: () => harness.view,
  presenceLiveServer: () => null,
  presenceRegionServer: () => null,
  presenceServers: () => [{ season: 1 }],
  presenceCanWriteClaims: () => harness.writable,
  presenceServerClaims: () => ({ regions: harness.view.regions }),
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

import {
  clearClaim,
  flyToClaim,
  flyToPainter,
  installClaimToolHost,
  presenceSummaryModel,
} from './presence-actions.js'

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
  harness.mine = []
  harness.navigateTo.mockClear()
  harness.toast.mockClear()
  harness.saveAll.mockClear()
  harness.remove.mockReset()
  harness.remove.mockResolvedValue(null)
  harness.writable = true
})

describe('presenceSummaryModel players', () => {
  it('loads all logical claims once and routes editor writes through the claim owner', async () => {
    const region = claim('mine', painter(7, 'Mia'))
    harness.mine = [region, claim('other-server', painter(7, 'Mia'))]
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

describe('presenceSummaryModel claims', () => {
  it('clears a server-confirmed own claim without needing local credential ownership', async () => {
    harness.view.me = painter(7, 'Mia')
    harness.view.regions = [claim('mine', painter(7, 'Mia')), claim('other', painter(8, 'Sam'))]
    expect(presenceSummaryModel()?.claims?.map((row) => row.canClear)).toEqual([true, false])
    const changed = vi.fn()
    await clearClaim('mine', changed)
    expect(harness.remove).toHaveBeenCalledWith('mine')
    expect(changed).toHaveBeenCalledTimes(2)
    harness.writable = false
    expect(presenceSummaryModel()?.claims?.every((row) => !row.canClear)).toBe(true)
    await clearClaim('mine', changed)
    expect(harness.remove).toHaveBeenCalledTimes(1)
  })

  it('prevents duplicate clears and makes failures retryable', async () => {
    harness.view.me = painter(7, 'Mia')
    harness.view.regions = [claim('mine', painter(7, 'Mia'))]
    let finish: (error: string) => void = () => {}
    harness.remove.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const changed = vi.fn()
    const pending = clearClaim('mine', changed)
    await clearClaim('mine', changed)
    expect(harness.remove).toHaveBeenCalledTimes(1)
    finish('Server unreachable. The claim will retry.')
    await pending
    expect(harness.toast).toHaveBeenCalledWith('Server unreachable. The claim will retry.', 'error')
    expect(presenceSummaryModel()?.claims?.[0]?.canClear).toBe(true)
  })

  it('omits locally cached claims absent from every server snapshot', () => {
    harness.view.me = painter(7, 'Mia')
    harness.mine = [claim('stale', painter(7, 'Mia'))]
    expect(presenceSummaryModel()?.claims).toEqual([])
    expect(flyToClaim('stale')).toBe(false)
    expect(harness.navigateTo).not.toHaveBeenCalled()
  })

  it('lists your claims first, newest first, then everyone else by name', () => {
    harness.view.me = painter(7, 'Mia')
    harness.mine = [
      { ...claim('old-mine', painter(7, 'Mia')), createdAt: 1 },
      { ...claim('new-mine', painter(7, 'Mia')), createdAt: 5 },
    ]
    harness.view.regions = [
      ...harness.mine,
      claim('z1', painter(9, 'Zed')),
      claim('a1', painter(2, 'Al')),
    ]
    const claims = presenceSummaryModel()?.claims ?? []
    expect(claims.map((row) => [row.key, row.name, row.mine, row.description])).toEqual([
      ['new-mine', 'You', true, 'rectangle · 10×10'],
      ['old-mine', 'You', true, 'rectangle · 10×10'],
      ['a1', 'Al', false, 'rectangle · 10×10'],
      ['z1', 'Zed', false, 'rectangle · 10×10'],
    ])
  })

  it('describes rows from the shape kinds and the server rect without rasterising', () => {
    const region = claim('r', painter(9, 'Zed'), rect(0, 0, 640, 480))
    harness.view.regions = [
      {
        ...region,
        document: {
          items: [
            ...region.document.items,
            { id: 'e', op: 'add', shape: { kind: 'ellipse', x: 0, y: 0, w: 4, h: 4 } },
          ],
        },
      },
    ]
    expect(presenceSummaryModel()?.claims?.[0]?.description).toBe('2 shapes · 640×480')
  })

  it('lists your claims the server holds even before the local store adopts them', () => {
    harness.view.me = painter(7, 'Mia')
    harness.mine = [claim('local', painter(7, 'Mia'))]
    harness.view.regions = [
      claim('local', painter(7, 'Mia')),
      claim('elsewhere', painter(7, 'Mia')),
      claim('z1', painter(9, 'Zed')),
    ]
    const claims = presenceSummaryModel()?.claims ?? []
    expect(claims.map((row) => [row.key, row.mine])).toEqual([
      ['local', true],
      ['elsewhere', true],
      ['z1', false],
    ])
  })

  it('leaves out claims on other surfaces and seasons the map cannot show', () => {
    harness.view.regions = [
      { ...claim('alliance', painter(9, 'Zed')), surface: { kind: 'alliance', allianceId: 4 } },
      { ...claim('season', painter(9, 'Zed')), season: 2 },
      claim('world', painter(9, 'Zed')),
    ]
    expect(presenceSummaryModel()?.claims?.map((row) => row.key)).toEqual(['world'])
  })
})

describe('flyToClaim', () => {
  it('frames the claim rect, yours or theirs', () => {
    harness.view.me = painter(7, 'Mia')
    harness.mine = [claim('mine', painter(7, 'Mia'), rect(100, 200, 40, 20))]
    harness.view.regions = [
      ...harness.mine,
      claim('theirs', painter(9, 'Zed'), rect(300, 300, 10, 10)),
    ]
    expect(flyToClaim('mine')).toBe(true)
    expect(harness.navigateTo).toHaveBeenLastCalledWith({ x: 120, y: 210, width: 40, height: 20 })
    expect(flyToClaim('theirs')).toBe(true)
    expect(harness.navigateTo).toHaveBeenLastCalledWith({ x: 305, y: 305, width: 10, height: 10 })
  })

  it('refuses once the claim is gone', () => {
    expect(flyToClaim('gone')).toBe(false)
    expect(harness.navigateTo).not.toHaveBeenCalled()
    expect(harness.toast).toHaveBeenCalledWith('That claim is no longer here.', 'error')
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
