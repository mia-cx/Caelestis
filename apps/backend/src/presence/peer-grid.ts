import type { PresencePeer, PresenceRect } from '@caelestis/shared'

const CELL_SIZE = 4_096
/** A rect over more cells than this is not bucketed: wide peers are checked by every lookup. */
const MAX_CELLS = 64
const ROW = 2 ** 26

/** Grid cells a rect covers, or null when it covers more than `MAX_CELLS`. */
const cells = (rect: PresenceRect): number[] | null => {
  const left = Math.floor(rect.x / CELL_SIZE)
  const right = Math.floor((rect.x + rect.w - 1) / CELL_SIZE)
  const top = Math.floor(rect.y / CELL_SIZE)
  const bottom = Math.floor((rect.y + rect.h - 1) / CELL_SIZE)
  if ((right - left + 1) * (bottom - top + 1) > MAX_CELLS) return null
  const keys: number[] = []
  for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) keys.push(x * ROW + y)
  return keys
}

const peerRects = (peer: PresencePeer): PresenceRect[] => [
  ...(peer.viewport === null ? [] : [peer.viewport]),
  ...(peer.draft == null ? [] : [peer.draft.rect]),
  ...(peer.quickClaims ?? []),
]

/**
 * Peers bucketed by the cells their viewport, draft and quick claims cover. `near` returns every
 * peer with a rect that can intersect the given one, and usually few others, so selection cost
 * follows the peers nearby rather than everyone in the room.
 */
export class PeerGrid {
  private readonly buckets = new Map<number, PresencePeer[]>()
  private readonly wide: PresencePeer[] = []

  constructor(private readonly peers: readonly PresencePeer[]) {
    for (const peer of peers) {
      const keys = new Set<number>()
      let wide = false
      for (const rect of peerRects(peer)) {
        const covered = cells(rect)
        if (covered === null) {
          wide = true
          break
        }
        for (const key of covered) keys.add(key)
      }
      if (wide) {
        this.wide.push(peer)
        continue
      }
      for (const key of keys) {
        const bucket = this.buckets.get(key)
        if (bucket === undefined) this.buckets.set(key, [peer])
        else bucket.push(peer)
      }
    }
  }

  /** A superset of the peers with a rect intersecting `rect`, in no particular order. */
  near(rect: PresenceRect): Iterable<PresencePeer> {
    const covered = cells(rect)
    if (covered === null) return this.peers
    const found = new Set(this.wide)
    for (const key of covered) for (const peer of this.buckets.get(key) ?? []) found.add(peer)
    return found
  }
}
