import { TERRITORY_EVENT } from '@caelestis/shared'
import { afterEach, expect, it, vi } from 'vitest'
import { connectPresence, FakeWebSocket } from './presence-socket.js'

vi.mock('../src/wplace-account.js', () => ({
  accountIdentity: () => ({ wplaceUserId: 42, displayName: 'Mia' }),
  loadAccount: async () => undefined,
}))
vi.mock('../src/event-team.js', () => ({
  eventTeam: () => 0,
  readEventTeam: async () => 0,
  installEventTeam: () => {},
}))
vi.mock('../src/capture-planning.js', () => ({ planProposals: async () => [] }))

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.useRealTimers()
  vi.resetModules()
  FakeWebSocket.instances = []
  document.body.replaceChildren()
})

/** An event server's lobby list reaching a painter whose Caelestis never captured the map. */
const loadWithoutMap = async () => {
  ;(await import('../src/settings.js')).loadState()
  const connected = await connectPresence({ capture: 1, scope: 'report', canWrite: true })
  dispose = connected.dispose
  vi.setSystemTime(TERRITORY_EVENT.startsAt + 3_600_000)
  ;(await import('../src/capture-runs.js')).installCaptureRuns()
  connected.socket.receive({ type: 'capture-runs', runs: [] })
  return document.getElementById('caelestis-capture-run')
}

it('shows the capture card when Caelestis started after Wplace built its map', async () => {
  // A userscript manager that injects late: Wplace's map canvas is already on the page.
  const canvas = document.createElement('canvas')
  canvas.className = 'maplibregl-canvas'
  document.body.append(canvas)

  expect(await loadWithoutMap()).not.toBeNull()
})

it('keeps the card hidden while Wplace has not built its map yet', async () => {
  expect(await loadWithoutMap()).toBeNull()
})
