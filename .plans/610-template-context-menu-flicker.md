# #610 fix(userscript): template context menu flickers while open

## Summary
An open template context menu replays its entrance (briefly hidden, then fades in again) whenever the
panel model is replaced, e.g. by a template progress refresh. The menu should stay visible, focused and
keep an open submenu across unrelated refreshes, while normal open, dismissal and mid-exit reopen keep
animating.

## Acceptance criteria
- [x] Repeated tree refreshes through `caelestis-panel.model` never hide an open menu or restart its entrance.
- [x] The same menu node keeps keyboard focus and an open submenu across those refreshes.
- [x] Normal opening, dismissal and rapid reopen during the exit animation still work.

## TODOs
- [x] Reproduce in Chromium through the real `caelestis-panel` boundary: refreshes of an open menu fail on base.
- [x] Make `openSurface` a no-op for a surface that is already open or already opening.
- [x] Add a fast-suite `caelestis-panel` regression for refreshes of an open menu.
- [x] Add the userscript Changeset.
- [x] Focus the menu once it is visible (found while reproducing), with its own Changeset.
- [x] Repair the stale browser surface contract and keep the refresh regression in it.
- [x] Capture before/after motion evidence and run the affected checks.

## Notes
- Confirmed root cause: `TemplateTree`'s context-menu effect reruns on every `model` replacement and calls
  `driveSurface` → `openSurface`, which hides the element, disables transitions, drops `data-state` and
  reopens it over the next frames. Base Chromium run: 15 hide/state-loss mutations over 5 refreshes;
  demo samples 20 hidden/state-loss and 174 of 266 frames below full opacity; after the fix none hidden and
  none below full opacity during refreshes (14 samples are the initial entrance tail).
- The real userscript keeps one `contextMenu` object (stable id) in `application/tree-actions.ts` and
  `rerenderTree` replaces `panel.model`, so the fixture's "spread tree, keep contextMenu" refresh matches it.
- The progress pane goes through the same `driveSurface` path and benefits from the same fix.
- `openSurface` callers in `panel.ts`, `overlay-menu.ts` and `claim-editor.ts` pass fresh elements or ones
  whose close was just cancelled (no `data-state`), so none relies on a replay.
- Since `openSurface` holds a fresh surface `visibility:hidden` for a couple of frames, the menu's
  `tick()`-deferred focus landed on a hidden element and was dropped. Focus now waits for `data-state="open"`.
- `pnpm test:browser` was already failing at base: the host transform moved to `.pane`, `settled()` raced
  the delayed open, the popout row lookup hit the leaving docked copy, and the popout dialog exits by
  WAAPI morph, not an opacity transition.
- No GitHub Project covers Caelestis (Linear-linked); status tracking skipped.
