import { TILE_SIZE } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaimCaptureHost } from '../src/claim-editor.js'
import { createLocalFolder } from '../src/local-folders.js'
import type { ConnectedServer } from '../src/state.js'
import * as store from '../src/templates/local-store.js'
import { abort, isMoving, movingId, reserveMove } from '../src/templates/move.js'
import { loadCommittedTilePixels, UNPAINTED } from '../src/tile-transform.js'
import type { TreeTarget } from '../src/ui/tree.js'

const editor = vi.hoisted(() => ({ host: null as ClaimCaptureHost | null }))

vi.mock('../src/claim-editor.js', () => ({
  startCaptureMode: (host: ClaimCaptureHost) => {
    editor.host = host
    return true
  },
}))
vi.mock('../src/main.js', () => ({ repaint: () => {} }))
vi.mock('../src/tile-transform.js', async (original) => ({
  ...(await original<typeof import('../src/tile-transform.js')>()),
  loadCommittedTilePixels: vi.fn(),
}))

import { captureTemplate } from '../src/application/tree-actions.js'

const selection = { rect: { x: 0, y: 0, w: 2, h: 1 }, mask: new Uint8Array([1, 1]), count: 2 }
const local: TreeTarget = { key: 'local', name: 'Local', nodeId: null, server: null }
const server: ConnectedServer = {
  url: 'https://example.test',
  isAdmin: true,
  token: 'admin',
  status: 'connected',
  info: null,
  season: 1,
}
const remote: TreeTarget = { key: 'server:test', name: 'Server', nodeId: null, server }

const capture = (signal = new AbortController().signal, target = local) => {
  captureTemplate(target, () => {})
  if (editor.host === null) throw new Error('Capture did not start')
  return editor.host.capture(selection, 'template', signal)
}

beforeEach(() => {
  editor.host = null
  const pixels = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(UNPAINTED)
  pixels[0] = 5
  pixels[1] = 9
  vi.mocked(loadCommittedTilePixels).mockResolvedValue(pixels)
})

afterEach(async () => {
  await abort()
  for (const template of store.localTemplates()) await store.removeLocalTemplate(template.id)
})

describe('capture template import', () => {
  it('places exact captured indices into the chosen Local folder without image decoding', async () => {
    const folder = createLocalFolder(null, 'Captures')
    if (folder === null) throw new Error('Folder could not be created')
    const target = { ...local, key: `lf:${folder.id}`, nodeId: folder.id }

    await expect(capture(undefined, target)).resolves.toBeNull()

    expect(store.localTemplates()).toHaveLength(1)
    const template = store.localTemplates()[0]
    expect(template).toMatchObject({
      folderId: folder.id,
      originX: 0,
      originY: 0,
      width: 2,
      height: 1,
      indices: new Uint8Array([5, 9]),
      opaque: 2,
      moved: 0,
      everPlaced: false,
    })
    expect(movingId()).toBe(template?.id)
  })

  it('refuses a busy placement before admitting a capture', async () => {
    const reservation = reserveMove()
    if (reservation === null) throw new Error('Move slot was already occupied')
    try {
      await expect(capture()).resolves.toMatch(/current placement/)
      expect(store.localTemplates()).toHaveLength(0)
    } finally {
      reservation.release()
    }
  })

  it('reports an admission failure without opening placement', async () => {
    vi.spyOn(store, 'addLocalTemplate').mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(capture()).resolves.toMatch(/Try again/)
    expect(store.localTemplates()).toHaveLength(0)
    expect(isMoving()).toBe(false)
  })

  it('refuses a server without admin access', async () => {
    await expect(
      capture(undefined, { ...remote, server: { ...server, isAdmin: false } }),
    ).resolves.toMatch(/Try again/)
    expect(store.localTemplates()).toHaveLength(0)
    expect(isMoving()).toBe(false)
  })

  it('discards a capture cancelled while committed tiles are loading', async () => {
    const controller = new AbortController()
    let finishTile!: (pixels: Uint8Array) => void
    const tile = new Promise<Uint8Array>((resolve) => {
      finishTile = resolve
    })
    vi.mocked(loadCommittedTilePixels).mockReturnValueOnce(tile)
    const operation = capture(controller.signal)
    const outcome = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    finishTile(new Uint8Array(TILE_SIZE * TILE_SIZE).fill(5))

    await outcome
    expect(store.localTemplates()).toHaveLength(0)
    expect(isMoving()).toBe(false)
  })

  it.each([local, remote])(
    'removes a cancelled admission into $name before placement starts',
    async (target) => {
      const controller = new AbortController()
      const add = store.addLocalTemplate
      vi.spyOn(store, 'addLocalTemplate').mockImplementationOnce(async (...args) => {
        const admitted = await add(...args)
        controller.abort()
        return admitted
      })

      await expect(capture(controller.signal, target)).rejects.toMatchObject({ name: 'AbortError' })
      expect(store.localTemplates()).toHaveLength(0)
      expect(isMoving()).toBe(false)
    },
  )
})
