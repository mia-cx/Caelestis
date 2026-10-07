# #588 Caelestis switches inside Wplace's settings

## Summary

Wplace shipped its own "Legacy UI" and "Use native OS cursor" switches in Settings ›
Accessibility, so Caelestis no longer needs a standard-UI switch of its own. What remains is
two Caelestis rows cloned into the same panel: **FalseType font** (after Pixelated fonts) and
**Caelestis cursors** (after Use native OS cursor), each defaulting on and mapping to an opt-out
attribute on `<html>` so no JS timing is involved.

## Acceptance criteria

- [x] Both rows sit flat among Wplace's own rows, match their look, and are found structurally (label order), not by text.
- [x] Each switch persists (`caelestis.wplace-options.v1`) and takes effect without a reload.
- [x] Each row is disabled (`opacity-60` + `input.disabled`, effective value shown) while its dependencies are off.
- [x] With the Caelestis userscript removed, Wplace is unaffected.
- [x] A userscript Changeset entry per feature.

## TODOs

- [x] Drop the Pixelated UI switch now that Wplace ships Legacy UI.
- [x] Add a FalseType font switch (`data-caelestis-falsetype=off`), disabled under `data-standard-ui` or `data-pixel-fonts=false`.
- [x] Add a Caelestis cursors switch (`data-caelestis-cursors=off`), disabled under `data-standard-ui` or `data-native-cursor`.
- [x] Changesets and live verification on wplace.live.

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
- Wplace shipped Legacy UI and Use native OS cursor on 2026-10-07 (`wplace:settings:v1` gained
  `oldUi` and `nativeCursor`; `standard` is now `oldUi || dashboard`), so Caelestis's own
  Pixelated UI switch was removed. The Accessibility panel now opens with Legacy UI, Pixelated
  fonts, Use native OS cursor. Attribute contract: `data-caelestis-falsetype=off` and
  `data-caelestis-cursors=off` opt out; `wplace-font.ts` and `wplace-cursors.ts` scope their
  rules to Wplace's own conditions plus the opt-out.
