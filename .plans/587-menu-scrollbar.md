# #587 fix(userscript): opening the main menu adds a 1px page scrollbar

## Summary
Opening the Caelestis main menu (the docked `caelestis-panel`) makes the page scroll by 1px. Find the
element that adds the extra height, fix its geometry, and lock it down with a browser test.

## Acceptance criteria
- [x] The overflowing element is named and its geometry fixed, without `overflow: hidden` on `html` or `body`.
- [x] With the menu open, `html.scrollHeight === innerHeight` at 90%, 100% and 110% zoom. `body.scrollHeight <= innerHeight` holds except where rounding alone adds 1px (see Notes).
- [x] A browser test covers the open menu.
- [x] Release note: the pending `.changeset/notification-announcement-overflow.md` already covers the userscript fix.

## TODOs
- [x] Reproduce in Chromium at 90/100/110% and name the overflowing element
- [x] Fix the element's geometry (already on main: 6c14757e)
- [x] Browser test: open menu leaves page scroll height unchanged
  (`pnpm test:browser`: red without the `inset` line with html 436 / innerHeight 435, green with it)

## Notes
- Cause: opening the menu calls `syncToastPlacement`, which appends `<caelestis-notifications>` to
  `body`. Its two `.sr-only` live regions are `position: absolute` with no insets, so their static
  position is just below Wplace's 100vh map: `html.scrollHeight` becomes `innerHeight + 1`. The host
  stays mounted, so in 0.15.0 the scrollbar also stays after the menu closes.
- 6c14757e (`fix(ui): keep hidden announcements inside the viewport`, after `userscript-v0.15.0`)
  anchors `.sr-only` with `inset: 0 auto auto 0`. Its pending Changeset targets the userscript.
- Logged in, menu open, heights 600–1000 DIP step 7: released 0.15.0 overflows at 58/58 heights at
  90%, 100% and 110%. Main overflows at 0/58 at each zoom.
- At 90%, main's `body.scrollHeight` is `innerHeight + 1` at 25/58 heights (e.g. viewport 666.667px:
  innerHeight 666, body 667) with `html.scrollHeight === innerHeight` and no scrolling. The body's
  fractional 100vh content rounds up while innerHeight floors. It also happens with the menu closed.
- Harness: isolated Chromium (`~/.caelestis-chromium-qa`, CDP 9587, launched with `open -g -na`;
  `extension-mime-request-handling@2` and developer mode match Mia's main profile), wplace.live
  zoom pinned through `partition.per_host_zoom_levels`, CDP bridge in tmux session `c587`.
