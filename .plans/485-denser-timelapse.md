# #485 Denser timelapses with time-stable playback

## Summary

Return the finest retained tile observations across the requested range. Advance playback by
recorded time, preserving the existing 350 ms per recorded hour at 1×.

## Acceptance criteria

- [ ] Sub-hour observations survive alongside older folded and imported history.
- [ ] Irregular timestamp gaps take proportional playback time, without timer drift.
- [ ] Transport distance and seeking represent elapsed time, with a steadily moving playhead.
- [ ] The progress & pace graph shares the playhead and can seek the timelapse in both directions.
- [ ] Play/pause, seeking, replay, saved speed, and lifecycle bounds still work.
- [ ] Focused regressions, affected package checks, and Chromium verification pass.

## TODOs

- [x] Return mixed-density tile history by default, preserving explicit-resolution reads, with route regressions.
- [x] Drive the viewer with elapsed recorded time and verify playback controls with focused tests.
- [x] Map the transport to recorded time and verify continuous motion through sparse holds.
- [ ] Link the progress & pace graph to timelapse playback and scrubbing, with focused interaction tests.
- [ ] Add release notes, validate the affected packages and browser flow, and file the PR.

## Notes

- Roadmap issue #485 is In Progress. The supplied branch is clean.
- The default history query currently coalesces every observation to one tier chosen for the entire range.
- The viewer currently advances one frame every 350 / speed milliseconds.
- This is a direct feature change at two explicit policy points. Skip speculative diagnosis phases;
  demonstrate lost sub-hour observations with the route regression before changing the query.
- Keep explicit numeric resolution reads compatible. Mixed default responses omit the optional
  resolution field because their bucket widths differ. Prefer finer history where tiers overlap.
- Run isolated local services for verification. No production reads, writes, or deployment.
- The route regression failed before the change: two raw frames 60 seconds apart became one daily
  frame. All 20 telemetry read-route tests pass after the change, including mixed tiers and overlaps.
- Four mounted-page regressions and ten clock tests pass. They cover sub-hour deadlines, every
  speed range, partial-frame pause/resume, speed changes, seek, replay, empty input, finished bounds,
  and late callbacks. Replaced spread-based minimum lookup to support large preserved histories.
- Mia extended the scope to the transport: use a recorded-time axis, seek between observations,
  and update the playhead through long holds without redrawing unchanged tile selections.
- Mia requested graph synchronization delegated to Claude fable-5.1. Claude Code uses model
  `claude-fable-5-1`; it owns chart/StatsPanel/template-page integration and focused tests.
- Full `pnpm test` hits an existing runtime-test migration parser failure: the unchanged
  scripts/live-paint-runtime.test.mjs splits migration 0028's CREATE TRIGGER at its inner semicolon.
  Package tests are being run separately; no migration or unrelated test-runner changes in this PR.
- Time-based transport passes 16 focused tests and Chromium pixel/position checks. Equal pointer
  distances select equal recorded intervals; the playhead advances through holds. Forwarded labels
  and formatted time to the actual slider thumb after Chromium exposed missing accessible names.
- Backend suite: 885 passed, 15 skipped. Userscript suite: 1601 passed, two timing failures; both
  failing files passed independently (132 tests). Shared/UI/storage/wire package suites passed.
