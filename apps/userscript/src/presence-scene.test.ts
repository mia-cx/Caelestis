// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { type SceneInputs, sceneItems } from './presence-scene.js'

const me = { wplaceUserId: 1, displayName: 'Mia' }
const peer = { wplaceUserId: 2, displayName: 'Other painter' }

const inputs = (showPresenceClaims: boolean): SceneInputs => ({
  view: {
    peers: [
      {
        sessionId: 'peer',
        painter: peer,
        viewport: null,
        draft: null,
        quickClaims: [{ x: 5, y: 5, w: 5, h: 5 }],
      },
    ],
    regions: [],
    online: 1,
    connected: true,
    me,
  },
  flags: {
    showPresence: true,
    showPresenceViewports: true,
    showPresenceClaims,
    showPresenceClaimsOnlyWhilePainting: false,
  },
  paintOpen: true,
  editingIds: [],
  quickClaims: [{ x: 0, y: 0, w: 4, h: 4 }],
  quickPreview: null,
  tool: [],
})

it("draws your quick claims while painting and others' only where claims show", () => {
  expect(sceneItems(inputs(true)).map(({ id, mine }) => [id, mine])).toEqual([
    ['quick:me:0', true],
    ['quick:peer:0', false],
  ])
  expect(sceneItems(inputs(false)).map(({ id }) => id)).toEqual(['quick:me:0'])
})
