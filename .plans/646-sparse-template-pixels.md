# #646 Store template pixels sparsely and budget opaque pixels

## Summary
Template pixels are one dense `width × height` array in memory, on disk and on the GPU, so a sparse
alliance template costs its whole bounding box. Cut pixels into 1000×1000 chunks, keep only chunks
with something painted, and budget the stored chunk area.

Decided with Mia (2026-10-22):
- Budget stored chunk area, not opaque pixels: it is what memory actually holds.
- Sparse in memory, on disk (IndexedDB records and the server pixel cache) and on the GPU.
- Chunks sit on the template's own grid, so a move never re-cuts pixels. Import, download and
  export stay dense at their boundaries; a dense copy is assembled only for the moment an action
  needs it.

## Acceptance criteria
- [x] A template's resident cost is the area of its painted chunks.
- [x] IndexedDB records and the server pixel cache store only painted chunks; old dense records
      still load.
- [x] The GPU uploads no texture for an empty chunk, and outlines still draw at chunk edges.
- [x] Mismatch scans, markers, nearest, picker, previews, edit, move, export and copy behave as before.

## TODOs
- [x] `sparse-pixels.ts`: chunk type, cut, join, pixel and rectangle reads, pack/unpack; unit test.
- [x] Store, mismatch and GPU together (one commit, since none builds without the others):
  - artwork holds `SparsePixels`; residency counts stored area; readers move over;
  - scans read the tile's window from chunks; the worker caches one window per tile;
  - one texture per painted chunk with neighbour halos; open sides draw outline margins.
- [x] Disk: records and server cache store packed chunks; legacy dense records cut on load.
- [x] Contract test: a sparse template costs its painted chunks and reloads intact; changeset.
- [x] Visual QA: outlines at chunk edges match main in a real Wplace tab.

## Notes
- Shell PATH lacks Homebrew: prefix `PATH=/opt/homebrew/bin:$PATH`. Tests need
  `NODE_OPTIONS=--localstorage-file=/tmp/639-ls`.
- Store/mismatch/GPU: disk stays dense for now (cut on load, joined on save). `templatePixels` now
  returns a dense copy for whole-image actions; `templateChunks` returns the chunks. Alliance marker
  indexes still allocate bbox-sized classification arrays while a template is on screen.
  Validation: typecheck clean, 260/260 tests.
- Disk: a record's `indices` Blob holds packed chunk bytes and `chunks` their grid keys; no
  `chunks` means a dense record from before, cut on load and written back packed under the same
  revision. Hydrated records carry `pixels`. Restore learns a packed record's cost from its Blob
  size. Server cache entries pack the same way; `cachedServerCopy` reports opaque count and area.
  Downloads and native Wplace images are still assembled dense, then cut. Validation: typecheck
  clean, 262/262 tests.
- Final: 263/263 tests, `test:browser` passes (one earlier run hit a CDP connect timeout; main and
  this branch both pass on retry). Visual QA in background Chromium (port 9336): a 2000×2000
  template with a square ending on an empty chunk and a bar crossing two chunks renders the same on
  main and the branch; the largest colour difference is 3/255, which is anti-aliasing.
