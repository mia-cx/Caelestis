# #372 Profile and optimize live collaboration

## Summary
Attribute collaboration costs in exported profiles, reproduce representative workloads locally,
and optimize costs established by matched measurements.

## Acceptance criteria
- [ ] Profiles identify messages, state updates, rendering, labels, drawer work, and live paint workloads.
- [ ] Repeatable idle, painting, movement, and simultaneous-player baselines exist.
- [ ] Matched before/after frame, CPU, memory, and network evidence accompanies measured fixes.
- [ ] Live updates and interactions remain correct; disabled profiling stays cheap.

## TODOs
- [x] Add collaboration instrumentation with focused validation.
- [~] Capture a repeatable baseline in the actual userscript on Wplace.
- [ ] Optimize measured collaboration bottlenecks with focused behavior tests.
- [ ] Publish matched measurements and complete project validation before filing the PR.

## Notes
- Worktree and branch remain the supplied `t3code/7ab9ad7b`.
- Mia requires matched runs in the actual userscript on Wplace. Synthetic runs only support diagnosis.
- Built userscript now runs in a dedicated Chromium Wplace tab with isolated Caelestis settings writes, 92 loaded templates, and the real presence connection. Native temporary drafts must be cancelled, never submitted.
- Existing main-loop timing covers Presence viewport and Presence labels; nested timings must use detail to avoid double counting.
- Instrumentation validation: 80 focused tests across profile, presence, rendering, and live coordinator; userscript typecheck passes. Real Wplace exports now contain collaboration context and tasks.
