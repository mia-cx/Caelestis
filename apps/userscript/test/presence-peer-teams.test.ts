import { uuidV7 } from '@caelestis/shared'
import { afterEach, expect, it, vi } from 'vitest'
import { connectPresence, FakeWebSocket } from './presence-socket.js'

vi.mock('../src/wplace-account.js', () => ({
  accountIdentity: () => ({ wplaceUserId: 42, displayName: 'Mia' }),
  loadAccount: async () => undefined,
}))

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.clearAllTimers()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
  FakeWebSocket.instances = []
})

it("keeps a painter's team from an event server while a regular server reports them too", async () => {
  const { presence, state, socket: event, dispose: leave } = await connectPresence({ capture: 1 })
  dispose = leave
  // A regular server this tab is also connected to.
  state.upsertServer({
    url: 'https://regular.test',
    info: { id: uuidV7(), name: 'Regular', auth: 'none', presence: 1 },
    token: null,
    status: 'connected',
    isAdmin: false,
    season: 1,
  })
  await vi.advanceTimersByTimeAsync(0)
  const regular = FakeWebSocket.instances[1]
  if (regular === undefined) throw new Error('Expected a socket for the regular server')
  regular.open()
  await vi.advanceTimersByTimeAsync(0)

  // One painter, the same publisher on both servers; only the event server knows their team.
  const ada = {
    sessionId: 'b'.repeat(16),
    publisherId: uuidV7(),
    painter: { wplaceUserId: 7, displayName: 'Ada' },
    viewport: { x: 0, y: 0, w: 8, h: 8 },
    draft: null,
  }
  const teams = () => presence.presenceView().peers.map(({ team }) => team)
  event.receive({ type: 'presence-delta', online: 2, upsert: [{ ...ada, team: 1 }], remove: [] })
  // The regular server's copy arrives later and is the newest; the team stays.
  regular.receive({ type: 'presence-delta', online: 2, upsert: [ada], remove: [] })
  expect(teams()).toEqual([1])
  // Once the event server no longer reports them, no copy carries a team.
  event.receive({ type: 'presence-delta', online: 1, upsert: [], remove: [ada.sessionId] })
  expect(teams()).toEqual([undefined])
})
