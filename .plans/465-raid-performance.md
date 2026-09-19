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
- [x] #468 Reject hidden/offscreen presence geometry before expensive work; test, benchmark and commit.
- [x] #469 Prepare connected components only after a pointer hits claimed pixels; test, benchmark and commit.
- [ ] #470 Measure remaining presence GPU cost and retain only proven rendering improvements.
- [~] #471 Coalesce presence screen updates with the next map frame; test, benchmark and commit.
- [~] #472 Share scene preparation within a host frame; test, benchmark and commit.
- [~] #473 Measure and reduce label layout work without stale geometry; test, benchmark and commit.
- [~] #474 Add deterministic measured-phase backend claim churn and baseline coverage.
- [~] #475 Reduce repeated presence peer selection; test, benchmark and commit.
- [~] #476 Reduce claim publication work; test, benchmark and commit.
- [~] #477 Reduce repeated ownership/expiry database work; test, benchmark and commit.
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
- Benchmark audit invalidated #467 pair 2 (candidate had only 3 templates, baseline 97). The reported averages are withdrawn pending a controlled rerun. #468 movement samples also stretched under driver load, so those are diagnostic only. Add template signature/count and absolute input-deadline checks before acceptance. #467 implementation commit remains, with validation reopened.
- Browser interruptions and heavy unrelated Mac load delayed acceptance. Three guarded hover pairs retain 97 identical templates and eliminate repeated raster/component work, but whole-page results remain inconclusive. Fresh 10-second hover plus 12-second movement pairs are running. Performance.getMetrics TaskDuration is main-thread elapsed task time, not process CPU time.
- Prepared independent client candidates for #468/#469/#471/#472/#473 while browser measurements were unavailable. Their commits remain pending independent benchmarks. Focused tests pass except a new scene test's incorrect immediate-hide expectation; corrected it to preserve the fade, rerun pending.
- Devbox isolated clone /home/mia/Caelestis-raid-465 at cb7e687. Three strict 256-user stable baselines pass each on Node 22.23.2 and Bun 1.4.2 using production Node host/PG18/filesystem. Node CPU 8.381–8.437 s/60 s; Bun 8.580–8.834 s. No CNPG/S3 claim.
- #474 adds deterministic complex claim churn, per-event bytes, measured-phase timing resets, ownership/convergence checks and reconnects. Three pre-reconnect 256-user raid baselines pass each runtime (Node CPU 13.970–14.360 s; Bun 12.519–12.605 s). Reconnect delivery checks initially compared JSON property order; changed to structural equality. Corrected Node smoke passes; Bun running.
- Backend candidates are prepared, not accepted: #475 allocation-light selection and heartbeat skips; #476 shared serialization plus exact snapshot/ownership deduplication; #477 one indexed expiry sweep with legacy-null renewal compatibility. Baselines use frozen compiled directories and SHA256 provenance. A mistakenly concurrent baseline copy contained the candidate; detected and rebuilt before any comparison used it.
- PR #463 advanced to 70330d52 and remains open; #449 remains open at 794322ae. Main still cb7e687 at latest check.
- #467 accepted final comparison: three matched pairs with 10-second hover and 12-second trusted movement. Repeated raster/component task time falls to zero in all six candidate samples. Movement task time improves 16.3% on average, in every pair; hover frame p95 improves to 17.4–17.5 ms. Hover total task time and GPU time do not consistently improve. Raw final profiles and both earlier diagnostic sets retained in docs/benchmarks.
- #468 accepted memory result: 725,200 to 19,600 GPU-mask bytes in every one of three alternating hover/movement pairs (97.3%). CPU/GPU time inconclusive; claim/holes/hover screenshots inspected. Focused tests now pass 71/71, including corrected scene-fade expectation. CPU region/component caches remain for #469.
- #469 three alternating cold-hover/movement/idle pairs pass workload guards. Cold component CPU 137.6/40.7/35.7 to 3.3/7.4/8.0 ms; first label 191.9/70.1/69.8 to 16.1/55.3/49.0 ms. Component and CPU mask memory fall 97.3%. Whole-page time inconclusive. Focused test covers bounds, gaps, holes, first hit, changed geometry and deletion.
