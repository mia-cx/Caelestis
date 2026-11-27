# Presence at event scale

An event server can show `MAX_PRESENCE_PEERS` (64) painters at once. Each moves its viewport every
300 ms and redrafts every second, and a capture run adds its lines. This measures what the
userscript spends drawing that, finds where the time goes, and compares the fix against its base.

The fix cuts presence main-thread time per rendered frame by a third in every scenario, and by
nearly half while the pointer rests over the painters. Messages, mask uploads and name tags are
unchanged.

## Workload

The raid replay in [`wplace-raid.mjs`](../scripts/runtime-benchmark/wplace-raid.mjs) gained an
event mode. It runs the full built userscript on real Wplace in its own background tab and blocks
outgoing collaboration mutations, as described in
[raid performance](raid-performance-2026-09-19.md).

```sh
RAID_CDP_PORT=9333 RAID_TEMPLATES=284 RAID_EVENT=1 RAID_PEERS=64 RAID_DRAFTS=1 \
  RAID_HOVER_MS=10000 RAID_SCENARIOS=hover,movement,idle \
  node scripts/runtime-benchmark/compare-builds.mjs browser baseline.user.js candidate.user.js out/event
```

- `RAID_EVENT=1` marks the replayed server as an event server: it takes no claims, and it holds a
  gathering capture run of 16 painters and 2 guards with 60-pixel lines. This tab paints line 0.
  Every member's drafted count changes once a second.
- `RAID_PEERS=64` replays 64 peers. Their viewports move on every 300 ms server tick.
- `RAID_DRAFTS=1` gives each peer a 24×24 draft whose mask changes once a second.
- `RAID_CPU_PROFILE=1` writes a V8 CPU profile of each measured window. `RAID_CDP_PORT` selects
  the browser.

Hover holds the pointer over the crowd for 10 seconds, where 20 name tags show. Movement drags
and zooms the map for 12 seconds, showing 42 tags. Idle stops publishing for 10 seconds.
All runs use Chromium 150 at 1440×900 with a device scale factor of 1, and 284 loaded templates.

## Where the time went

CPU profiles of a development build at the base commit showed that per-frame work dominated, not
message handling. Parsing and applying all presence messages took about 50 ms in a 10-second
window. Peers glide between updates, so the map renders continuously while they move, and every
frame repeated work whose inputs had not changed:

- Name tags read `style.background` back on every frame. The browser serialises
  `rgb(r g b / 0.85)` as `rgba(r, g, b, 0.85)`, so the comparison never matched and every tag's
  background was set again every frame. That one line cost about 270 ms per 10 seconds of movement.
- The presence scene was built twice per frame, once for the layer and once for the name tags.
  `claimEditorEditingIds()` returned a new empty array on every call, so nothing downstream could
  have detected an unchanged scene.
- The layer remapped every scene item and recomputed its colour on every frame. The name tags
  regrouped every peer's items and rebuilt their text and colours on every frame.
- `captureItems()` built new masks for an administrator's candidate plans and for the caterpillar
  demo on every call. The layer keys mask textures by identity, so those masks were decoded and
  uploaded again on every frame. The replay cannot show candidates or the demo, which need an
  administrator token and Wplace's territory map. The fix is covered by the capture-run test.

## Changes

- `presenceScene()` returns the same array until a source changes: the peers, the claims, this
  painter, the four visibility switches, the paint drawer, the claim editor, quick claims or the
  capture items. Peers change a few times a second; frames reuse the scene in between.
- `captureItems()` returns the same items, and so the same masks, until the run, the proposals,
  this painter's drafted pixels or the demo step changes.
- The presence layer maps a scene to drawable items once per scene. The name tags build each
  peer's tag once per scene.
- Name tags remember the text, colour and position they last wrote, and write only what changed.
  Stacking checks only the tags that share a chip's columns, which gives the same placement.

## Results

