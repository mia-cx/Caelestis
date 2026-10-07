import falseType from './fonts/FalseType.woff2'

/**
 * FalseType in front of Wplace's pixel font stacks.
 *
 * Wplace sets `--font-sans` and `--font-mono` on its root, and turns the pixel fonts off with
 * `data-pixel-fonts=false` or `data-standard-ui`. The override matches neither, so Wplace's Geist
 * rule applies untouched when either is set. Wplace's own stacks follow FalseType, copied from its
 * `:root` theme and `:lang(ja)` rules, so glyphs FalseType lacks still come from their fonts.
 * The override is unlayered and more specific than Wplace's rules, so it wins while it matches.
 */
const PIXEL_FONTS = ':root:not([data-pixel-fonts=false]):not([data-standard-ui])'

const override = (selector: string, cjk: string): string =>
  `${selector}{` +
  `--font-sans:"FalseType", "Pixelify Sans", "WPlace Pixel Mono", "${cjk}", ui-sans-serif, system-ui, sans-serif;` +
  `--font-mono:"FalseType", "WPlace Pixel Mono", "Pixelify Sans", "${cjk}", ui-monospace, monospace}`

// One weight covers 100–900 so the browser never fakes bold from it. `size-adjust` draws it a little
// larger than Wplace's sizes ask for, since its 8px caps read small next to Pixelify Sans.
const CSS =
  `@font-face{font-family:"FalseType";src:url(${falseType}) format("woff2");font-weight:100 900;size-adjust:112.5%;font-display:block}` +
  override(PIXEL_FONTS, 'Fusion Pixel Chinese') +
  override(`${PIXEL_FONTS}:is(:lang(ja),:lang(jp))`, 'Fusion Pixel Japanese')

/** Adopt the font sheet on the document. Safe at `document-start`, before `<html>` exists. */
export const installWplaceFont = (): void => {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(CSS)
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
}
