# #456 feat(userscript): viewports step aside under the pointer like your own claims

## Summary
Your own claim fades its fill and stripes while the pointer is inside it. Do the same for every painter's viewport, browsing or painting. Outline stays; other painters' claims unchanged.

## Acceptance criteria
- [x] A hovered viewport fades its fill and pattern over the shared ramp; its outline stays.
- [x] The fade applies to every painter's viewport, not only your own.
- [x] Other painters' claims are unchanged.
- [x] Tests cover which items the labels publish as hovered.

## TODOs
- [x] Hover store holds layer item keys; labels publish claim keys and hovered viewport keys (a hovered draft counts as its viewport); the layer fades any hovered viewport as well as your own hovered claim.
- [x] Changeset, check, test, lint.

## Notes
- The layer keyed its hover ramps by item key already; only the store held bare region ids. It now holds item keys, so a hovered viewport and a hovered claim go through the same ramp.
- A draft is tagged instead of the viewport around it; the labels map `peer:<s>:draft` to `peer:<s>:viewport` when publishing, so painting inside your viewport still fades the viewport.
- Validation: `pnpm turbo check --filter=@caelestis/userscript` passes; presence label and layer suites 17 pass; biome clean on the four files. Full userscript suite 1572 pass, the same 10 pre-existing happy-dom `localStorage` failures as on main.
- Not verified in a browser: the GL fade path is the one own claims already use.
