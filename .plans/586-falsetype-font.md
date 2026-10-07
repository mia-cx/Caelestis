# #586 Replace Wplace's pixel font with FalseType, respecting the pixel font setting

## Summary

Wplace's pixel UI sets `--font-sans` and `--font-mono` to Pixelify Sans and VT323 stacks. Caelestis bundles Mia's FalseType font and prepends it to both stacks on Wplace's root, only while Wplace's pixel fonts are on. Wplace's own fallbacks stay after it, including the Japanese stack. Caelestis text reads the same variables once #585 lands.

## Acceptance criteria

- [ ] Default Wplace settings: Wplace and Caelestis UI text render in FalseType.
- [ ] Pixel fonts off, or standard UI on: Wplace text is Geist again and Caelestis sets no font override.
- [ ] Toggling the setting switches fonts without a reload.
- [ ] Characters FalseType lacks, such as CJK, still render with Wplace's fallbacks.
- [ ] Licence attribution is included and a userscript Changeset entry is added.

## TODOs

- [ ] Vendor `FalseType.woff2` and its OFL licence, inline the font as a data URL in the build, and append the licence to the built userscript.
- [ ] Install the scoped `--font-sans` / `--font-mono` override at startup.
- [ ] Browser contract: the override follows the pixel-font, standard-UI, and `:lang(ja)` conditions, and the bundled face loads.
- [ ] Userscript Changeset.
- [ ] Live check on wplace.live in a background debug Chromium: default, both opt-outs toggled live, `lang=ja`, CJK fallback.

## Notes

- Licence: SIL OFL 1.1, copyright Mia Riezebos, Reserved Font Name "FalseType". Bundling is allowed when each copy carries the copyright notice and licence. The font binary has no copyright or licence name records, so the text ships as a legal comment at the end of the userscript. Mia approved redistribution.
- Source: `patchstep/FalseType@8bb693b` `dist/FalseType.woff2`, 4,360 bytes, sha256 `c058962a…4779`. 1200 units per em, 12 pixels per em, one weight, tabular digits.
- Wplace's font rules (`0.DYOXtsdE.css`): the base stacks live in `@layer theme` on `:root,:host`; `:root:lang(ja|jp)` and `:root[data-pixel-fonts=false],:root[data-standard-ui]` are unlayered at (0,2,0). The override is unlayered at (0,3,0) and (0,4,0) for Japanese, and never matches when either opt-out is set, so Wplace's Geist rule applies untouched.
- Wplace sets text in 40+ distinct sizes (`11.5px`, `.6875rem`, `10.5px`, …), mostly hard-coded, not through `--text-*`. Snapping them to 12px multiples would need per-element edits, which the issue rules out. Wplace sizes stay as they are; Caelestis sizes belong to #585.
- `font-weight: 100 900` on the face stops the browser faking bold from the single weight.
- No CSP on wplace.live, so a `data:` font loads.
