# #465 Raid performance, client and backend

## Summary

Implement the thirteen children #466–478 in one PR on the supplied branch. Keep each measured optimization independently reviewable and benchmark its actual base. An optimization without repeatable benefit is recorded as a no-change outcome rather than shipped as a claimed improvement.

## Acceptance criteria

- [ ] Reproducible isolated browser and backend raid workloads, exact provenance and raw evidence.
- [ ] At least three alternating baseline/candidate comparisons for every retained optimization.
- [ ] Preserve rendering, claims, ownership, expiry, events, accounting and recovery semantics.
- [ ] Focused tests and affected full repository checks pass.
- [ ] One non-draft PR, linked issues and Roadmap Ready after complete validation.

## TODOs

- [x] #466 Build isolated trusted-input Wplace benchmark coverage and presence GPU timing; capture baseline.
- [x] #467 Preserve unchanged claim geometry identity; test, benchmark and commit.
- [ ] #468 Reject hidden/offscreen presence geometry before expensive work; test, benchmark and commit.
- [ ] #469 Prepare connected components only after a pointer hits claimed pixels; test, benchmark and commit.
- [ ] #470 Measure remaining presence GPU cost and retain only proven rendering improvements.
- [ ] #471 Coalesce presence screen updates with the next map frame; test, benchmark and commit.
- [ ] #472 Share scene preparation within a host frame; test, benchmark and commit.
- [ ] #473 Measure and reduce label layout work without stale geometry; test, benchmark and commit.
- [ ] #474 Add deterministic measured-phase backend claim churn and baseline coverage.
- [ ] #475 Reduce repeated presence peer selection; test, benchmark and commit.
- [ ] #476 Reduce claim publication work; test, benchmark and commit.
- [ ] #477 Reduce repeated ownership/expiry database work; test, benchmark and commit.
- [ ] #478 Reduce tile-lane round trips if current measurements justify it; test, benchmark and commit.
- [ ] Run final validation, publish evidence, rebase, push and file one PR; mark completed issues Ready.

## Notes

- Initial base cb7e687115a2e86bd8e2124331a2b8c1bc883235; workspace clean, supplied branch t3code/profile-userscript-during-raid.
- PR #463 (claim union/deletion) and #449 (fenced jobs) remain open. Recheck before overlapping edits and final rebase.
- Browser CDP 9222 is available. Own benchmark tabs, preserve the user's existing injected tab. No production write workload.
- Local Docker and Bun are available. CNPG/S3 capacity acceptance needs an isolated authorized test environment; no live infrastructure mutation is implied.
- Each line above is independently committable. More than eight TODOs is intentional because each issue needs its own measured result.
- #466: complete built baseline runs on real Wplace. Hover captured 18.388 s whole-page task time/30 s; trusted drag/wheel smoke captured 3.787 s. These are diagnostic single runs, not optimization claims. Replay verifies 37 claims/10 peers and holds the pointer for 30 seconds. Dedicated tab is closed in finally; outgoing collaboration writes are intercepted. Existing user's tab remains open.
- Tooling validation: userscript typecheck passed; full userscript suite passed 137 files/1,582 tests. Happy DOM teardown logs AbortError from existing fetch teardown; no failed tests. Presence GPU instrumentation uses existing profileGpu query handling.
- #467: focused test failed on unchanged document identity before the fix; all 17 presence-client tests pass afterward. Three alternating baseline/candidate pairs completed on full Wplace builds, with 30-second hover and trusted movement each. Candidate eliminates repeated raster/component CPU and uploads. Whole-page CPU improves in every pair; GPU time does not consistently improve. Raw profiles are in docs/benchmarks/raid-467-2026-09-19.json.gz.
