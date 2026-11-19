import { mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import AppearanceEditor from '../src/appearance/AppearanceEditor.svelte'
import type { AppearanceEditorIntent, AppearanceEditorModel } from '../src/appearance/model.js'

const mounted: object[] = []
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((component) => unmount(component)))
  document.body.replaceChildren()
})

/** Mounts the overlay editor with one Opacity slider in the pixels group. */
const render = async (pixelsOwned: boolean) => {
  const intents: AppearanceEditorIntent[] = []
  const model = {
    variant: 'overlay',
    values: {
      size: 1,
      radius: 0,
      translateX: 0,
      translateY: 0,
      rotation: 0,
      opacity: 1,
      contrastOutline: false,
      contrastOutlineSize: 1,
      markerSize: 9,
      markMismatch: true,
      markerColour: '#ffffff',
      markUnpainted: false,
      unpaintedLimit: 0.05,
      dimOthers: false,
      otherOpacity: 0.15,
      markSelectedColour: false,
      selectedMarkerSize: 9,
      selectedMarkerColour: '#ffffff',
      otherColour: null,
    },
    sliders: [
      {
        key: 'opacity',
        group: 'pixels',
        label: 'Opacity',
        value: 0.5,
        defaultValue: 1,
        min: 0,
        max: 1,
        step: 0.1,
        format: 'percent',
      },
    ],
    pixelPresets: [],
    colourPresets: [],
    palette: [],
    onlySelectedColour: false,
    paintOpen: false,
    groups: { pixels: { owned: pixelsOwned }, markers: { owned: true }, colours: { owned: true } },
  } satisfies AppearanceEditorModel
  const target = document.body.appendChild(document.createElement('div'))
  mounted.push(
    mount(AppearanceEditor, {
      target,
      props: { model, onIntent: (intent: AppearanceEditorIntent) => intents.push(intent) },
    }),
  )
  await tick()
  const slider = target.querySelector('input[aria-label="Opacity"]') as HTMLInputElement
  const useDefaults = target.querySelector(
    'input[aria-label="Use default pixels"]',
  ) as HTMLInputElement
  return { intents, slider, useDefaults }
}

describe('appearance editor intent boundary', () => {
  it('previews every slider move and commits once when the drag ends', async () => {
    const { intents, slider } = await render(true)
    for (const value of ['0.6', '0.7']) {
      slider.value = value
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    }
    slider.dispatchEvent(new Event('change', { bubbles: true }))
    slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    expect(intents).toEqual([
      { type: 'preview-number', key: 'opacity', value: 0.6 },
      { type: 'preview-number', key: 'opacity', value: 0.7 },
      { type: 'commit-number', key: 'opacity', value: 0.7 },
    ])
  })

  it('locks a group that follows the defaults and asks to take it over', async () => {
    const { intents, slider, useDefaults } = await render(false)
    // Happy DOM leaves :disabled off controls a disabled fieldset disables, as browsers apply it.
    expect(slider.matches('fieldset:disabled *')).toBe(true)
    expect(useDefaults.checked).toBe(true)
    useDefaults.click()
    expect(intents).toEqual([{ type: 'set-group-owned', group: 'pixels', owned: true }])
  })
})
