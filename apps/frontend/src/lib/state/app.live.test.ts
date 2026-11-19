// @vitest-environment happy-dom
import { LIVE_PROTOCOL_V2, millis } from '@caelestis/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appState, manifest, server, template } from '../../tests/fixtures'

/** The transport only: AppState's own event handling stays real. */
class FakeSocket extends EventTarget {
  static last: FakeSocket | null = null
  readonly protocol = LIVE_PROTOCOL_V2
  readyState = 1
  closedWith: number | null = null
  constructor() {
    super()
    FakeSocket.last = this
  }
  send(): void {}
  close(code = 1000): void {
    this.closedWith = code
    this.readyState = 3
  }
  receive(event: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
  }
}

const artwork = template()
const status = (correct: number) => ({
  templateId: artwork.id,
  correct,
  wrong: 0,
  blank: artwork.totalPixels - correct,
  total: artwork.totalPixels,
  observedAt: millis(1_800_000_000_000),
})

const connect = () => {
  const app = appState({
    server: { ...server, liveSync: 2 },
    manifest: manifest({ server: { ...server, liveSync: 2 } }),
    statuses: [status(1)],
    statusRevision: 4,
  })
  app.startLive()
  const socket = FakeSocket.last
  if (socket === null) throw new Error('no live socket opened')
  socket.dispatchEvent(new Event('open'))
  return { app, socket }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', Object.assign(FakeSocket, { CLOSING: 2 }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  FakeSocket.last = null
})

it('applies a status delta that matches the wire schema', () => {
  const { app, socket } = connect()
  socket.receive({
    type: 'status-delta',
    delta: { baseRevision: 4, revision: 5, templates: [status(3)], removedTemplateIds: [] },
  })
  expect(app.statuses.get(artwork.id)?.correct).toBe(3)
  expect(socket.closedWith).toBeNull()
})

it('closes the socket on a status delta the wire schema refuses', () => {
  const { app, socket } = connect()
  socket.receive({
    type: 'status-delta',
    delta: { baseRevision: 4, revision: 5, templates: [status(9)], removedTemplateIds: [] },
  })
  expect(socket.closedWith).toBe(1002)
  expect(app.statuses.get(artwork.id)?.correct).toBe(1)
})
