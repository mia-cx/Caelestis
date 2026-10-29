import { WORLD_PIXELS, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import {
  type EffectLayer,
  TEMPLATE_STUDIO_TAG,
  type TemplateStudioModel,
} from '@caelestis/ui/elements'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// The confirmation dialog is the author's answer; each test gives it.
vi.mock('../src/ui/confirm.js', () => ({ confirmDestructive: vi.fn(async () => true) }))

// Wplace's account, which a test can hold back to load after the studio opens.
const account = vi.hoisted(() => ({
  owned: null as ReadonlySet<number> | null,
  load: Promise.resolve(),
}))
vi.mock('../src/wplace-account.js', async (original) => ({
  ...(await original<typeof import('../src/wplace-account.js')>()),
  ownedColours: () => account.owned,
  loadAccount: () => account.load,
}))

import {
  closeTemplateStudio,
  handleTemplateStudioIntent,
  openTemplateStudio,
  templateStudioModel,
} from '../src/application/template-studio.js'
import { setState } from '../src/state.js'
import type { ImportedTemplate } from '../src/templates/import.js'
import { processRecipe } from '../src/templates/import.js'
import { confirmDestructive } from '../src/ui/confirm.js'
import { celesteRoom, firstDifference, warmUp } from './celeste.js'

/** Open the studio on the Celeste room and wait for its first result. */
const openOnRoom = async (target: Parameters<typeof openTemplateStudio>[0]) => {
  const { room, png } = await celesteRoom()
  expect(openTemplateStudio(target)).toBe(true)
  // Every Wplace colour and no dithering, so palette art keeps every pixel.
  handleTemplateStudioIntent({ type: 'scope', scope: 'all' })
  handleTemplateStudioIntent({ type: 'dither', dither: { strength: 0 } })
  handleTemplateStudioIntent({
    type: 'file',
    file: new File([png], 'room.png', { type: 'image/png' }),
  })
  await ready()
  return room
}

const ready = () =>
  vi.waitFor(() => expect(templateStudioModel().processing.state).toBe('ready'), {
    timeout: 5_000,
  })

const saved = (save: ReturnType<typeof vi.fn>): ImportedTemplate =>
  save.mock.calls.at(-1)?.[0] as ImportedTemplate

afterEach(() => {
  closeTemplateStudio()
  setState({ studioLayout: {} })
  account.owned = null
  account.load = Promise.resolve()
})

describe('template studio', () => {
  beforeAll(warmUp)

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
    expect(firstDifference(template.indices, room.indices)).toBe(-1)
    const authoring = template.authoring
    if (authoring === undefined) throw new Error('the template has no authoring')
    const rebuilt = await processRecipe(authoring.source, authoring.recipe, template)
    expect(firstDifference(rebuilt.indices, room.indices)).toBe(-1)
  })

  it('offers Owned once the account loads, even when it owns no premium colours', async () => {
    let loaded = (): void => {}
    account.load = new Promise((resolve) => {
      loaded = resolve
    })
    openTemplateStudio({
      kind: 'create',
      destination: 'Local',
      surface: WORLD_TEMPLATE_SURFACE,
      save: async () => true,
    })
    const shown = () =>
      (document.querySelector(TEMPLATE_STUDIO_TAG) as HTMLElement & { model: TemplateStudioModel })
        .model.palette.ownedKnown
    expect(shown()).toBe(false)

    account.owned = new Set()
    loaded()
    await vi.waitFor(() => expect(shown()).toBe(true))
  })

  it('analyses a palette fit again when its look changes during the analysis', async () => {
    await openOnRoom({
      kind: 'create',
      destination: 'Local',
      surface: WORLD_TEMPLATE_SURFACE,
      save: async () => true,
    })
    const fit = (look: 'fitted' | 'vivid'): EffectLayer => ({
      id: 'fit',
      name: 'Palette fit',
      step: {
        effect: 'palette-fit',
        enabled: true,
        look,
        space: 'oklab',
        strength: 1,
        curves: null,
      },
    })
    const analysed = async () => {
      await vi.waitFor(() => expect(templateStudioModel().analysingFit).toBeNull())
      const step = templateStudioModel().effects[0]?.step
      return step?.effect === 'palette-fit' ? step : undefined
    }
    handleTemplateStudioIntent({ type: 'effects', effects: [fit('vivid')] })
    handleTemplateStudioIntent({ type: 'analyse-fit', layer: 'fit' })
    const vivid = (await analysed())?.curves
    expect(vivid).not.toBeNull()

    handleTemplateStudioIntent({ type: 'effects', effects: [fit('fitted')] })
    handleTemplateStudioIntent({ type: 'analyse-fit', layer: 'fit' })
    handleTemplateStudioIntent({ type: 'effects', effects: [fit('vivid')] })
    expect(await analysed()).toMatchObject({ look: 'vivid', curves: vivid })
  })

  it('keeps the scopes marked stale until the new result is sampled', async () => {
    await openOnRoom({
      kind: 'create',
      destination: 'Local',
      surface: WORLD_TEMPLATE_SURFACE,
      save: async () => true,
    })
    const scopes = () => templateStudioModel().scopes
    handleTemplateStudioIntent({
      type: 'layout',
      layout: { scopes: { open: true, collapsed: false, dock: 'end', order: 0 } },
    })
    await vi.waitFor(() => expect(scopes()).toMatchObject({ pending: false }))

    handleTemplateStudioIntent({ type: 'color-space', colorSpace: 'srgb' })
    // A stage change samples the previous result while the new one processes.
    handleTemplateStudioIntent({ type: 'scope-stages', stages: ['output'] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(templateStudioModel().processing.state).toBe('working')
    expect(scopes().pending).toBe(true)

    await ready()
    await vi.waitFor(() => expect(scopes().pending).toBe(false))
  })

  it('undoes an enlargement against the canvas edge without drawing the larger artwork', async () => {
    const room = await openOnRoom({
      kind: 'create',
      destination: 'Local',
      surface: WORLD_TEMPLATE_SURFACE,
      save: async () => true,
    })
    const edge = WORLD_PIXELS - room.width
    handleTemplateStudioIntent({ type: 'origin', x: edge, y: 100 })
    handleTemplateStudioIntent({ type: 'scale', scale: 2 })
    await ready()
    expect(templateStudioModel().origin.x).toBe(WORLD_PIXELS - room.width * 2)

    handleTemplateStudioIntent({ type: 'undo' })
    await ready()
    expect(templateStudioModel()).toMatchObject({
      origin: { x: edge, y: 100 },
      output: { width: room.width, height: room.height },
    })
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
      // Settings chosen before the image loaded belong to no image, so they are not undoable.
      history: { undo: false, redo: true },
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