Three alternating pairs compare the base, `ff107137`, with this change rebased onto it.
Presence time per frame is the userscript's own `Presence overlay` and `Presence labels` task time
divided by rendered frames. Page task time is `Performance.getMetrics` `TaskDuration` over the
whole tab, including Wplace and template rendering.

| Pair | Scenario | Presence ms/frame, base → change | Name tags ms, base → change | Page task s, base → change |
| --- | --- | --- | --- | --- |
| 1 | Hover | 1.659 → 1.160 | 1005 → 498 | 8.850 → 8.238 |
| 2 | Hover | 1.659 → 0.506 | 1031 → 226 | 8.701 → 3.839 |
| 3 | Hover | 0.677 → 0.483 | 437 → 207 | 3.918 → 3.801 |
| 1 | Movement | 0.597 → 0.415 | 602 → 327 | 4.234 → 4.026 |
| 2 | Movement | 0.622 → 0.416 | 631 → 322 | 4.258 → 4.102 |
| 3 | Movement | 0.638 → 0.424 | 639 → 326 | 4.506 → 4.120 |
| 1 | Idle | 0.534 → 0.328 | 29 → 9 | 0.959 → 0.942 |
| 2 | Idle | 0.465 → 0.334 | 26 → 9 | 0.952 → 0.951 |
| 3 | Idle | 0.536 → 0.352 | 23 → 9 | 0.969 → 1.092 |

Movement presence time falls 32% and name-tag time 48%, with separate ranges, and page task
time falls in every pair (4.33 → 4.08 s on average). Idle presence time falls 34%. Whole-page idle
time does not change measurably.

Hover runs fall into two machine states, about 8.5 and 3.9 seconds of page task time, regardless
of build. Pairs 1 and 3 each ran both builds in the same state; presence time falls 30% and 29%.
Pair 2 crossed states, so its 70% reduction overstates the change. Name-tag time falls in all
three pairs.

Frame p95 stays at 8.0–8.4 ms on this 120 Hz display. Presence GPU time stays at about 1.7–2.5 ms
per frame: the fragment work for 64 overlapping viewports is unchanged. Each build had at most
one long task in a window: two hover windows of the base, and one hover and one idle window of
the change.

### Same output

- Both builds receive the same 42 messages in hover and 52 in movement, and send nothing.
- Mask uploads match within each pair. Hover uploads 720 masks in every run. Movement uploads
  889 or 969 depending on where the publish ticks fall, in both builds.
- Idle name tags are identical in all six runs, including the text and position of every tag.
- Screenshots match by eye: viewports, drafts, capture lines and tags. Two baseline runs differ
  from each other as much as a baseline differs from its candidate, because Wplace's own counters
  and countdown keep changing.

The [pre-rebase comparison](benchmarks/presence-event-scale-pre-rebase-2026-11-27.json.gz) on the
previous base shows the same movement and idle results. Its first hover pair crossed machine states
the other way.

## Not addressed

- Presence GPU time per frame. Each item is one draw call with its own uniforms, and 64 viewports
  cover most of the screen. Instancing or a cheaper shader would change more than this fix.
- The template overlay controls and template layers that render on every frame while peers glide.
  They are not presence code.
- This painter's own capture line still checks its 60 pixels against the native draft on every
  frame (about 5 ms per second). Drafts have no change signal to key a cache on.

## Evidence and validation

- [Accepted comparison](benchmarks/presence-event-scale-client-2026-11-27.json.gz): base bundle SHA-256
  `86501824fc9c785f…`, candidate `44691b68f1e96f79…`, workload `0eeffff08e72…`. Each run
  includes its profile, frame, GPU, memory, message and mask-upload data and its name tags.
- Two new tests drive the real presence client through a fake socket. One shows that a moved peer
  reaches the next scene and that frames between messages reuse it. The other shows the same for a
  capture run's lines as the drafted counts change. Both fail on the base and pass with the change.
- `pnpm exec biome check .`, `pnpm turbo run check` (15 tasks) and the shared (122), UI (70) and
  userscript (408) tests pass.
