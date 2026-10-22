import { WPLACE_PALETTE } from '@caelestis/shared'
import { afterEach, expect, it, vi } from 'vitest'
import { useWplaceCatalog } from './wplace-messages.js'
import {
  cancelPaintDraft,
  paintPaletteIndexOf,
  paintPaletteSwatches,
  performPaintAction,
  undoPaintDraft,
} from './wplace-paint.js'

vi.mock('./alliance-surface.js', () => ({ activeAllianceEditorStage: () => null }))

// Entries from Wplace's French catalog, as its locale module serves them.
const FRENCH = { undo: 'Annuler', redo: 'Rétablir', close: 'Fermer', paint: 'Peindre' }

afterEach(() => {
  useWplaceCatalog(null)
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
