# Wplace export fixture

`united-pixels-logo.wplace` is the original export Mia supplied with the oversized-import report.
Its embedded image is 1024 × 1024. Its geographic bounds describe 113 × 113 canvas pixels,
anchored at global canvas coordinate (794966, 1697843).

The import contract checks this footprint using real PNG decoding and resizing. Wplace's native
processor remains an external dependency. Synthetic cases separately verify recipe forwarding,
alpha boundaries, processing failures, and persistence of processed pixels.
