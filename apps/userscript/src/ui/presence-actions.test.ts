// @vitest-environment happy-dom
import type { PresencePeer, TerritoryTeam } from '@caelestis/shared'
import { type PanelModel, registerCaelestisUi } from '@caelestis/ui/elements'
import { afterEach, assert, expect, it, vi } from 'vitest'
import type { PresenceView } from '../presence-client.js'

const harness = vi.hoisted(() => ({ peers: [] as PresencePeer[] }))
vi.mock('../presence-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../presence-client.js')>()),
  presenceView: (): PresenceView => ({
    peers: harness.peers,
    regions: [],
    online: harness.peers.length,
    connected: true,
    me: null,
  }),
}))

import { presenceSummaryModel } from './presence-actions.js'

afterEach(() => {
  document.body.replaceChildren()
})

const peer = (userId: number, displayName: string, team?: TerritoryTeam): PresencePeer => ({
  sessionId: `session-${userId}`,
  painter: { wplaceUserId: userId, displayName },
  viewport: { x: 0, y: 0, w: 64, h: 64 },
  draft: null,
  ...(team === undefined ? {} : { team }),
})

/** The name line of each row in the Painters drawer, as the panel renders the received peers. */
const renderedNames = async (peers: PresencePeer[]) => {
  harness.peers = peers
  const presence = presenceSummaryModel()
  assert(presence)
  registerCaelestisUi()
  const tree = { query: '', sort: { field: 'custom', direction: 'asc' }, entries: [] } as const
  const element = document.createElement('caelestis-panel') as HTMLElement & { model: PanelModel }
  element.model = {
    view: 'tree',
    width: 320,
    minWidth: 280,
    maxWidth: 400,
    tree,
    drawers: { tree, error: '', canShowOthers: false, showOthers: false, presence },
  }
  document.body.append(element)
  const names = await vi.waitFor(() => {
    const rendered = element.shadowRoot?.querySelectorAll('.player-name') ?? []
    expect(rendered).toHaveLength(peers.length)
    return rendered
  })
  return [...names].map((name) => name.textContent?.replace(/\s+/g, ' ').trim())
}

it("shows each painter's event team next to their name, and nothing for a painter without one", async () => {
  expect(await renderedNames([peer(1, 'Ada', 1), peer(2, 'Bea', 3), peer(3, 'Cy')])).toEqual([
    'Ada #1 Orange',
    'Bea #2 Purple',
    'Cy #3',
  ])
})
