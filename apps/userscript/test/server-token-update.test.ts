import { afterEach, expect, it, vi } from 'vitest'
import {
  adminToken,
  backendFetch,
  createTestBackend,
  eventRunnerInvite,
  readToken,
} from './backend.js'

const origin = 'https://token-update.test'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('stores the token an event-runner invite trades for and never puts it in the panel', async () => {
  const { app } = await createTestBackend({ withRunnerInvite: true })
  const fetch = backendFetch(app, origin)
  vi.stubGlobal('fetch', fetch)
  window.fetch = fetch
  vi.resetModules()
  const { connectServer } = await import('../src/server-connections.js')
  const { getState } = await import('../src/settings.js')
  const settings = await import('../src/ui/settings-controller.js')
  await connectServer(origin, readToken)
  const invite = eventRunnerInvite

  settings.handleSettingsIntent({ type: 'update-server-token', url: origin, token: invite })

  await vi.waitFor(() =>
    expect(getState().servers[0]).toMatchObject({ status: 'connected', isAdmin: false }),
  )
  await vi.waitFor(() => expect(getState().servers[0]?.token).not.toBe(readToken))
  const kept = getState().servers[0]?.token ?? ''
  expect([readToken, invite, '']).not.toContain(kept)
  const panel = JSON.stringify(settings.settingsModel())
  expect(panel).not.toContain(kept)
  expect(panel).not.toContain(invite)
})

it('tells the row a token update is busy instead of leaving it checking', async () => {
  const { app } = await createTestBackend()
  const fetch = backendFetch(app, origin)
  vi.stubGlobal('fetch', fetch)
  window.fetch = fetch
  vi.resetModules()
  const { connectServer } = await import('../src/server-connections.js')
  const settings = await import('../src/ui/settings-controller.js')
  await connectServer(origin, readToken)

  // An invite for the same server is still connecting when the row's token is submitted.
  const invite = connectServer(origin, adminToken)
  settings.handleSettingsIntent({ type: 'update-server-token', url: origin, token: adminToken })
  await invite

  await vi.waitFor(() => expect(settings.settingsModel().servers[0]?.pending).toBeUndefined())
  expect(settings.settingsModel().servers[0]?.message).toBe(
    'Still connecting. Try again in a moment.',
  )
})
