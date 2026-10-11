import { addDocumentStyle } from './document-style.js'
import falseType from './fonts/FalseType.woff2'

/**
 * FalseType for all of Wplace's text.
 *
 * Wplace draws its text from four font properties on its root: `--font-sans` and `--font-mono`
 * (Geist), and `--font-pixel` and `--font-pixel-display` (Pixelify Sans, on `.font-pixel`
 * elements). `.font-readable` resets `--font-sans` to Geist on its subtree, so the override
 * repeats there. Wplace's Legacy UI (`data-standard-ui`) and our FalseType font switch in
 * `wplace-settings.ts` (`data-caelestis-falsetype=off`) both leave Wplace's fonts untouched.
 *
 * Wplace's own fonts follow FalseType in each stack, with the CJK pixel font from its `:lang(ja)`
 * rules, so glyphs FalseType lacks still come from them. The override is unlayered and more
 * specific than Wplace's rules, so it wins while it matches. It also keeps
 * `-webkit-font-smoothing` on, since FalseType's size-adjusted pixels need smoothing to stay
 * legible.
 */
export const FALSETYPE_ATTRIBUTE = 'data-caelestis-falsetype'
const ROOT = `:root:not([data-standard-ui]):not([${FALSETYPE_ATTRIBUTE}=off])`
const JAPANESE = `${ROOT}:is(:lang(ja),:lang(jp))`

const override = (selector: string, cjk: string): string => {
  const sans = `"FalseType", "Pixelify Sans", "WPlace Pixel Mono", "${cjk}", ui-sans-serif, system-ui, sans-serif`
  return (
    `${selector}{` +
    `--font-sans:${sans};--font-pixel:${sans};--font-pixel-display:${sans};` +
    `--font-mono:"FalseType", "WPlace Pixel Mono", "Pixelify Sans", "${cjk}", ui-monospace, monospace;` +
    `-webkit-font-smoothing:auto}`
  )
}

// One weight covers 100–900 so the browser never fakes bold from it. `size-adjust` draws it a little
// larger than Wplace's sizes ask for, since its 8px caps read small next to Pixelify Sans.
const CSS =
  `@font-face{font-family:"FalseType";src:url(${falseType}) format("woff2");font-weight:100 900;size-adjust:112.5%;font-display:block}` +
  override(`${ROOT},${ROOT} .font-readable`, 'Fusion Pixel Chinese') +
  override(`${JAPANESE},${JAPANESE} .font-readable`, 'Fusion Pixel Japanese')

/** Add the font stylesheet. Safe at `document-start`, before `<html>` exists. */
export const installWplaceFont = (): void => addDocumentStyle(CSS)
