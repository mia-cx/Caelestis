import { flushSync, mount, unmount } from 'svelte'
import { expect, it } from 'vitest'
import type { TemplateStudioIntent, TemplateStudioModel } from '../src/studio/model.js'
import ScopesWindow from '../src/studio/windows/ScopesWindow.svelte'

it('tells the studio while it is on screen, however the layout shows it', () => {
  const intents: TemplateStudioIntent[] = []
  // The window reads only the scopes part of the model.
  const model = {
    scopes: { stages: ['output'], samples: {}, pending: false },
  } as unknown as TemplateStudioModel
  const window = mount(ScopesWindow, {
    target: document.body,
    props: { model, onIntent: (intent) => intents.push(intent) },
  })
  flushSync()
  expect(intents).toEqual([{ type: 'scopes-shown', shown: true }])

  unmount(window)
  expect(intents.at(-1)).toEqual({ type: 'scopes-shown', shown: false })
})
