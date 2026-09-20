// @vitest-environment happy-dom
import type { ServerDetailsIntent, ServerDetailsModel } from '@caelestis/ui/elements'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ConnectedServer } from '../state.js'

const SERVER_ID = '019fed50-87a1-7523-a88c-bdeafad49681'
const asset = { etag: 'a'.repeat(64), contentType: 'image/png' as const }

const servers = vi.hoisted(() => ({ list: [] as ConnectedServer[] }))

vi.mock('@caelestis/ui/elements', () => ({ SERVER_DETAILS_TAG: 'caelestis-server-details' }))
vi.mock('../state.js', () => ({
  getState: () => ({ servers: servers.list }),
  isCurrentServerConnection: () => true,
  serverEndpoint: (url: string, route: string) => `${url}/backend/v1${route}`,
  updateServerDetails: vi.fn(async () => ({ ok: true })),
  uploadServerAsset: vi.fn(async () => ({ ok: true })),
  deleteServerAsset: vi.fn(async () => ({ ok: true })),
}))
vi.mock('./theme.js', () => ({ applyWplaceTheme: vi.fn() }))

import { deleteServerAsset, updateServerDetails, uploadServerAsset } from '../state.js'
import { openServerDetails } from './server-details.js'

const server = (info: ConnectedServer['info']): ConnectedServer => ({
  url: 'https://example.com',
  info,
  token: 'admin',
  status: 'connected',
  isAdmin: true,
  season: 0,
})

const editor = () =>
  document.querySelector('caelestis-server-details') as HTMLElement & {
    model: ServerDetailsModel
  }

const intend = (detail: ServerDetailsIntent): void => {
  editor().dispatchEvent(new CustomEvent('caelestis-server-details-intent', { detail }))
}

beforeEach(() => {
  vi.clearAllMocks()
  servers.list = []
  document.body.innerHTML = ''
})

it('seeds the form from public server info and patches only what changed', async () => {
  const connected = server({
    id: SERVER_ID,
    name: 'Allies',
    auth: 'none',
    description: 'Old',
    logoImage: asset,
  })
  servers.list = [connected]
  const rerender = vi.fn()
  openServerDetails(connected, rerender)
  expect(editor().model).toMatchObject({
    owner: 'Allies · Server',
    name: 'Allies',
    description: 'Old',
    discordInviteUrl: '',
    logoImageUrl: `https://example.com/backend/v1/server/assets/logo?v=${asset.etag}`,
    previewImageUrl: null,
    busy: false,
  })

  intend({
    type: 'save',
    fields: {
      name: 'Allies',
      description: 'Old',
      discordInviteUrl: '',
      homeCopy: '',
      logoText: '',
    },
  })
  expect(editor().model.notice).toBe('Nothing changed.')
  expect(updateServerDetails).not.toHaveBeenCalled()

  // A refresh that lands while the dialog is open must not turn untouched fields into edits.
  servers.list = [
    server({
      id: SERVER_ID,
      name: 'Allies renamed',
      auth: 'none',
      description: 'Old',
      logoImage: asset,
    }),
  ]
  intend({
    type: 'save',
    fields: {
      name: 'Allies',
      description: 'New',
      discordInviteUrl: '',
      homeCopy: '',
      logoText: '',
    },
  })
  await vi.waitFor(() => expect(updateServerDetails).toHaveBeenCalledTimes(1))
  expect(updateServerDetails).toHaveBeenLastCalledWith(expect.anything(), { description: 'New' })
  await vi.waitFor(() => expect(document.querySelector('caelestis-server-details')).toBeNull())
  servers.list = [connected]
  openServerDetails(connected, rerender)

  // A refused save keeps the dialog open with the reason.
  vi.mocked(updateServerDetails).mockResolvedValueOnce({ ok: false, message: 'name is taken' })
  const fields = {
    name: 'Allies',
    description: '',
    discordInviteUrl: 'https://discord.gg/abc',
    homeCopy: '',
    logoText: '',
  }
  intend({ type: 'save', fields })
  await vi.waitFor(() => expect(editor().model.error).toBe('name is taken'))
  expect(editor().model.busy).toBe(false)

  // A saved edit closes it.
  intend({ type: 'save', fields })
  await vi.waitFor(() => expect(document.querySelector('caelestis-server-details')).toBeNull())
  expect(updateServerDetails).toHaveBeenLastCalledWith(connected, {
    description: null,
    discordInviteUrl: 'https://discord.gg/abc',
  })
  expect(rerender).toHaveBeenCalled()
})

it('uploads and clears assets, and shows a server refusal', async () => {
  const connected = server({ id: SERVER_ID, name: 'Allies', auth: 'none' })
  servers.list = [connected]
  openServerDetails(connected, vi.fn())
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', {
    type: 'image/png',
  })
  intend({ type: 'upload', kind: 'logo', file })
  await vi.waitFor(() => expect(editor().model.notice).toBe('Logo uploaded.'))
  expect(uploadServerAsset).toHaveBeenCalledWith(
    connected,
    'logo',
    new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    'image/png',
  )

  vi.mocked(deleteServerAsset).mockResolvedValueOnce({
    ok: false,
    message: 'admin access required',
  })
  intend({ type: 'clear-asset', kind: 'preview' })
  await vi.waitFor(() => expect(editor().model.error).toBe('admin access required'))
  expect(editor().model.busy).toBe(false)

  intend({ type: 'close' })
  expect(document.querySelector('caelestis-server-details')).toBeNull()
})
