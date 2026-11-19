import { TILE_SIZE } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaimCaptureHost } from '../src/claim-editor.js'
import { createLocalFolder } from '../src/local-folders.js'
import { UNPAINTED } from '../src/native-pixels.js'
import { type ServerConnection, setScopeVisible } from '../src/settings.js'
import * as catalog from '../src/templates/catalog.js'
import type { ImportedTemplate } from '../src/templates/import.js'
import { abort, commit, isMoving, movingId, reserveMove } from '../src/templates/move.js'
import * as residency from '../src/templates/residency.js'
import * as edits from '../src/templates/template-edits.js'
import { loadCommittedTilePixels } from '../src/tile-pixels.js'
import type { TreeTarget } from '../src/ui/tree-context.js'

const editor = vi.hoisted(() => ({ host: null as ClaimCaptureHost | null }))

vi.mock('../src/claim-editor.js', () => ({
  startCaptureMode: (host: ClaimCaptureHost) => {
    editor.host = host
    return true
  },
}))
vi.mock('../src/map-view.js', () => ({ repaint: () => {} }))
vi.mock('../src/tile-pixels.js', async (original) => ({
  ...(await original<typeof import('../src/tile-pixels.js')>()),
  loadCommittedTilePixels: vi.fn(),
}))

import { importTemplatesToServer } from '../src/application/import-to-server.js'
import { captureTemplate } from '../src/application/tree-import.js'

const selection = { rect: { x: 0, y: 0, w: 2, h: 1 }, mask: new Uint8Array([1, 1]), count: 2 }
const local: TreeTarget = { key: 'local', name: 'Local', nodeId: null, server: null }
const server: ServerConnection = {
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
  for (const template of catalog.localTemplates()) await edits.removeLocalTemplate(template.id)
})

describe('capture template import', () => {
  it('places exact captured indices into the chosen Local folder without image decoding', async () => {
    const folder = createLocalFolder(null, 'Captures')
    if (folder === null) throw new Error('Folder could not be created')
    const target = { ...local, key: `lf:${folder.id}`, nodeId: folder.id }

    await expect(capture(undefined, target)).resolves.toBeNull()

    expect(catalog.localTemplates()).toHaveLength(1)
    const template = catalog.localTemplates()[0]
    expect(template).toMatchObject({
      folderId: folder.id,
      originX: 0,
      originY: 0,
      width: 2,
      height: 1,
      opaque: 2,
      moved: 0,
      everPlaced: false,
    })
    if (template === undefined) throw new Error('the capture was not placed')
    expect(await residency.templatePixels(template)).toEqual(new Uint8Array([5, 9]))
    expect(movingId()).toBe(template?.id)
  })

  it('draws a capture placed into a server while Local is switched off', async () => {
    setScopeVisible('local', false)
    try {
      await expect(capture(undefined, remote)).resolves.toBeNull()
      const placing = catalog.templateById(movingId() ?? '')
      if (placing === undefined) throw new Error('the capture was not placed')
      expect(catalog.isTemplateVisible(placing)).toBe(true)
    } finally {
      setScopeVisible('local', true)
    }
  })

  it('keeps a server capture that did not upload in Local, where the sidebar lists it', async () => {
    // The test server is not a current connection, so Apply's upload is refused.
    await expect(capture(undefined, remote)).resolves.toBeNull()
    const id = movingId() ?? ''
    expect(catalog.templateById(id)?.staged).toBe(true)

    await commit()

    await vi.waitFor(() => expect(catalog.templateById(id)?.staged).toBeUndefined())
    expect(catalog.templateById(id)).toMatchObject({ everPlaced: true })
  })

  it('refuses a busy placement before admitting a capture', async () => {
    const reservation = reserveMove()
    if (reservation === null) throw new Error('Move slot was already occupied')
    try {
      await expect(capture()).resolves.toMatch(/current placement/)
      expect(catalog.localTemplates()).toHaveLength(0)
    } finally {
      reservation.release()
    }
  })

  it('reports an admission failure without opening placement', async () => {
    vi.spyOn(edits, 'addLocalTemplate').mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(capture()).resolves.toMatch(/Try again/)
    expect(catalog.localTemplates()).toHaveLength(0)
    expect(isMoving()).toBe(false)
  })

  it('refuses a server without admin access', async () => {
    await expect(
      capture(undefined, { ...remote, server: { ...server, isAdmin: false } }),
    ).resolves.toMatch(/Try again/)
    expect(catalog.localTemplates()).toHaveLength(0)
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
    expect(catalog.localTemplates()).toHaveLength(0)
    expect(isMoving()).toBe(false)
  })

  it.each([local, remote])(
    'removes a cancelled admission into $name before placement starts',
    async (target) => {
      const controller = new AbortController()
      const add = edits.addLocalTemplate
      vi.spyOn(edits, 'addLocalTemplate').mockImplementationOnce(async (...args) => {
        const admitted = await add(...args)
        controller.abort()
        return admitted
      })

      await expect(capture(controller.signal, target)).rejects.toMatchObject({ name: 'AbortError' })
      expect(catalog.localTemplates()).toHaveLength(0)
      expect(isMoving()).toBe(false)
    },
  )
})

describe('server file import', () => {
  const marble = (id: string, originX: number): ImportedTemplate => ({
    id,
    name: id,
    source: 'marble',
    originX,
    originY: 0,
    width: 2,
    height: 1,
    indices: new Uint8Array([5, 9]),
    moved: 0,
    opaque: 2,
  })
  const importBoth = () =>
    importTemplatesToServer([marble('first', 0), marble('second', 4)], server, null, {
      reservation: null,
      rerender: () => {},
    })

  it('keeps a template admitted after the first was refused in Local', async () => {
    vi.spyOn(edits, 'addLocalTemplate').mockRejectedValueOnce(new Error('pixel budget'))

    await expect(importBoth()).resolves.toMatchObject({ started: false })
    expect(catalog.templateById('second')).toBeDefined()
    expect(catalog.templateById('second')?.staged).toBeUndefined()
  })

  it('keeps the templates in Local when preparing an upload throws', async () => {
    vi.spyOn(residency, 'templateAsPng').mockRejectedValueOnce(new Error('pixels unavailable'))

    const result = await importBoth()
    if (!result.started) throw new Error('The import did not start')
    await expect(result.upload).rejects.toThrow('pixels unavailable')
    expect(catalog.localTemplates().filter((template) => template.staged)).toEqual([])
    expect(catalog.localTemplates()).toHaveLength(2)
  })
})
