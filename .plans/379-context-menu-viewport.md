# #379 Keep template context menus within the viewport

## Summary

Place the template context menu from its rendered size instead of a fixed height estimate, flip it above the pointer when the viewport ends before the menu does, and keep an open submenu beside its trigger while the parent menu scrolls or the window resizes.

## Acceptance criteria

- [ ] The whole menu fits inside the viewport with an 8px margin near the bottom and right edges.
- [ ] Long menus scroll internally; every action stays reachable.
- [ ] Placement uses rendered dimensions, so zoom, viewport size, and item count all work.
- [ ] Submenus stay visible and follow their trigger when the parent menu moves or scrolls.

## TODOs

- [ ] Replace the CSS clamp with a placement action that measures the rendered menu and flips upward when needed.
- [ ] Re-place open submenus on parent scroll and window resize.
- [ ] Cover placement with a focused test and record a userscript Changeset.

## Notes

- Symptom: `packages/ui/src/tree/TemplateTree.svelte` clamps `top` with `calc(100vh - 18rem)`; a menu taller than 18rem still overflows.
