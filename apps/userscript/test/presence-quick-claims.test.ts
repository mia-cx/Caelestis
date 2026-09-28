import {
  MAX_PRESENCE_MESSAGES_PER_SECOND,
  MAX_QUICK_CLAIMS,
  PRESENCE_PROTOCOL_V1,
  PRESENCE_QUICK_CLAIMS_MIN_MS,
  type PresenceRect,
} from '@caelestis/shared'
import { afterEach, expect, it, vi } from 'vitest'

const SERVER_ID = '018f4f2a-1234-7abc-8def-0123456789ab'
const painter = { wplaceUserId: 42, displayName: 'Mia' }
const other = { wplaceUserId: 7, displayName: 'Other painter' }

vi.mock('../src/wplace-account.js', () => ({
  accountIdentity: () => painter,
  loadAccount: async () => undefined,
}))

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly sent: string[] = []
  protocol = ''
  readyState = FakeWebSocket.CONNECTING

  constructor() {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('socket is not open')
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState >= FakeWebSocket.CLOSING) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  open(): void {
    this.protocol = PRESENCE_PROTOCOL_V1
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
    this.receive({
      type: 'presence-ready',
      sessionId: 'a'.repeat(16),
      online: 1,
      peers: [],
      regions: [],
    })
  }

  receive(event: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
  }

  /** Every quick-claim list this socket sent, in order. */
  quickClaims(): unknown[] {
    return this.sent
      .map((data) => JSON.parse(data) as { quickClaims?: unknown })
      .filter((event) => 'quickClaims' in event)
      .map((event) => event.quickClaims)
  }
}

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

const connect = async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ regions: [] })),
  )
  const state = await import('../src/state.js')
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
  const socket = FakeWebSocket.instances[0]
  if (socket === undefined) throw new Error('presence did not open a socket')
  socket.open()
  await vi.advanceTimersByTimeAsync(0)
  return { presence, state, socket }
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
