# #371 Enlarge presence dots and diagonal stripe patterns

## Summary

The dotted grid and diagonal stripes drawn inside presence shapes are too fine to read over template artwork. Widen both patterns in the shader and re-tune dot size and line width with them.

## Acceptance criteria

- [x] Dots and diagonal lines read clearly over representative light, dark, and detailed template artwork.
- [x] Browsing and painting patterns remain distinguishable.
- [x] Verify appearance at common map zoom levels and display pixel ratios, including overlapping presence regions.

## TODOs

- [x] Widen the stripe period and line width, and the dot cell and dot size, in `presence-layer.ts`; add a Changeset.
- [x] Verify in the debug Chromium at two zoom levels and note the result.

## Notes

- Both patterns are measured in CSS pixels (device pixels divided by `u_scale`), so one change covers every zoom and pixel ratio.
- Stripes: period 12 / width 4 becomes period 24 / width 6. Dots: cell 8 / dot 2 becomes cell 14 / dot 4.
