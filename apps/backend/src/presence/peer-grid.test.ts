import { type PresencePeer, type PresenceRect, rectsIntersect } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { PeerGrid } from './peer-grid.js'

let seed = 7
const random = (limit: number) => {
  seed = (seed * 16_807) % 2_147_483_647
  return Math.floor((seed / 2_147_483_647) * limit)
}
// Mostly small rects, some on cell edges, some wide enough to skip bucketing.
const rect = (): PresenceRect => {
  const size = [8, 4_096, 6_000, 40_000][random(4)] ?? 8
  return { x: random(200_000), y: random(200_000), w: size, h: 8 + random(size) }
}

it('finds every peer whose viewport, draft or quick claim meets the lookup', () => {
  const peers: PresencePeer[] = Array.from({ length: 600 }, (_, index) => ({
    sessionId: String(index),
    painter: { wplaceUserId: index, displayName: String(index) },
    viewport: random(5) === 0 ? null : rect(),
    draft: random(3) === 0 ? { rect: rect(), pixels: 1 } : null,
    ...(random(4) === 0 ? { quickClaims: [rect(), rect()] } : {}),
  }))
  const grid = new PeerGrid(peers)
  for (let lookup = 0; lookup < 400; lookup++) {
    const interest = rect()
    const found = new Set(grid.near(interest))
    for (const peer of peers) {
      const rects = [peer.viewport, peer.draft?.rect, ...(peer.quickClaims ?? [])]
      if (rects.some((each) => each != null && rectsIntersect(interest, each)))
        expect(found.has(peer), `peer ${peer.sessionId}`).toBe(true)
    }
  }
})
