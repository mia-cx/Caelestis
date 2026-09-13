# #372 Profile and optimize live collaboration

## Summary
Attribute collaboration costs in exported profiles, reproduce representative workloads locally,
and optimize costs established by matched measurements.

## Acceptance criteria
- [x] Profiles identify messages, state updates, rendering, labels, drawer work, and live paint workloads.
- [x] Repeatable idle, painting, movement, and simultaneous-player baselines exist.
- [x] Matched before/after frame, CPU, memory, and network evidence accompanies measured fixes.
- [x] Live updates and interactions remain correct; disabled profiling stays cheap.

## TODOs
- [x] Add collaboration instrumentation with focused validation.
- [x] Capture a repeatable baseline in the actual userscript on Wplace.
- [x] Optimize measured collaboration bottlenecks with focused behavior tests.
- [x] Publish matched measurements and complete project validation before filing the PR.

## Notes
- Worktree remains supplied; the harness renamed the branch to `t3code/profile-optimize-live-collaboration` during work.
- Mia requires matched runs in the actual userscript on Wplace. Synthetic runs only support diagnosis.
- Built userscript now runs in a dedicated Chromium Wplace tab with isolated Caelestis settings writes, 92 loaded templates, and the real presence connection. Native temporary drafts must be cancelled, never submitted.
- Existing main-loop timing covers Presence viewport and Presence labels; nested timings must use detail to avoid double counting.
- Instrumentation validation: 80 focused tests across profile, presence, rendering, and live coordinator; userscript typecheck passes. Real Wplace exports now contain collaboration context and tasks.
- Baseline completed in one real Wplace tab: idle, native drafting, map movement, and 64 replayed peers. Native draft notifications and received peer updates appear in the exported profile. No public paint submitted.
- Idle baseline: 536 ms label CPU over 7.2 seconds, including 351 ms clustering; 436 DOM width probes. At 110% browser zoom, 92 templates loaded, 19 claim shapes with 2,413,620 bounding pixels. Raw probe is `/tmp/372-one-tab-before.json`; matched repetitions follow in final validation.
- Mia requires one browser tab. Peer replay enters the actual WebSocket handler; do not reopen multiple Wplace tabs.
- Both focused regressions failed before the fix (2 clustering passes instead of 1; 4 layout reads instead of 1). All 13 label tests now pass, as do userscript typecheck and build. The cache keeps one cluster per claim and at most 128 measured strings; resize and font loading clear text widths.
- Rebased onto `2cd15009`, preserving the new rail state subscriptions and drawer profiling. Shared/UI builds, userscript typecheck/build, and 53 focused tests pass after the rebase. Earlier full package validation passed 239 shared and 145 UI tests; 1,477 userscript tests passed, with one unrelated watcher timeout that passed in isolation. Lint and all 37 release checks pass.
- Mia authorized closing the other Wplace tab and pausing its watcher. The watcher had already stopped. Closed its tab and used one fresh benchmark tab per build, keeping only one Wplace tab open throughout. The complete rebased build also passed all four scenarios on Wplace.
- Matched exports and measurements are in `docs/collaboration-performance.md` and `docs/benchmarks/372-wplace-*.json.gz`. Idle label CPU falls 79%; 64-peer label CPU falls 77%. Whole-page task duty falls 5.4% and 7.7%, respectively. Movement shows no whole-page gain; frame cadence remains about 60 FPS. Excluded server refresh / draft-count mismatches remain in raw exports. Painting has one matching pair, reported as such. Label text and transforms match; known collaboration buffers and matched payload sizes are unchanged.
