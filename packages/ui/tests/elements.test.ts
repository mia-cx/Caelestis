import { tick } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type CaelestisPanel,
  type CaelestisRailControl,
  registerCaelestisUi,
  useIconSet,
} from '../src/elements/index.js'

afterEach(() => {
  document.body.replaceChildren()
  useIconSet('material')
})

describe('custom element host boundary', () => {
  it('accepts its public model and forwards a composed panel intent', async () => {
    registerCaelestisUi()
    const element = document.createElement('caelestis-panel') as CaelestisPanel
    element.model = { view: 'tree', width: 320, minWidth: 280, maxWidth: 400 }
    const details: unknown[] = []
    element.addEventListener('caelestis-panel-intent', (event) =>
      details.push((event as CustomEvent).detail),
    )
    document.body.append(element)
    await tick()
    const close = element.shadowRoot?.querySelector(
      'button[aria-label="Close"]',
    ) as HTMLButtonElement
    close.click()
    expect(details).toEqual([{ type: 'close' }])
  })

  it('re-renders mounted icons when the active icon set changes', async () => {
    registerCaelestisUi()
    const element = document.createElement('caelestis-rail-control') as CaelestisRailControl
    element.model = { id: 'panel', label: 'Panel' }
    document.body.append(element)
    await tick()
    const svg = element.shadowRoot?.querySelector('svg')
    const material = svg?.innerHTML
    useIconSet('pixel')
    await tick()
    const pixel = element.shadowRoot?.querySelector('svg')
    expect(pixel).toBe(svg)
    expect(pixel?.innerHTML).not.toBe(material)
    useIconSet('material')
    await tick()
    expect(element.shadowRoot?.querySelector('svg')?.innerHTML).toBe(material)
  })
})
