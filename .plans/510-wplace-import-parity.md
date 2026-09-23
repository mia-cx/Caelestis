# #510 Wplace file import parity

## Outcome

Import the reported 1024 × 1024 source at its 113 × 113 geographic extent. Match Wplace's floor-based nearest-neighbor sampling, palette settings, dithering, legacy decoding, and alpha threshold. Plain PNG and Marble imports retain their behavior.

## TODOs

- [x] Add the exact RGBA resizer with focused sampling tests.
- [x] Use bounds and the existing native-processing bridge for file imports; test geometry, metadata, and failure boundaries.
- [ ] Compare real imports against the live worker, add release notes, run affected checks, and file the PR.

## Evidence

- Chromium CDP confirmed Wplace samples `floor(x * sourceWidth / targetWidth)` and the equivalent for Y.
- United Pixels origin is (794966, 1697843), output is 113 × 113, and native output has 2,447 painted pixels.
- Mia confirmed full native output parity, including palette/dither settings and alpha >= 16.
- #511 separately tracks original source, Ditherette recipes, and durable processed caches in local stores and servers.
- Regression reproduced before the fix: expected 113 × 113, received 1024 × 1024 at the correct anchor.
- Live Chromium comparison: the real file and 36 gradient cases across three color metrics, dithering on/off, legacy decoding on/off, and three palette modes have zero differing indices.
- 1,637 userscript tests, userscript type check, and userscript build pass. Full-suite happy-dom teardown emits fetch AbortErrors without failing tests; the focused changed-path tests are clean.
- Repository lint passes with one existing release-workflow regex warning.
