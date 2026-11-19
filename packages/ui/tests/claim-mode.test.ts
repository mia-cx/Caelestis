import { mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import ClaimMode from '../src/claim/ClaimMode.svelte'
import type { ClaimModeIntent, ClaimModeModel } from '../src/claim/model.js'

const mounted: object[] = []
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((component) => unmount(component)))
  document.body.replaceChildren()
})
describe('claim mode intent boundary', () => {
  it('opens a tool flyout, selects the requested tool, and blocks pending actions', async () => {
    const intents: ClaimModeIntent[] = []
    const model = {
      purpose: 'claim',
      tool: 'rectangle',
      tools: [
        { tool: 'rectangle', group: 'shape', label: 'Rectangle', key: 'R', icon: 'toolRectangle' },
        { tool: 'ellipse', group: 'shape', label: 'Ellipse', key: 'E', icon: 'toolEllipse' },
      ],
      subtract: false,
      items: 0,
      pixels: 0,
      template: null,
      selected: false,
      selectedCount: 0,
      dirty: false,
      pending: false,
      options: { minCorners: 3, maxCorners: 12, maxWidth: 200 },
      groups: [
        {
          id: 'shape',
          label: 'Shapes',
          shown: 'rectangle',
          tools: [
            {
              tool: 'rectangle',
              group: 'shape',
              label: 'Rectangle',
              key: 'R',
              icon: 'toolRectangle',
            },
            { tool: 'ellipse', group: 'shape', label: 'Ellipse', key: 'E', icon: 'toolEllipse' },
          ],
        },
      ],
    } satisfies ClaimModeModel
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(ClaimMode, {
        target,
        props: { model, onIntent: (intent: ClaimModeIntent) => intents.push(intent) },
      }),
    )
    const tool = target.querySelector('button[aria-label="Rectangle"]') as HTMLButtonElement
    tool.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await tick()
    ;(target.querySelector('[data-tool="ellipse"]') as HTMLButtonElement).click()
    expect(intents).toEqual([{ type: 'set-tool', tool: 'ellipse' }])
  })

  it('offers capture and update actions only once the selection covers pixels', async () => {
    const intents: ClaimModeIntent[] = []
    const base = {
      purpose: 'capture',
      tool: 'rectangle',
      tools: [
        { tool: 'rectangle', group: 'shape', label: 'Rectangle', key: 'M', icon: 'toolRectangle' },
      ],
      groups: [],
      subtract: false,
      items: 0,
      pixels: 0,
      template: null,
      selected: false,
      selectedCount: 0,
      dirty: false,
      pending: false,
      options: { minCorners: 3, maxCorners: 12, maxWidth: 200 },
    } satisfies ClaimModeModel
    const render = (model: ClaimModeModel) => {
      const target = document.body.appendChild(document.createElement('div'))
      mounted.push(
        mount(ClaimMode, {
          target,
          props: { model, onIntent: (intent: ClaimModeIntent) => intents.push(intent) },
        }),
      )
      return (label: string) =>
        [...target.querySelectorAll('button')].find(
          (candidate) => candidate.textContent?.trim() === label,
        ) as HTMLButtonElement
    }
    const empty = render(base)
    expect(empty('Save claims')).toBeUndefined()
    expect(empty('Add as template').disabled).toBe(true)
    expect(empty('Download PNG').disabled).toBe(true)

    const selected = render({ ...base, items: 1, pixels: 12, dirty: true })
    await tick()
    selected('Download PNG').click()
    selected('Add as template').click()
    const update = render({ ...base, purpose: 'update', items: 1, pixels: 12, dirty: true })
    await tick()
    expect(update('Add as template')).toBeUndefined()
    update('Update template').click()
    expect(intents).toEqual([
      { type: 'capture', action: 'download' },
      { type: 'capture', action: 'template' },
      { type: 'capture', action: 'update' },
    ])
  })
})
