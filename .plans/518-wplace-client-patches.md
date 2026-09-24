# #518 perf(userscript): patch Wplace's idle map rendering and tile refresh from the client

## Summary

Wplace's client keeps its MapLibre map rendering at 60 fps while idle. It also re-downloads every visible tile on a timer and reloads every tile for each draft pixel. Caelestis already runs inside the page and holds the map, so it patches that waste from the client. What Wplace users see must stay the same, each patch can be switched off on its own, and Caelestis's own frame-driven work must keep working once the idle frames stop.

## Acceptance criteria

- [x] The hover canvas stops forcing continuous renders, and the hover crosshair still follows the cursor.
- [x] The highlight-area layers stop re-ordering themselves every frame, and their final order matches Wplace's intent.
- [x] Periodic tile refreshes reload only tiles whose `Last-Modified` or `Content-Length` changed. The off-screen tile cache is still reset on refresh, and a periodic full refresh remains as a safety net.
- [x] Draft-preview refreshes reload only the tiles whose draft set changed, merged to one refresh per frame.
- [x] Caelestis skips its full-tile pixel capture when a tile's bytes are unchanged.
- [x] Hidden Wplace marker animations are paused.
- [x] Presence drafts and deferred marker retries finish without relying on later map frames.
- [x] Each Wplace patch can be switched off from `__caelestis.wplacePatches`, and the setting persists.
- [x] Anti-cheat code stays untouched: pawtect, the bot check, Wplace's fetch wrapper, storage sync, and Turnstile.
- [x] Measured in the background debug Chromium, before and after.

## TODOs

- [x] Add the Wplace patch registry with persistent per-patch switches and the debug API, plus P1 (pause `pixel-hover`), P2 (highlight-area move guard), and P6 (pause hidden marker animations), with tests. Validated: `vitest run src/wplace-patches.test.ts` (14 passed), `tsc --noEmit`, biome.
- [x] Make the presence draft check run on a trailing timer when its one-second limit skips a check, with tests. Validated: `vitest run src/presence-client.test.ts` (19 passed), `tsc --noEmit`, biome.
- [x] Drive the deferred marker retry from a timer instead of from later frames, with tests. Validated: `vitest run src/gl/markers.test.ts src/gl/markers-work.test.ts` (16 passed), `tsc --noEmit`, biome.
- [x] P3 + P4: conditional tile refresh with HEAD checks, and narrowed draft-preview refreshes from the service-worker message tap, with tests. (Codex gpt-6-sol) Review fix: draft tiles used the season as `z`, so narrowed refreshes matched no tile; `z` now comes from the source zoom, and the tests use the real season 0. Validated: `vitest run src/wplace-tile-refresh.test.ts src/wplace-patches.test.ts` (34 passed), `tsc --noEmit`, biome.
- [x] P5: skip Caelestis tile capture when a tile's bytes are unchanged, with tests. (Codex gpt-6-sol) Validated: `vitest run src/tile-transform.test.ts` (57 passed), `tsc --noEmit`, biome.
- [x] Live verification in the background debug Chromium, before/after numbers in `docs/performance-profiling.md`, and Changesets. Paris z12.8, 60 idle s:
  - task time 24.7 s → 1.25 s
  - `triggerRepaint` 18,010 → 7
  - tile traffic 20 GETs / 4,048 KB → 18 HEADs + 2 GETs / 405 KB

  Also verified live: a busy Antarctica tile still updates, the hover crosshair follows the pointer, the highlight order holds, a draft pixel bakes into and clears from only its own tile, and hidden marker animations are paused. Each commit carries its own Changeset.

## Notes

- Evidence and design constraints live in the issue body.
- P1 must stay scoped to `pixel-hover`. Wplace's draft sources (`paint-preview-*`) are canvas sources that Wplace writes with `putImageData`, and `reconcileDrafts` relies on them animating.
- P2 guard: a move with a `before` id is skipped when it would not change `_order`. A move to the top is skipped when every layer above it is a highlight-area sibling (same suffix) that Wplace's listener moves later: line-white, then line-color, then image-layer.
- Page JS cannot send `If-None-Match`: the preflight gets a 405. `HEAD` is a simple CORS request and exposes `Last-Modified` and `Content-Length`. `ETag` isn't exposed.
- Wplace posts service-worker messages through `ServiceWorker.prototype.postMessage` on `navigator.serviceWorker.controller` or `registration.active`, as `{ ...message, id }`. `previewPixels` data: `[{ tile: [x, y], pixel: [x, y], season, color }]`.
- Live check caught a bug the unit tests missed. Wplace posts `clearPixelPreview` every 5 s with nothing drafted, and the first build treated each one as a draft change, which stopped periodic refreshes entirely. Fixed in the P3 + P4 commit: only a real draft change counts, and an empty draft flush falls through to the periodic check.
- One live session showed the hover crosshair missing, with the `pixel-hover` tile manager stuck at the hidden position. It happened with the hover patch on and off. It did not recur in four targeted reproductions: fresh load, each patch alone, the same navigation, and a full replay of that session. `main` renders the crosshair. The cause is unknown and is recorded in the PR.
- P5 did not run live in this profile (no visible local templates and Paint closed). Its coverage is the unit tests.
- Full userscript suite: 1,696 tests pass twice in a row on one shared `NODE_OPTIONS=--localstorage-file=...` file. The P5 tests now keep patch switches in memory, so a switched-off patch cannot leak into later runs. Without that option, 10 tests in `wplace-theme` and `display-mode` fail on Node 26, the known environment issue on `main`.
- MapLibre 5.21 `map.refreshTiles(id)` resets the off-screen cache and reloads every in-view tile. `map.refreshTiles(id, [{ x, y, z }])` reloads only those tiles.
