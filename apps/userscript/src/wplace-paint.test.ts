import { WPLACE_PALETTE } from '@caelestis/shared'
import { afterEach, expect, it, vi } from 'vitest'
import { setState } from './settings.js'
import { paintPaletteIndexOf, paintPaletteSwatches } from './wplace-dom.js'
import { useWplaceCatalog } from './wplace-messages.js'
import {
  cancelPaintDraft,
  isPaintOpen,
  performPaintAction,
  performShadeSwapAction,
  submitWorldPaintDraft,
  undoPaintDraft,
  watchPaintSelection,
} from './wplace-paint.js'

vi.mock('./alliance-editor-dom.js', () => ({
  activeAllianceEditorStage: () => null,
  activeAllianceDialog: () => null,
}))

// Entries from Wplace's French catalog, as its locale module serves them.
const FRENCH = { undo: 'Annuler', redo: 'Rétablir', close: 'Fermer', paint: 'Peindre' }

afterEach(() => {
  useWplaceCatalog(null)
  setState({ simulatedInput: {} })
  document.body.replaceChildren()
})

const clicks = (): string[] => {
  const clicked: string[] = []
  for (const button of document.querySelectorAll('button'))
    button.addEventListener('click', () =>
      clicked.push(button.getAttribute('aria-label') ?? button.textContent ?? ''),
    )
  return clicked
}

it('drives a French paint drawer through its translated controls', () => {
  useWplaceCatalog(() => FRENCH)
  setState({ simulatedInput: { 'paint-commit': true } })
  document.body.innerHTML = `
    <section>
      <header>
        <button aria-label="Annuler"></button>
        <button aria-label="Rétablir"></button>
        <button aria-label="Fermer"></button>
      </header>
      <button id="color-1" aria-label="Noir" aria-pressed="true"></button>
      <button class="btn btn-primary">Peindre (0:25)</button>
    </section>`
  const clicked = clicks()

  expect(undoPaintDraft()).toBe(true)
  expect(performPaintAction()).toBe(true)
  expect(cancelPaintDraft()).toBe(true)
  expect(clicked).toEqual(['Annuler', 'Peindre (0:25)', 'Fermer'])
})

it('reads alliance swatches by their colour, whatever their translated name', () => {
  const darkGray = WPLACE_PALETTE.find((colour) => colour.name === 'Dark Gray')
  document.body.innerHTML = `
    <button class="btn game-color-swatch pixelated" aria-label="Transparent" aria-pressed="false"
      style="background-image: url(checker.png)"></button>
    <button class="btn game-color-swatch" aria-label="Noir" aria-pressed="false"
      style="background: rgb(0 0 0)"></button>
    <button class="btn game-color-swatch" aria-label="Gris foncé" aria-pressed="true"
      style="background: rgb(60, 60, 60)"></button>`

  expect(paintPaletteSwatches(document).map(paintPaletteIndexOf)).toEqual([
    null,
    0,
    darkGray?.index,
  ])
})

it("finds the territory event's controls by their translated labels", () => {
  // `cancel` and `territory_shade_swap` stand in for Wplace's own translations.
  useWplaceCatalog(() => ({ ...FRENCH, cancel: 'Abandonner', territory_shade_swap: 'Teinte' }))
  setState({ simulatedInput: { 'paint-commit': true } })
  document.body.innerHTML = `
    <div class="z-30 flex gap-2">
      <button data-tooltip="Peindre"><span>Peindre</span> <span>51/60</span></button>
      <button data-tooltip="Teinte"><span>Teinte</span> <span>60/60</span></button>
    </div>`
  const opened = clicks()
  expect(performShadeSwapAction()).toBe(true)
  expect(performPaintAction()).toBe(true)
  expect(opened).toEqual(['Teinte 60/60', 'Peindre 51/60'])

  document.body.innerHTML = `
    <div class="grid grid-cols-2">
      <button>Abandonner</button>
      <button class="btn btn-primary"><span>Teinte</span> (0:04)</button>
    </div>`
  const committed = clicks()
  expect(performPaintAction()).toBe(false)
  expect(performShadeSwapAction()).toBe(true)
  expect(committed).toEqual(['Teinte (0:04)'])
})

it("counts the territory event's open Paint panel as painting, so its drafts are recorded", () => {
  useWplaceCatalog(() => ({ ...FRENCH, cancel: 'Abandonner' }))
  document.body.innerHTML = `
    <div class="grid grid-cols-2">
      <button>Abandonner</button>
      <button class="btn btn-primary"><span>Peindre</span> (0:04)</button>
    </div>`
  watchPaintSelection()
  expect(isPaintOpen()).toBe(true)
})

it("submits a capture slot through the territory event's Paint panel", () => {
  useWplaceCatalog(() => ({ ...FRENCH, cancel: 'Abandonner' }))
  document.body.innerHTML = `
    <div class="grid grid-cols-2">
      <button>Abandonner</button>
      <button class="btn btn-primary"><span>Peindre</span> (0:04)</button>
    </div>`
  const clicked = clicks()
  expect(submitWorldPaintDraft()).toBe(true)
  expect(clicked).toEqual(['Peindre (0:04)'])
})
