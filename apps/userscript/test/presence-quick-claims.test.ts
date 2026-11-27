import {
  MAX_PRESENCE_MESSAGES_PER_SECOND,
  MAX_QUICK_CLAIMS,
  PRESENCE_QUICK_CLAIMS_MIN_MS,
  type PresenceRect,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { afterEach, expect, it, vi } from 'vitest'
import { connectPresence, FakeWebSocket, SERVER_ID } from './presence-socket.js'
import { importStateModules } from './state-modules.js'

const painter = { wplaceUserId: 42, displayName: 'Mia' }
const other = { wplaceUserId: 7, displayName: 'Other painter' }

vi.mock('../src/wplace-account.js', () => ({
  accountIdentity: () => painter,
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

/** One presence socket, opened: on an event server with `event`, and able to write with `canWrite`. */
const connect = async ({
  event = false,
  canWrite,
}: {
  event?: boolean
  canWrite?: boolean
} = {}) => {
  const connected = await connectPresence({ ...(event ? { capture: 1 as const } : {}), canWrite })
  dispose = connected.dispose
  return connected
}

const rect = (x: number): PresenceRect => ({ x, y: 10, w: 4, h: 3 })

it('sends the first quick claim at once, then only the latest list of a burst, clears included', async () => {
  const { presence, socket } = await connect()
  presence.setPresenceQuickClaims([rect(0)])
  await vi.advanceTimersByTimeAsync(0)
  for (let count = 2; count <= 16; count++) {
    presence.setPresenceQuickClaims(Array.from({ length: count }, (_, index) => rect(index * 10)))
    await vi.advanceTimersByTimeAsync(20)
  }
  await vi.advanceTimersByTimeAsync(PRESENCE_QUICK_CLAIMS_MIN_MS)
  presence.setPresenceQuickClaims([])
  await vi.advanceTimersByTimeAsync(PRESENCE_QUICK_CLAIMS_MIN_MS)
  const sent = socket.quickClaims() as PresenceRect[][]
  expect(sent.map((rects) => rects.length)).toEqual([1, 16, 0])
  // Sixteen rectangles drawn in a third of a second stay inside the server's per-second limit.
  expect(socket.sent.length).toBeLessThanOrEqual(MAX_PRESENCE_MESSAGES_PER_SECOND)
})

it('sends held quick claims again on a new session, and none when there are none', async () => {
  const { presence, socket } = await connect()
  presence.setPresenceQuickClaims([rect(0)])
  await vi.advanceTimersByTimeAsync(0)
  socket.readyState = FakeWebSocket.CLOSED
  socket.dispatchEvent(new Event('close'))
  await vi.advanceTimersByTimeAsync(2_000)
  const second = FakeWebSocket.instances[1]
  if (second === undefined) throw new Error('presence did not reconnect')
  second.open()
  await vi.advanceTimersByTimeAsync(0)
  expect(second.quickClaims()).toEqual([[rect(0)]])

  presence.setPresenceQuickClaims([])
  await vi.advanceTimersByTimeAsync(0)
  second.readyState = FakeWebSocket.CLOSED
  second.dispatchEvent(new Event('close'))
  await vi.advanceTimersByTimeAsync(4_000)
  const third = FakeWebSocket.instances[2]
  if (third === undefined) throw new Error('presence did not reconnect twice')
  third.open()
  await vi.advanceTimersByTimeAsync(0)
  expect(third.quickClaims()).toEqual([])
})

it('withdraws quick claims when sharing stops, but not when the tab is hidden', async () => {
  const { presence, state, socket } = await connect()
  presence.setPresenceQuickClaims([rect(0)])
  await vi.advanceTimersByTimeAsync(0)
  const visibility = async (value: 'hidden' | 'visible') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(PRESENCE_QUICK_CLAIMS_MIN_MS)
  }
  await visibility('hidden')
  await visibility('visible')
  state.setState({ sharePresence: false })
  await vi.advanceTimersByTimeAsync(PRESENCE_QUICK_CLAIMS_MIN_MS)
  expect(socket.quickClaims()).toEqual([[rect(0)], []])
  state.setState({ sharePresence: true })
})

it("shows a peer's quick claims and drops a peer carrying too many", async () => {
  const { presence, socket } = await connect()
  const peer = (sessionId: string, quickClaims: PresenceRect[]) => ({
    sessionId,
    painter: other,
    viewport: null,
    draft: null,
    quickClaims,
  })
  socket.receive({
    type: 'presence-delta',
    online: 3,
    upsert: [
      peer('b'.repeat(16), [rect(0)]),
      peer(
        'c'.repeat(16),
        Array.from({ length: MAX_QUICK_CLAIMS + 1 }, (_, index) => rect(index * 10)),
      ),
    ],
    remove: [],
  })
  expect(presence.presenceView().peers.map((peer) => peer.quickClaims)).toEqual([[rect(0)]])
})

it('shows polled claims until a session starts, then only what the socket reports', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const polled = {
    id: 'polled',
    season: 1,
    surface: WORLD_TEMPLATE_SURFACE,
    templateId: null,
    claimant: other,
    document: {
      items: [{ id: 'a', op: 'add', shape: { kind: 'rectangle', x: 0, y: 0, w: 2, h: 2 } }],
    },
    rect: { x: 0, y: 0, w: 2, h: 2 },
    label: '',
    createdAt: 1,
  }
  const fetch = vi.fn(async () => Response.json({ regions: [polled], canWrite: false }))
  vi.stubGlobal('fetch', fetch)
  const state = await importStateModules()
  const presence = await import('../src/presence-client.js')
  const server = {
    url: 'https://presence.test',
    info: { id: SERVER_ID, name: 'Presence test', auth: 'none' as const, presence: 1 as const },
    token: null,
    status: 'connected' as const,
    isAdmin: false,
    season: 1,
  }
  dispose = () => state.removeServer(server.url)
  state.upsertServer(server)
  presence.installPresence()
  await vi.advanceTimersByTimeAsync(0)
  expect(presence.presenceView().regions.map((region) => region.id)).toEqual(['polled'])

  FakeWebSocket.instances[0]?.open()
  expect(presence.presenceView().regions).toEqual([])
  const reads = fetch.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fetch.mock.calls.length).toBe(reads)
})

it('offers quick claims on a writable session of a server that takes them', async () => {
  const { presence } = await connect({ canWrite: true })
  expect(presence.quickClaimsAvailable()).toBe(true)
})

it('offers no quick claims on a read-only session, whose claims the server drops', async () => {
  const { presence } = await connect()
  expect(presence.quickClaimsAvailable()).toBe(false)
})

it('leaves quick claims off an event server', async () => {
  const { presence, socket } = await connect({ event: true, canWrite: true })
  expect(presence.quickClaimsAvailable()).toBe(false)
  presence.setPresenceQuickClaims([rect(0)])
  await vi.advanceTimersByTimeAsync(PRESENCE_QUICK_CLAIMS_MIN_MS)
  expect(socket.quickClaims()).toEqual([])
})
