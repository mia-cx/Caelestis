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
- [ ] A template's resident cost is the area of its painted chunks.
- [ ] IndexedDB records and the server pixel cache store only painted chunks; old dense records
      still load.
- [ ] The GPU uploads no texture for an empty chunk, and outlines still draw at chunk edges.
- [ ] Mismatch scans, markers, nearest, picker, previews, edit, move, export and copy behave as before.

## TODOs
- [x] `sparse-pixels.ts`: chunk type, cut, join, pixel and rectangle reads, pack/unpack; unit test.
- [ ] Store: artwork holds `SparsePixels`; residency counts stored area; readers move over.
- [ ] Disk: records and server cache store packed chunks; legacy dense records cut on load.
- [ ] Mismatch: scans read the tile's rectangle from chunks; worker caches per tile.
- [ ] GPU: one texture per painted chunk with neighbour halos; open edges draw outline margins.
- [ ] Contract test: a sparse template costs its painted chunks and reloads intact; changeset.

## Notes
- Shell PATH lacks Homebrew: prefix `PATH=/opt/homebrew/bin:$PATH`. Tests need
  `NODE_OPTIONS=--localstorage-file=/tmp/639-ls`.
