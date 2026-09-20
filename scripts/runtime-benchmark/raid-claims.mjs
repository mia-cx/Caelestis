import assert from 'node:assert/strict'

/** Stable IDs make the claim trace identical across runtimes and repeated builds. */
export const claimId = (user, generation = 0) =>
  `01950000-0000-7000-8000-${String(user).padStart(6, '0')}${String(generation).padStart(6, '0')}`

export const raidClaim = (user, origin, version) => {
  const x = origin.x + (user % 12) * 80
  const y = origin.y + Math.floor(user / 12) * 80
  return {
    actor: { wplaceUserId: 800000 + user, displayName: `Benchmark ${user}` },
    label: `Raid ${user}`,
    document: {
      items: [
        { id: 'outer', op: 'add', shape: { kind: 'rectangle', x, y, w: 64, h: 64 } },
        {
          id: 'hole',
          op: 'subtract',
          shape: { kind: 'ellipse', x: x + 16, y: y + 16, w: 32, h: 32 },
        },
        {
          id: 'piece',
          op: 'add',
          shape: { kind: 'rectangle', x: x + 72, y: y + version * 8, w: 8, h: 8 },
        },
      ],
    },
  }
}

/** Legitimate edits, unchanged reconciliation, deletion and creation; no conflicting writers. */
export const raidClaimSchedule = (durationMs, model) => {
  const events = []
  for (let offset = 0; offset < Math.min(model.painters, 12); offset++) {
    const user = model.explorers + offset
    let step = 0
    for (let at = 5000 + offset * 100; at < durationMs; at += 4000) {
      const phase = step % 4
      const generation = Math.floor((step + 1) / 4)
      step++
      events.push({
        at,
        user,
        kind: 'claim',
        id: claimId(user, generation),
        operation: ['edit', 'unchanged', 'delete', 'create'][phase],
        version: phase === 3 ? 1 : 0,
      })
    }
  }
  return events
}

/** Compare public documents and credential-specific ownership after the last mutation settles. */
export const assertClaims = (state, expected, user) => {
  assert.deepEqual([...state.regions.keys()].sort(), [...expected.keys()].sort())
  for (const [id, claim] of expected) {
    const region = state.regions.get(id)
    assert.deepEqual(region.document, claim.document)
    assert.deepEqual(region.claimant, claim.actor)
    assert.equal(region.label, claim.label)
  }
  assert.deepEqual(
    [...state.ownedRegionIds].sort(),
    [...expected]
      .filter(([, claim]) => claim.actor.wplaceUserId === 800000 + user)
      .map(([id]) => id)
      .sort(),
  )
}
