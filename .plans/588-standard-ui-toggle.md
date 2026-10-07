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

## Notes

- Live bundle (2026-10-07): `standard` is not on the captured state. It lives in its own module
  (`_app/immutable/chunks/CnsPo_HR.js`) as a getter-only object:
  `{ get standard() { return route.id === '/(game)/dashboard' || route.id?.startsWith('/(game)/dashboard/') } }`.
  No setter, no storage: Wplace's standard UI is its dashboard UI. The root layout effect runs
  `toggleAttribute('data-standard-ui', P.standard)` and removes it in cleanup, so it re-runs on
  every navigation. So the attribute fallback is the only path, and icons stay pixel icons.
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
