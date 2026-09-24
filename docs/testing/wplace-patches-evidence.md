# Wplace client patch evidence

Caelestis patches waste in Wplace's own client (#518): idle map redraws, unconditional tile
re-downloads, and whole-viewport draft refreshes. MapLibre and Wplace's page are the external
boundary, so the fast suite fakes them with their real contracts. Wplace compatibility is verified
by the manual release check against real Wplace, as the [userscript plan](userscript.md) prescribes.

Run the fast contracts with:

```sh
pnpm --filter @caelestis/userscript test src/wplace-patches.test.ts src/wplace-tile-refresh.test.ts test/tile-capture-contract.test.ts
```

| Behavior | Fast evidence | Manual release check |
| --- | --- | --- |
| Hover crosshair stops forcing frames | `wplace-patches.test.ts`: only `pixel-hover` stops reporting a transition; draft canvas sources keep playing; a re-created source is paused on load; switching off restores it. | Idle main-thread time fell from 24.7 s to 1.25 s per minute; the crosshair follows the pointer at zoom 17. |
| Highlight layers stop reordering every update | Wplace's shipped listener reaches its intended order once, then moves nothing on later style updates; other layers and the switched-off path pass through. | `triggerRepaint` fell from 18,010 to 7 calls per idle minute; the colour line stays above the white line. |
| Hidden marker animations pause | Computed `animation-play-state` is paused only on markers at `opacity: 0`, and not after switching off. | Paused on the live event marker. |
| Tile refresh reloads only changed tiles | `wplace-tile-refresh.test.ts`: unknown, changed, refused, dateless, failed, and `errored` tiles reload; unchanged ones skip; a stalled HEAD settles at its deadline; the safety refresh runs every tenth call and after 90 s; a new season URL counts as unknown; broken MapLibre internals fall back to a full refresh. | 18 HEADs and 2 GETs (405 KB) replaced 20 GETs (4,048 KB) per minute; a busy tile still updated. |
| Draft refresh reloads only draft tiles | Changed draft pixels and `clearPixelPreview` narrow the reload to their tiles at the source zoom; one stroke is one reload per frame; the idle keep-alive and net-empty drafts still run the periodic check; paint, rollback, and worker refreshes pass through; `postMessage` stays transparent. | A draft pixel baked into and cleared from only its own tile. |
| Capture re-reads after scope grows | A new capture scope key (Paint, a template position) triggers one full refresh; switching conditional refresh off leaves it to Wplace. | Not exercised live. |
| Unchanged tiles skip readback | `test/tile-capture-contract.test.ts` through the production fetch and bitmap taps: identical bytes skip the readback; changed, evicted, accepted-paint, drafted, switched-off, and unhashable cases read again. | Not exercised live; the profile had no visible local templates and Paint closed. |
| Settings switch each patch | `packages/ui/tests/settings-panel.test.ts`: each toggle reflects its patch and emits `set-wplace-patch` for its own id; the section is absent without patches. `wplace-patches.test.ts` covers persistence and live application of a switch. | Switching "Stop idle redraws" off in Settings resumed the hover source and stored the choice; switching it on paused it again. |

## Gaps

| Fix | Verification | Missing fixture |
| --- | --- | --- |
| Presence sends a cleared draft after its one-second limit, without another map frame | A unit test in the inherited `presence-client.test.ts`, deleted by the suite rewrite, plus code review. | A presence protocol suite with a typed WebSocket and real tile-transform drafts. |
| Deferred marker scans retry on a timer while the map is idle | A unit test in the inherited `gl/markers.test.ts`, deleted by the suite rewrite, plus code review. | A marker renderer fixture with controlled time and a map handle. |

Validated on 2026-09-24 after rebasing onto #412: the three files above pass alone and shuffled
with seeds 76 and 4242, and the full userscript suite passes.
