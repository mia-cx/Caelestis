# #371 Enlarge presence dots and diagonal stripe patterns

## Summary

The dotted grid and diagonal stripes drawn inside presence shapes are too fine to read over template artwork. Widen both patterns in the shader and re-tune dot size and line width with them.

## Acceptance criteria

- [ ] Dots and diagonal lines read clearly over representative light, dark, and detailed template artwork. (Not verified in a browser this session; see Notes.)
- [x] Browsing and painting patterns remain distinguishable: dots cover 8% of a 14px cell, stripes cover 25% of a 24px period.
- [ ] Verify appearance at common map zoom levels and display pixel ratios, including overlapping presence regions. (Deferred; see Notes.)

## TODOs

- [x] Widen the stripe period and line width, and the dot cell and dot size, in `presence-layer.ts`; add a Changeset.
- [ ] Verify in the debug Chromium at two zoom levels and note the result. Deferred: no Chromium with the CDP port was running, and the only Chromium up belonged to another session, so `dev-inject.mjs --relaunch` would have quit its work.

## Notes

- Both patterns are measured in CSS pixels (device pixels divided by `u_scale`), so one change covers every zoom and pixel ratio.
- Stripes: period 12 / width 4 becomes period 24 / width 6. Dots: cell 8 / dot 2 becomes cell 14 / dot 4.
- Pattern alphas are unchanged. If the coarser dots read too strong over light artwork, lower `viewport.patternAlpha` first.
