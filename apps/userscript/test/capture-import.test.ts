import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaimCaptureHost } from '../src/claim-editor.js'
import type { ConnectedServer } from '../src/state.js'
import type { ImportedTemplate } from '../src/templates/import.js'

const mocks = vi.hoisted(() => ({
  host: null as ClaimCaptureHost | null,
  stop: vi.fn(),
  importFile: vi.fn(),
  reserveMove: vi.fn(),
  addLocalTemplate: vi.fn(),
  removeLocalTemplate: vi.fn(),
  setTemplateFolder: vi.fn(),
}))

vi.mock('../src/claim-editor.js', () => ({
  startCaptureMode: (host: ClaimCaptureHost) => {
    mocks.host = host
    return true
  },
  stopClaimMode: mocks.stop,
}))
vi.mock('../src/templates/current-artwork.js', () => ({
  captureSelectedArtwork: async () => new Uint8Array([5]),
}))
vi.mock('../src/templates/import.js', () => ({ importFile: mocks.importFile }))
vi.mock('../src/templates/move.js', () => ({ reserveMove: mocks.reserveMove }))
vi.mock('../src/templates/local-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/templates/local-store.js')>()),
  addLocalTemplate: mocks.addLocalTemplate,
  removeLocalTemplate: mocks.removeLocalTemplate,
  setTemplateFolder: mocks.setTemplateFolder,
}))

import { captureTemplate } from '../src/application/tree-actions.js'

const selection = { rect: { x: 0, y: 0, w: 1, h: 1 }, mask: new Uint8Array([1]), count: 1 }
const imported: ImportedTemplate = {
  id: 'capture',
  name: 'Capture',
  source: 'image',
  originX: 0,
  originY: 0,
  width: 1,
  height: 1,
  indices: new Uint8Array([5]),
  moved: 0,
  opaque: 1,
}

describe('capture template import', () => {
  beforeEach(() => {
    mocks.host = null
    mocks.importFile.mockResolvedValue([imported])
    mocks.addLocalTemplate.mockResolvedValue(undefined)
    mocks.reserveMove.mockReturnValue({ start: vi.fn().mockReturnValue(true), release: vi.fn() })
  })

  const capture = async () => {
    captureTemplate({ key: 'local', name: 'Local', nodeId: null, server: null }, vi.fn())
    if (mocks.host === null) throw new Error('Capture did not start')
    return mocks.host.capture(selection, 'template')
  }

  it('keeps the selection when a placement is already busy', async () => {
    mocks.reserveMove.mockReturnValue(null)

    await expect(capture()).resolves.toMatch(/Try again/)
    expect(mocks.stop).not.toHaveBeenCalled()
    expect(mocks.addLocalTemplate).not.toHaveBeenCalled()
  })

  it('keeps the selection when import admission fails', async () => {
    mocks.addLocalTemplate.mockRejectedValue(new Error('storage unavailable'))

    await expect(capture()).resolves.toMatch(/Try again/)
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  it('keeps the selection when placement cannot start after admission', async () => {
    mocks.reserveMove.mockReturnValue({ start: vi.fn().mockReturnValue(false), release: vi.fn() })
    mocks.removeLocalTemplate.mockResolvedValue(true)

    await expect(capture()).resolves.toMatch(/Try again/)
    expect(mocks.removeLocalTemplate).toHaveBeenCalledWith('capture')
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  it('keeps the selection when the server refuses admission', async () => {
    captureTemplate(
      {
        key: 'server:test',
        name: 'Server',
        nodeId: null,
        server: { isAdmin: false, url: 'https://example.test' } as ConnectedServer,
      },
      vi.fn(),
    )
    if (mocks.host === null) throw new Error('Capture did not start')

    await expect(mocks.host.capture(selection, 'template')).resolves.toMatch(/Try again/)
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  it('releases the editor after placement starts', async () => {
    await expect(capture()).resolves.toBeNull()
    expect(mocks.reserveMove.mock.results[0]?.value.start).toHaveBeenCalledWith(
      'capture',
      expect.any(Function),
    )
    expect(mocks.stop).toHaveBeenCalledOnce()
  })
})
