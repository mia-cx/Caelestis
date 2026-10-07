# #588 Add a standard UI toggle to Wplace's settings until Wplace ships one

## Summary

Wplace already has a standard (DaisyUI) style behind `data-standard-ui`, but nothing exposes it.
Add a native-looking "Standard UI" toggle under Wplace's "Pixelated fonts" toggle that sets the
attribute, persists the choice, applies it before first paint, and steps aside once Wplace ships
its own option. How Caelestis restyles under the attribute is #585.

## Acceptance criteria

- [x] The toggle appears under Wplace's pixel fonts toggle and matches its look in both themes and both UI styles.
- [x] Turning it on removes Wplace's pixel styles without a reload (Caelestis follows via #585).
- [x] The setting survives a reload and in-app navigation.
- [x] With the Caelestis userscript removed, Wplace is unaffected.
- [x] A userscript Changeset entry.

## TODOs

- [x] Persist the Standard UI choice and keep `data-standard-ui` applied from document-start, re-applying it when Wplace's layout effect clears it.
- [x] Add the Standard UI toggle under Pixelated fonts, and hide it once Wplace offers its own option.
- [x] Add the userscript Changeset.
- [x] Verify on wplace.live in background Chromium: look in both themes and styles, reload, in-app navigation.
- [x] Present the switch as "Pixelated UI" (on by default, off = standard UI).
- [x] Use the browser's own cursors under standard UI.
- [x] Bring back Wplace's Material Symbols icons under standard UI.

## Notes

- Live bundle (2026-10-07): `standard` is not on the captured state. It lives in its own module
  (`_app/immutable/chunks/CnsPo_HR.js`) as a getter-only object:
  `{ get standard() { return route.id === '/(game)/dashboard' || route.id?.startsWith('/(game)/dashboard/') } }`.
  No setter, no storage: Wplace's standard UI is its dashboard UI. The root layout effect runs
  `toggleAttribute('data-standard-ui', P.standard)` and removes it in cleanup, so it re-runs on
  every navigation. So the attribute is how styles switch. Icons come from widening the getter itself (below).
- Pixel fonts: `:root[data-pixel-fonts=false], :root[data-standard-ui]` both switch `--font-sans`
  to Geist, so the toggle leaves the pixel fonts setting alone.
- Settings live in `wplace:settings:v1` (localStorage), a fixed whitelist without any standard key.
  "Pixelated fonts" is the first toggle in `#settings-panel-accessibility`.
- The settings dialog opens while logged out.
- Live check (background Chromium, isolated profile, bundle via `addScriptToEvaluateOnNewDocument`):
  toggle renders under Pixelated fonts and matches it in light/dark × pixel/standard; a CDP click
  switches the style live; after reload the attribute is set at the first animation frame, before
  `data-game-ui`; client-side navigation `/` → `/appeals` → back keeps it (8 reset/re-apply
  records); a `standardUi` key in `wplace:settings:v1` hides the row and stops forcing; without
  the bundle the attribute stays off and Wplace's settings are untouched.
- First live run caught `document.documentElement` being null at document-start; the observer
  now watches `document`.
- Cursors: Wplace defines 19 `--cursor-*` properties on `:root` and `:root[data-theme=dark]` as
  pixel SVGs with keyword fallbacks; standard UI sets each to its fallback keyword.
- Icons: 128 icon components render `standard ? Material Symbols : pixel`, all from the one
  getter. A page-world script reads the root layout (`nodes/0.*.js`) to find that module, imports
  it, and widens the getter to honour `data-caelestis-standard`. Live: override lands at ~290 ms,
  before hydration, so icons are Material Symbols from first paint. A mid-session flip changes
  icons on the next load or route change; the getter is not reactive to our attribute. Icons
  without a Material variant (gear, palette, bug, alliance) stay as they are.
