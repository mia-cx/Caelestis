# #528 Lighter claims and viewports, with an option to show claims only while painting

## Summary
Claim fill and stripes are too heavy on the map. Lighten them, and lighten viewports a little.
Add a setting that hides claims unless Wplace's paint drawer is open.

## Acceptance criteria
- [ ] Claim fill and stripes are more transparent. Outlines unchanged.
- [ ] Viewport fill and dots (and painting stripes) are slightly more transparent.
- [ ] "Only while painting" under "Show region claims" hides claims and their labels while the drawer is closed.
- [ ] Claims fade in and out with the drawer.
- [ ] The claim editor preview stays visible.
- [ ] The setting persists and defaults to off.
- [ ] Focused coverage and a userscript Changeset.

## TODOs
- [x] Lower claim and viewport fill and pattern alphas; Changeset.
- [x] Add the stored setting and a pure claims-visible predicate with tests.
- [x] Gate the presence layer and claim labels on the predicate; repaint when the drawer opens or closes.
- [ ] Add the settings toggle and panel model field; Changeset.
- [ ] Final validation: typecheck, lint, userscript and ui tests.

## Notes
- "Paint mode" is Wplace's paint drawer being open (`isPaintOpen()` in `wplace-paint.ts`).
- The layer fades items by key, so dropping claims from the item list fades them out for free.
- Drawer changes already call `redraw()` in `main.ts`, which triggers a map repaint, so the layer needs no extra listener.
