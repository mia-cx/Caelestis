import { WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The confirmation dialog is the author's answer; each test gives it.
vi.mock('../src/ui/confirm.js', () => ({ confirmDestructive: vi.fn(async () => true) }))

import {
  closeTemplateStudio,
  handleTemplateStudioIntent,
  openTemplateStudio,
  templateStudioModel,
} from '../src/application/template-studio.js'
import type { ImportedTemplate } from '../src/templates/import.js'
import { processRecipe } from '../src/templates/import.js'
import { confirmDestructive } from '../src/ui/confirm.js'
import { celesteRoom } from './celeste.js'

/** Open the studio on the Celeste room and wait for its first result. */
const openOnRoom = async (target: Parameters<typeof openTemplateStudio>[0]) => {
  const { room, png } = await celesteRoom()
  expect(
    openTemplateStudio(target, { image: new Blob([png], { type: 'image/png' }), name: 'room.png' }),
  ).toBe(true)
  await vi.waitFor(() => expect(templateStudioModel().source).not.toBeNull())
  // Every Wplace colour and no dithering, so palette art keeps every pixel.
  handleTemplateStudioIntent({ type: 'scope', scope: 'all' })
  handleTemplateStudioIntent({ type: 'dither', dither: { strength: 0 } })
  await ready()
  return room
}

const ready = () =>
  vi.waitFor(() => expect(templateStudioModel().processing.state).toBe('ready'), {
    timeout: 5_000,
  })

const saved = (save: ReturnType<typeof vi.fn>): ImportedTemplate =>
  save.mock.calls.at(-1)?.[0] as ImportedTemplate

afterEach(() => closeTemplateStudio())

describe('template studio', () => {
  it('creates a template that matches palette art pixel for pixel, where the author placed it, and that its recipe rebuilds', async () => {
    const save = vi.fn(async () => true)
    const room = await openOnRoom({
      kind: 'create',
      destination: 'Local',
      surface: WORLD_TEMPLATE_SURFACE,
      save,
    })
    handleTemplateStudioIntent({ type: 'origin', x: 1_200, y: 3_400 })
    handleTemplateStudioIntent({ type: 'save' })
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())

    const template = saved(save)
    expect(template).toMatchObject({
      name: 'room',
      originX: 1_200,
      originY: 3_400,
      width: room.width,
      height: room.height,
      opaque: room.opaque,
    })
    expect(template.indices).toEqual(room.indices)
    const authoring = template.authoring
    if (authoring === undefined) throw new Error('the template has no authoring')
    const rebuilt = await processRecipe(authoring.source, authoring.recipe, template)
    expect(rebuilt.indices).toEqual(room.indices)
  })

  it('undoes and redoes edits, reprocessing the artwork each way', async () => {
    await openOnRoom({
      kind: 'create',
      destination: 'Local',
      surface: WORLD_TEMPLATE_SURFACE,
      save: async () => true,
    })
    const colours = () => templateStudioModel().processing
    const full = colours()
    handleTemplateStudioIntent({ type: 'scope', scope: 'free' })
    await ready()
    const free = colours()
    expect(free).not.toEqual(full)

    handleTemplateStudioIntent({ type: 'undo' })
    await ready()
    expect(templateStudioModel()).toMatchObject({
      palette: { scope: 'all' },
      processing: full,
      history: { undo: true, redo: true },
    })

    handleTemplateStudioIntent({ type: 'redo' })
    await ready()
    expect(templateStudioModel()).toMatchObject({ palette: { scope: 'free' }, processing: free })
  })

  it('replaces only after the author confirms, keeping the template’s size, place, and name', async () => {
    const save = vi.fn(async () => true)
    const { room } = await celesteRoom()
    await openOnRoom({
      kind: 'replace',
      name: 'Prologue',
      server: 'Test server',
      surface: WORLD_TEMPLATE_SURFACE,
      width: room.width,
      height: room.height,
      origin: { x: 500, y: 700 },
      save,
    })
    expect(templateStudioModel().output).toMatchObject({ locked: true })
    // A replacement keeps its size whatever the author asks for.
    handleTemplateStudioIntent({ type: 'scale', scale: 2 })
    await ready()

    vi.mocked(confirmDestructive).mockResolvedValueOnce(false)
    handleTemplateStudioIntent({ type: 'save' })
    await vi.waitFor(() => expect(confirmDestructive).toHaveBeenCalledOnce())
    // A declined save leaves the studio free to ask again; one that went ahead would still be saving.
    handleTemplateStudioIntent({ type: 'save' })
    await vi.waitFor(() => expect(confirmDestructive).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(saved(save)).toMatchObject({
      name: 'Prologue',
      originX: 500,
      originY: 700,
      width: room.width,
      height: room.height,
    })
  })
})
