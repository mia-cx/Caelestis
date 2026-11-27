import { PRESENCE_PROTOCOL_V1 } from '@caelestis/shared'
import { vi } from 'vitest'
import { importStateModules } from './state-modules.js'

export const SERVER_ID = '018f4f2a-1234-7abc-8def-0123456789ab'
/** The session the fake server gives this tab when the socket opens. */
export const SELF_SESSION = 'a'.repeat(16)

/** A presence socket a test drives: it opens when told to and receives server events. */
export class FakeWebSocket extends EventTarget {
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

  /** Open and say the session is ready; `canWrite` is what the server says about writing. */
  open(canWrite?: boolean): void {
    this.protocol = PRESENCE_PROTOCOL_V1
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
    this.receive({
      type: 'presence-ready',
      sessionId: SELF_SESSION,
      online: 1,
      peers: [],
      regions: [],
      ...(canWrite === undefined ? {} : { canWrite }),
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

/**
 * Install presence against one connected server under fake timers and open its socket. `capture`
 * makes the server an event server, `scope` signs this tab in with a token of that scope, and
 * `canWrite` is what the ready event says about writing. Call `dispose` after the test.
 */
export const connectPresence = async ({
  capture,
  scope,
  canWrite,
}: {
  readonly capture?: 1
  readonly scope?: 'event_runner' | 'admin'
  readonly canWrite?: boolean | undefined
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
      ...(capture === undefined ? {} : { capture }),
    },
    token: scope === undefined ? null : `${scope}-token`,
    status: 'connected' as const,
    // As a connection probe records it: either scope may run captures, and only admin is admin.
    isAdmin: scope === 'admin',
    ...(scope === undefined ? {} : { canRunCaptures: true as const }),
    season: 1,
  }
  state.upsertServer(server)
  presence.installPresence()
  const socket = FakeWebSocket.instances[0]
  if (socket === undefined) throw new Error('presence did not open a socket')
  socket.open(canWrite)
  await vi.advanceTimersByTimeAsync(0)
  return { presence, state, socket, dispose: () => state.removeServer(server.url) }
}
