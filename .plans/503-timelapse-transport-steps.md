# #503 Timelapse playback crawls at several seconds per frame after dense history

## Summary

The transport slider passes recorded seconds to bits-ui with a step of one second. bits-ui
materialises every step between min and max on each value change and on every tick render, so a
week-old template allocates hundreds of thousands of step entries sixty times a second while
playing. Desktop stalls for seconds between frames; iOS Safari runs out of memory and shows
"A problem repeatedly occurred" on the template page.

## Acceptance criteria

- [x] The transport slider never builds a step list proportional to the recorded range.
- [x] Playing a week of dense history keeps recorded time advancing at 350 ms per hour at 1×.
- [x] Seeking through the slider, keyboard, and chart still lands on exact recorded seconds, and the
      live stop still reports live.
- [x] Focused tests cover the bounded transport scale and the page's use of it.

## TODOs

- [x] Add a bounded transport scale to `$lib/timelapse` with exact endpoints, plus unit tests.
- [x] Drive the transport slider through the bounded scale and update the page regressions.
- [x] Add a frontend Changeset and run lint, check, tests, and build.

## Notes

- Issue #503 is In Progress on the Roadmap project. The branch is clean on main.
- bits-ui 2.19 `normalizeSteps(step, min, max)` runs inside a `watch` on value changes and inside
  `ticksPropsArr`, which the Root reads for every snippet render. Both scale with (max - min) / step.
- Thumb props override caller aria values, so the page exposes recorded time through
  `aria-valuetext` and a `data-playhead` attribute for tests instead of `aria-valuenow`.
- The main checkout holds an uncommitted competing fix from another session: a native range input
  in place of the shared Slider, with its own Changeset. Mia asked for the fix in this worktree.
- Node 26 defines an undefined `localStorage` global that happy-dom does not replace, so the page
  tests fail locally on main as well. Running vitest with `NODE_OPTIONS=--localstorage-file=<path>`
  restores it; CI runs Node 22 and 24.
- Validation: 218 frontend tests pass, svelte-check reports no errors, biome passes on the changed
  files. The only repo lint warning is a pre-existing regex in the release workflow test.
