import {
  MAX_PRESENCE_MESSAGES_PER_SECOND,
  MAX_QUICK_CLAIMS,
  PRESENCE_PROTOCOL_V1,
  PRESENCE_QUICK_CLAIMS_MIN_MS,
  PRESENCE_VIEWPORT_MIN_MS,
  type PresenceRect,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { importStateModules } from './state-modules.js'

const SERVER_ID = '018f4f2a-1234-7abc-8def-0123456789ab'
const painter = { wplaceUserId: 42, displayName: 'Mia' }
const other = { wplaceUserId: 7, displayName: 'Other painter' }

/** The signed-in Wplace account, which a test may switch. */
const account = vi.hoisted(() => ({
  current: null as { wplaceUserId: number; displayName: string } | null,
}))

vi.mock('../src/wplace-account.js', () => ({
  accountIdentity: () => account.current,
  loadAccount: async () => undefined,
}))
// The quick-claim gesture: the paint drawer is open, and the pointer is over world pixel (5, 6).
vi.mock('../src/wplace-paint.js', () => ({
  isPaintOpen: () => true,
  onPaintSelectionChange: () => {},
}))
vi.mock('../src/paint-cell.js', () => ({
  pickerPointAt: () => ({ x: 5.5, y: 6.5, alliance: null }),
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

  open(canWrite?: boolean): void {
    this.protocol = PRESENCE_PROTOCOL_V1
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
    this.receive({
      type: 'presence-ready',
      sessionId: 'a'.repeat(16),
      online: 1,
      peers: [],
      regions: [],
      ...(canWrite === undefined ? {} : { canWrite }),
    })
  }

  /** Every presence update this socket sent, in order. */
  updates(): Record<string, unknown>[] {
    return this.sent
      .map((data) => JSON.parse(data) as Record<string, unknown>)
      .filter((event) => event.type === 'presence-update')
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

beforeEach(() => {
  account.current = painter
})

/** One presence socket, opened: on an event server with `event`, and able to write with `canWrite`. */
const connect = async ({
  event = false,
  canWrite,
}: {
  event?: boolean
  canWrite?: boolean
} = {}) => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ regions: [] })),
  )
  const state = await importStateModules()
  const presence = await import('../src/presence-client.js')
  const server = {
    url: 'https://presence.test',
    info: {
      id: SERVER_ID,
      name: 'Presence test',
      auth: 'none' as const,
      presence: 1 as const,
      ...(event ? { capture: 1 as const } : {}),
    },
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
  socket.open(canWrite)
  await vi.advanceTimersByTimeAsync(0)
  return { presence, state, socket }
}

/** Ctrl+press on the map with the paint drawer open; true when quick claims took the gesture. */
const pressForQuickClaim = async (): Promise<boolean> => {
  const { installQuickClaims } = await import('../src/quick-claims.js')
  installQuickClaims()
  const map = document.createElement('canvas')
  document.body.append(map)
  const press = new PointerEvent('pointerdown', { ctrlKey: true, button: 0, cancelable: true })
  map.dispatchEvent(press)
  map.remove()
  return press.defaultPrevented
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

it('takes the quick-claim gesture where a server takes quick claims', async () => {
  await connect({ canWrite: true })
  expect(await pressForQuickClaim()).toBe(true)
})

it('leaves quick claims off an event server, the gesture included', async () => {
  const { presence, socket } = await connect({ event: true, canWrite: true })
  expect(await pressForQuickClaim()).toBe(false)
  presence.setPresenceQuickClaims([rect(0)])
  await vi.advanceTimersByTimeAsync(PRESENCE_QUICK_CLAIMS_MIN_MS)
  expect(socket.quickClaims()).toEqual([])
})

it('retires an event session when the Wplace account changes, and publishes once the new team is known', async () => {
  /** The team and viewport a socket published, in order; clears left out. */
  const published = (target: FakeWebSocket) =>
    target
      .updates()
      .flatMap((update) => [
        ...('team' in update ? [`team ${update.team}`] : []),
        ...(update.viewport != null ? ['viewport'] : []),
      ])
  const { presence, socket } = await connect({ event: true })
  presence.setPresenceTeam(2)
  presence.setPresenceViewport(rect(0))
  await vi.advanceTimersByTimeAsync(PRESENCE_VIEWPORT_MIN_MS)
  expect(published(socket)).toEqual(['team 2', 'viewport'])

  // Another account signs in; its team is not known yet.
  account.current = other
  presence.setPresenceTeam(null)
  await vi.advanceTimersByTimeAsync(0)
  expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
  const next = FakeWebSocket.instances[1]
  if (next === undefined) throw new Error('presence did not open a session for the new account')
  next.open()
  await vi.advanceTimersByTimeAsync(PRESENCE_VIEWPORT_MIN_MS)
  expect(published(next)).toEqual([])

  presence.setPresenceTeam(1)
  await vi.advanceTimersByTimeAsync(PRESENCE_VIEWPORT_MIN_MS)
  expect(published(next)).toEqual(['team 1', 'viewport'])
})
