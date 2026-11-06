import { flushSync, mount, unmount } from 'svelte'
import { expect, it } from 'vitest'
import type { TemplateStudioIntent, TemplateStudioModel } from '../src/studio/model.js'
import DimensionsWindow from '../src/studio/windows/DimensionsWindow.svelte'

it('scales by exactly the percentage typed, fractions included', () => {
  // The Size window reads only these parts of the model.
  const model = {
    source: { name: 'art.png', width: 1000, height: 1000, url: '' },
    pending: false,
    output: {
      width: 1000,
      height: 1000,
      scale: 1,
      keepProportions: true,
      resize: 'area',
      anchor: 'center',
      locked: false,
    },
    origin: { x: 0, y: 0 },
  } as unknown as TemplateStudioModel
  const intents: TemplateStudioIntent[] = []
  const window = mount(DimensionsWindow, {
    target: document.body,
    props: { model, onIntent: (intent) => intents.push(intent) },
  })
  flushSync()

  const field = document.querySelector<HTMLInputElement>('.range input[type="number"]')
  if (field === null) throw new Error('no scale field')
  field.value = '12.5'
  field.dispatchEvent(new Event('change', { bubbles: true }))
  expect(intents.at(-1)).toEqual({ type: 'scale', scale: 0.125 })
  unmount(window)
})
