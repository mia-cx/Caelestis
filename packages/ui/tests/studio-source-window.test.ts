import { flushSync, mount, unmount } from 'svelte'
import { expect, it } from 'vitest'
import type { TemplateStudioModel } from '../src/studio/model.js'
import SourceWindow from '../src/studio/windows/SourceWindow.svelte'

it('keeps the page when something other than an image is dropped on it', () => {
  // With no image yet, the window reads only these parts of the model.
  const model = {
    source: null,
    loadingSource: false,
    pending: false,
    crop: { x: 0, y: 0, width: 1, height: 1 },
  } as unknown as TemplateStudioModel
  const window = mount(SourceWindow, {
    target: document.body,
    props: { model, onIntent: () => {} },
  })
  flushSync()

  const drop = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', {
    value: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
  })
  document.querySelector('.drop')?.dispatchEvent(drop)
  // The browser would otherwise open the file in place of Wplace.
  expect(drop.defaultPrevented).toBe(true)
  unmount(window)
})
