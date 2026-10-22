# #639 Keep only visible templates in memory and count opaque pixels

## Summary
Every template's pixels stay in RAM all session, capped at 64 templates and 64M bounding-box
pixels, so big catalogs (and Seven Seals mirrors) fail to load. Keep the catalog unbounded on disk,
hold pixels only for the resident set, and reload evicted pixels on demand.

Decided with Mia (2026-10-22):
- Eviction first. Keep the w×h budget, applied to the resident set only. Sparse storage and opaque
  counting become a follow-up issue: storage is dense, so an opaque budget would misstate memory.
- LRU under pressure. Nothing evicts until the budget binds; then hidden templates go first, then
  visible ones that left the viewport longest ago. Templates in view never evict.
- Server templates: cache evicted pixels in IndexedDB, re-download when the cache misses.
- Progress, painted tiles and colour totals survive eviction. Colour navigation, nearest pixel,
  editing and export load pixels on demand.

## Acceptance criteria
- [ ] IndexedDB holds any number of Local templates; no count or pixel cap on disk.
- [ ] Only resident pixels count toward the 64M budget; a new template evicts others instead of
      failing.
- [ ] Hidden and off-screen templates reload when they show or come into view.
- [ ] Progress bars keep their counts across eviction.
- [ ] Colour navigation, nearest pixel, edit, move, export and copy work on evicted templates.
- [ ] The mismatch worker and GPU store release evicted pixels.

## TODOs
- [x] Artwork token: replace `PlacedTemplate.indices` with a stable `artwork` whose pixels may be
      null; caches key on the token.
- [ ] Persistence: drop disk caps, store painted tile keys, metadata-only saves keep stored pixels.
- [ ] Store: resident budget with LRU eviction, on-demand reload for Local templates, restore
      catalog metadata for every record.
- [ ] Viewport residency: the renderer reports its view; in-view visible templates load.
- [ ] Server templates: IndexedDB pixel cache with re-download fallback; no budget refusal.
- [ ] On-demand readers: colour nav, nearest, picker, edit/move/export/copy/authoring, tree preview.
- [ ] Worker and GPU store drop evicted pixels.
- [ ] Contract tests for eviction/reload and restoring past 64 templates; changeset.

## Notes
- Shell PATH lacks Homebrew here: prefix `PATH=/opt/homebrew/bin:$PATH`. Tests need
  `NODE_OPTIONS=--localstorage-file=/tmp/639-ls` and a built backend (`turbo run build`).
- TODO 1: `templatePixels(template)` is the one async pixel accessor; sync readers check
  `artwork.indices`. Mismatch caches, colour totals and GPU textures key on the artwork, so they
  survive eviction; GPU entries no longer hold a CPU copy after upload. `saveTemplate` takes null
  indices for metadata-only saves. Validation: typecheck clean, 254/254 tests.
