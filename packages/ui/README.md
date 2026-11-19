# @caelestis/ui

Svelte components shared by the userscript and the SvelteKit frontend. Lit is not part of the
package.

The package owns presentation, menus, dialogs, and DOM events. Hosts own auth, network requests,
loading orchestration, mutations, and page layout.

## Entries

- `.` exports the plain Svelte components and values the frontend imports.
- `./elements` is a browser bundle of native custom elements for the userscript, with each
  element's model and intent types; it includes its Svelte runtime, so the userscript build needs
  no Svelte plugin.
- `./studio` exports the template studio's plain data and functions: the default layout, the
  layout parser, the Ditherette option lists, and the studio types.
- `./theme` maps the `CaelestisThemeTokens` contract onto `--caelestis-*` custom properties.
- `./motion` opens and closes mounted surfaces with the shared transition tokens.
- `./pixel-grid.css` provides the FalseType font, the pixel unit, and stair corners.

## Custom elements

`elements/registry.ts` lists every element once: its tag, the properties a host sets, and the
intent it emits. `HTMLElementTagNameMap` and `HTMLElementEventMap` derive from that table, so
`document.createElement('caelestis-panel')` returns a typed element and
`addEventListener('caelestis-panel-intent', …)` receives a typed `CustomEvent`. Every element
emits its intents as one composed `${tag}-intent` event.

Two constraints are enforced by the implementation:

- **Shadow DOM is mandatory for custom elements.** These components mount inside Wplace's own DOM,
  which ships Tailwind and DaisyUI. Isolation prevents style collisions in both directions.
- **Registration is explicit and guarded.** Call `registerCaelestisUi()` from the `/elements` entry
  in a browser. It checks `customElements.get()` before each definition and is safe when a
  userscript is injected twice.

Host themes cross the Shadow DOM seam through documented `--caelestis-*` custom properties.
