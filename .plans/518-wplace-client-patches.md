# #518 perf(userscript): patch Wplace's idle map rendering and tile refresh from the client

## Summary

Wplace's client keeps its MapLibre map rendering at 60 fps while idle. It also re-downloads every visible tile on a timer and reloads every tile for each draft pixel. Caelestis already runs inside the page and holds the map, so it patches that waste from the client. What Wplace users see must stay the same, each patch can be switched off on its own, and Caelestis's own frame-driven work must keep working once the idle frames stop.

## Acceptance criteria

- [ ] The hover canvas stops forcing continuous renders, and the hover crosshair still follows the cursor.
- [ ] The highlight-area layers stop re-ordering themselves every frame, and their final order matches Wplace's intent.
- [ ] Periodic tile refreshes reload only tiles whose `Last-Modified` or `Content-Length` changed. The off-screen tile cache is still reset on refresh, and a periodic full refresh remains as a safety net.
- [ ] Draft-preview refreshes reload only the tiles whose draft set changed, merged to one refresh per frame.
- [ ] Caelestis skips its full-tile pixel capture when a tile's bytes are unchanged.
- [ ] Hidden Wplace marker animations are paused.
- [ ] Presence drafts and deferred marker retries finish without relying on later map frames.
- [ ] Each Wplace patch can be switched off from `__caelestis.wplacePatches`, and the setting persists.
- [ ] Anti-cheat code stays untouched: pawtect, the bot check, Wplace's fetch wrapper, storage sync, and Turnstile.
- [ ] Measured in the background debug Chromium, before and after.

## TODOs

- [x] Add the Wplace patch registry with persistent per-patch switches and the debug API, plus P1 (pause `pixel-hover`), P2 (highlight-area move guard), and P6 (pause hidden marker animations), with tests. Validated: `vitest run src/wplace-patches.test.ts` (14 passed), `tsc --noEmit`, biome.
- [ ] Make the presence draft check run on a trailing timer when its one-second limit skips a check, with tests.
- [ ] Drive the deferred marker retry from a timer instead of from later frames, with tests.
- [ ] P3 + P4: conditional tile refresh with HEAD checks, and narrowed draft-preview refreshes from the service-worker message tap, with tests. (Codex gpt-6-sol)
- [ ] P5: skip Caelestis tile capture when a tile's bytes are unchanged, with tests. (Codex gpt-6-sol)
- [ ] Live verification in the background debug Chromium, before/after numbers in `docs/performance-profiling.md`, and Changesets.

## Notes

- Evidence and design constraints live in the issue body.
- P1 must stay scoped to `pixel-hover`. Wplace's draft sources (`paint-preview-*`) are canvas sources that Wplace writes with `putImageData`, and `reconcileDrafts` relies on them animating.
- P2 guard: a move with a `before` id is skipped when it would not change `_order`. A move to the top is skipped when every layer above it is a highlight-area sibling (same suffix) that Wplace's listener moves later: line-white, then line-color, then image-layer.
- Page JS cannot send `If-None-Match`: the preflight gets a 405. `HEAD` is a simple CORS request and exposes `Last-Modified` and `Content-Length`. `ETag` isn't exposed.
- Wplace posts service-worker messages through `ServiceWorker.prototype.postMessage` on `navigator.serviceWorker.controller` or `registration.active`, as `{ ...message, id }`. `previewPixels` data: `[{ tile: [x, y], pixel: [x, y], season, color }]`.
- MapLibre 5.21 `map.refreshTiles(id)` resets the off-screen cache and reloads every in-view tile. `map.refreshTiles(id, [{ x, y, z }])` reloads only those tiles.
