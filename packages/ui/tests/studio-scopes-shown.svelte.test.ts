import { flushSync, mount, unmount } from 'svelte'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  StudioLayout,
  StudioNode,
  StudioWindowId,
  TemplateStudioIntent,
  TemplateStudioModel,
} from '../src/studio/model.js'
import TemplateStudio from '../src/studio/TemplateStudio.svelte'

const tabs = (active: StudioWindowId, collapsed = false): StudioNode => ({
  kind: 'tabs',
  panels: ['effects', 'scopes'],
  active,
  collapsed,
})
const layoutWith = (root: StudioNode): StudioLayout => ({
  frames: [{ place: { edge: 'end', x: 56, y: 72 }, root }],
})

const studioModel = (layout: StudioLayout): TemplateStudioModel => ({
  target: { kind: 'create', destination: '' },
  name: '',
  source: null,
  loadingSource: false,
  crop: { x: 0, y: 0, width: 0, height: 0 },
  cropping: null,
  output: {
    width: 0,
    height: 0,
    scale: 1,
    keepProportions: true,
    stretched: false,
    resize: 'area',
    anchor: 'center',
    locked: false,
  },
  origin: { x: 0, y: 0 },
  palette: { scope: 'all', ownedKnown: false, colours: [] },
  alpha: { mode: 'preserve', threshold: 128, matte: 0 },
  colorSpace: 'oklab',
  dither: {
    algorithm: 'none',
    strength: 0,
    placement: 'everywhere',
    placementSampleSize: 8,
    placementContrastThreshold: 10,
    serpentine: false,
    seed: 0,
    useColorSpace: false,
  },
  effects: [],
  analysingFit: null,
  scopes: { stages: ['output'], samples: {}, pending: false },
  engine: null,
  processing: { state: 'idle' },
  history: { undo: false, redo: false },
  pending: false,
  layout,
})

/** Mounts the studio and records the scopes-shown intents it sends. */
const mountStudio = (layout: StudioLayout) => {
  const shown: boolean[] = []
  const props = $state({
    model: studioModel(layout),
    onIntent: (intent: TemplateStudioIntent) => {
      if (intent.type === 'scopes-shown') shown.push(intent.shown)
    },
  })
  const studio = mount(TemplateStudio, { target: document.body, props })
  flushSync()
  return { shown, props, studio }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it('samples only while Scopes is the front panel of an open window', () => {
  const { shown, props, studio } = mountStudio(layoutWith(tabs('effects')))
  expect(shown).toEqual([])

  props.model = studioModel(layoutWith(tabs('scopes')))
  flushSync()
  expect(shown).toEqual([true])

  props.model = studioModel(layoutWith(tabs('scopes', true)))
  flushSync()
  expect(shown).toEqual([true, false])

  props.model = studioModel(layoutWith(tabs('scopes')))
  flushSync()
  unmount(studio)
  expect(shown).toEqual([true, false, true, false])
})

it('samples while the phone sheet shows Scopes', () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width'),
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  const { shown } = mountStudio(layoutWith(tabs('effects')))
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (button) => button.textContent === 'Scopes',
  )
  if (tab === undefined) throw new Error('no Scopes tab')

  tab.click()
  flushSync()
  expect(shown).toEqual([true])

  tab.click()
  flushSync()
  expect(shown).toEqual([true, false])
})
