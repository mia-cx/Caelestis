# #528 Lighter claims and viewports, with an option to show claims only while painting

## Summary
Claim fill and stripes are too heavy on the map. Lighten them, and lighten viewports a little.
Add a setting that hides claims unless Wplace's paint drawer is open.

## Acceptance criteria
- [x] Claim fill and stripes are more transparent. Outlines unchanged.
- [x] Viewport fill and dots (and painting stripes) are slightly more transparent.
- [x] "Only while painting" under "Show region claims" hides claims and their labels while the drawer is closed.
- [x] Claims fade in and out with the drawer.
- [x] The claim editor preview stays visible.
- [x] The setting persists and defaults to off.
- [x] Focused coverage and a userscript Changeset.

## TODOs
- [x] Lower claim and viewport fill and pattern alphas; Changeset.
- [x] Add the stored setting and a pure claims-visible predicate with tests.
- [x] Gate the presence layer and claim labels on the predicate; repaint when the drawer opens or closes.
- [x] Add the settings toggle and panel model field; Changeset.
- [x] Final validation: typecheck, lint, userscript and ui tests.

## Notes
- "Paint mode" is Wplace's paint drawer being open (`isPaintOpen()` in `wplace-paint.ts`).
- The layer fades items by key, so dropping claims from the item list fades them out for free.
- Drawer changes already call `redraw()` in `main.ts`, which triggers a map repaint, so the layer needs no extra listener.
- Validation: userscript tsc clean, ui svelte-check clean, biome clean on changed files, userscript vitest 140/140, ui vitest 12/12.
- Not checked live in Wplace.
