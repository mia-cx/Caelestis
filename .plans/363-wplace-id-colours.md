# #363 Wplace ID colours for per-user pace graphs

## Summary
Give each painter the colour Wplace shows beside their `#ID`, instead of Caelestis's own id hash.

## Acceptance criteria
- [x] Line, picker swatch, and tooltip marker use the painter's Wplace ID colour.
- [x] Colour depends only on the id: stable across ranges, metrics, scopes, ordering, reloads, and renames.
- [x] Historical painters get the mapping without new reports or a backfill.
- [x] Colliding ids keep the native colour; no substitutes by chart order.
- [x] Representative ids across all 14 entries and wraparound are tested; both themes checked.

## TODOs
- [x] Replace the id hash with Wplace's 14-entry table in `painter-pace.ts`; drop the dead `--painter-l/c` tokens.
- [x] Add a contract test for the mapping and wraparound.
- [x] Changeset and chart DESIGN.md note.
- [x] Before/after screenshots in both themes.

## Notes
- Verified on the deployed client on 2026-10-01: chunk `Dp7tudnO.js` holds
  `text-{red,orange,yellow,lime,emerald,teal,cyan,sky,indigo,violet,purple,fuchsia,pink,rose}-500`
  and selects `t[e % t.length]`. The CSS asset `0.R3_xx-R5.css` defines those as Tailwind v4 oklch values.
- Wplace uses the same 500 shade in both themes, so Caelestis does too.
