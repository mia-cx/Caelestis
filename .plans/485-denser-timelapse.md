# #485 Denser timelapses with time-stable playback

## Summary

Return the finest retained tile observations across the requested range. Advance playback by
recorded time, preserving the existing 350 ms per recorded hour at 1×.

## Acceptance criteria

- [ ] Sub-hour observations survive alongside older folded and imported history.
- [ ] Irregular timestamp gaps take proportional playback time, without timer drift.
- [ ] Play/pause, seeking, replay, saved speed, and lifecycle bounds still work.
- [ ] Focused regressions, affected package checks, and Chromium verification pass.

## TODOs

- [ ] Return mixed-density tile history by default, preserving explicit-resolution reads, with route regressions.
- [ ] Drive the viewer with elapsed recorded time and verify playback controls with focused tests.
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
