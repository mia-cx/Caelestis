import { flushSync, mount, unmount } from 'svelte'
import { expect, it } from 'vitest'
import type { TemplateStudioIntent } from '../src/studio/model.js'
import DimensionsWindow from '../src/studio/windows/DimensionsWindow.svelte'
import { studioModel } from './studio-model.js'

it('scales by exactly the percentage typed, fractions included', () => {
  const base = studioModel()
  const model = studioModel({
    source: { name: 'art.png', width: 1000, height: 1000 },
    output: { ...base.output, width: 1000, height: 1000 },
  })
  const intents: TemplateStudioIntent[] = []
  const window = mount(DimensionsWindow, {
    target: document.body,
    props: { model, onIntent: (intent) => intents.push(intent) },
  })
  flushSync()

  const label = [...document.querySelectorAll('label')].find(
    (candidate) => candidate.textContent === 'Scale',
  )
  const field = document.getElementById(label?.htmlFor ?? '') as HTMLInputElement | null
  if (field === null) throw new Error('no Scale field')
  field.value = '12.5'
  field.dispatchEvent(new Event('change', { bubbles: true }))
  expect(intents.at(-1)).toEqual({ type: 'scale', scale: 0.125 })
  unmount(window)
})
