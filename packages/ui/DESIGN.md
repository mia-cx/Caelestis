# Two styles

Caelestis draws in one of two styles, set by `data-caelestis-style` on each custom-element host. The userscript's theme bridge sets it from Wplace's root: `pixel` while `data-game-ui` is present and `data-standard-ui` is not, `classic` otherwise, and it repaints every host when those attributes change. Components never read Wplace's attributes themselves. The frontend sets neither the attribute nor the tokens, so it always renders the classic rules with their literal fallbacks, under its own pixel theme in `app.css`.

## Classic

Every rectangular surface and control uses `--caelestis-radius`, including menus, popovers, panels, cards, fields, and buttons. Its default `calc(0.7rem + 1px)` preserves the template context menu's established radius. The userscript theme and frontend DaisyUI/Tailwind tokens use the same value. Pill-shaped controls use `--caelestis-pill-radius` (`999px`). Text uses `--caelestis-font`, which follows Wplace's standard stack (Geist).

## Pixel

Pixel mirrors Wplace's game UI. Both radius tokens are `0`, shadows are flat offsets in Wplace's `--pixel-shadow`, and text uses Wplace's `--font-sans`. The bridge maps Wplace's `--pixel-*` palette onto `--caelestis-pixel-*` tokens with fallbacks from the DaisyUI colours.

Shared roles live in `foundations/PixelStyles.svelte`, which every element renders: `caelestis-surface` (menus, popovers, toasts), `caelestis-panel-surface` (the panel and modal dialogs), `caelestis-field`, `caelestis-badge`, and `caelestis-bevel` (Wplace's button bevel). Tag an element with its role instead of drawing a frame locally. Foundations whose controls Wplace draws differently (button, rail control, switch, checkbox, slider) keep their pixel rules next to their classic rules. In forced colours, pixel rules fall back to system colours like Wplace's own.

## Shapes in both styles

Dots, data markers and the colour picker handle stay circular in both styles. Palette colour swatches use `--caelestis-pill-radius`, because Wplace squares its palette in pixel. Flush edges in joined regions remain square. Do not introduce separate radius scales or derive a different radius for inset controls.

# Icons

Glyphs come from Iconify's per-icon modules: Material Symbols (`@iconify-icons/material-symbols`) for classic, Pixelarticons (`@iconify-icons/pixelarticons`) for pixel, matching what Wplace's rail renders in each style. `foundations/icons-material.ts` and `icons-pixel.ts` name each glyph once per set, and `Icon.svelte` is the only place icon SVG is rendered, in the userscript panel and in the frontend alike. `useIconSet` picks the set and mounted icons update live; the userscript calls it when the style changes, the frontend picks Pixelarticons once. Filled Material variants are the default, matching Wplace's classic rail; `-outline` variants are reserved for glyphs that lose their meaning filled at 16px, such as edit, delete, upload file, and the sidebar. Brand marks come from Iconify's Simple Icons set. Do not paste path data into components and do not add a third icon family.
