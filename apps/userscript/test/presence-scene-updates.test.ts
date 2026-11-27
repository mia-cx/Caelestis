import type { PresenceRect } from '@caelestis/shared'
import { afterEach, expect, it, vi } from 'vitest'
import { connectPresence, FakeWebSocket, SELF_SESSION } from './presence-socket.js'

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

const connect = async (capture?: 1) => {
  const connected = await connectPresence(capture === undefined ? {} : { capture })
  dispose = connected.dispose
  return connected
}

const rect = (x: number): PresenceRect => ({ x, y: 10, w: 4, h: 3 })

it('redraws peers from every presence message and reuses the scene between them', async () => {
  const { socket } = await connect()
  const { presenceScene } = await import('../src/presence-scene.js')
  const move = (x: number) =>
    socket.receive({
      type: 'presence-delta',
      online: 2,
      upsert: [{ sessionId: 'b'.repeat(16), painter: other, viewport: rect(x), draft: null }],
      remove: [],
    })
  move(0)
  const first = presenceScene()
  expect(first.map((item) => item.rect)).toEqual([rect(0)])
  // Frames between messages get the same scene, so its masks and items are not rebuilt.
  expect(presenceScene()).toBe(first)
  move(20)
  expect(presenceScene().map((item) => item.rect)).toEqual([rect(20)])
})

it('redraws capture lines from every run update and reuses them between updates', async () => {
  const { socket } = await connect(1)
  const { captureItems } = await import('../src/capture-runs.js')
  const run = (drafted: number) =>
    socket.receive({
      type: 'capture',
      run: {
        id: 'run',
        team: 0,
        painters: 2,
        guards: 0,
        startsAt: null,
        staggerMs: 500,
        members: [
          { sessionId: SELF_SESSION, painter, drafted: 0 },
          { sessionId: 'c'.repeat(16), painter: other, drafted },
        ],
        lines: [
          [10, 10, 11, 10],
          [10, 12, 11, 12],
        ],
      },
    })
  run(0)
  const gathering = captureItems()
  // The other painter's line is outlined until drafted; this painter's own is still to draft.
  expect(gathering.map((item) => item.kind)).toEqual(['pending', 'todo'])
  expect(captureItems()).toBe(gathering)
  run(2)
  expect(captureItems().map((item) => item.kind)).toEqual(['ready', 'todo'])
})
