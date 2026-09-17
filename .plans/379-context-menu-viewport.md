# #379 Keep template context menus within the viewport

## Summary

Place the template context menu from its rendered size instead of a fixed height estimate, flip it above the pointer when the viewport ends before the menu does, and keep an open submenu beside its trigger while the parent menu scrolls or the window resizes.

## Acceptance criteria

- [x] The whole menu fits inside the viewport with an 8px margin near the bottom and right edges.
- [x] Long menus scroll internally; every action stays reachable.
- [x] Placement uses rendered dimensions, so zoom, viewport size, and item count all work.
- [x] Submenus stay visible and follow their trigger when the parent menu moves or scrolls.

## TODOs

- [x] Replace the CSS clamp with a placement action that measures the rendered menu and flips upward when needed, and re-place open submenus on parent scroll and window resize.
- [x] Cover placement with a focused test and record a userscript Changeset.

## Notes

- Symptom: `packages/ui/src/tree/TemplateTree.svelte` clamped `top` with `calc(100vh - 18rem)`; a menu taller than 18rem still overflowed.
- The action sets `max-block-size` from `innerHeight` so the menu scrolls instead of overflowing on short viewports; happy-dom lacks `hidePopover`, so the test stubs it for the sort menu's resize handler.
- Validation: `vitest run tests/tree.test.ts` passes 31 tests; `svelte-check` reports 0 errors.
