---
title: Reading the paint UI
description: Tell whether a player is painting, which colour they selected, and what Wplace accepted, from the palette, paint drawer and paint requests.
order: 7
tags: [source/caelestis, pawtect/flag]
---

**Pawtect:** flag risk. Reading the palette and observing paint requests sets nothing. A script click on a palette colour sets **Untrusted palette**, and on the Paint button **Untrusted paint submit**. Leave every paint control to the player ([Anti-cheat](Anti-cheat)).

Wplace exposes no state for its paint drawer, palette or tools, so mods read them from the DOM. The drawer exists only while a signed-in player has Paint open, so none of this was seen on the live client on 26 November 2026 (signed out). The selectors below come from the live client's code and from Caelestis.

## Is Paint open?

The palette swatches are in the document only while the drawer is open. Their presence is the signal.

```ts
const swatches = () => [...document.querySelectorAll<HTMLElement>('[id^="color-"]')]
const isPaintOpen = () => swatches().length > 0
```

Svelte mounts and unmounts the drawer without navigation. Watch with a `MutationObserver` on `document` (`childList`, `subtree`, and the `class` and `aria-pressed` attributes), and read at most once per animation frame. Caelestis does this in [`wplace-paint.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-paint.ts).

## The palette

| Selector | What |
| --- | --- |
| `[id^="color-"]` | A world palette swatch. `color-{N}` is Wplace's palette index. Its `aria-label` is the translated colour name, and its inline style holds the RGB. |
| `.ring-primary` on a swatch | The selected world colour |
| `button.game-color-swatch[aria-pressed]` | A swatch in an alliance editor (headquarters, avatar, banner). No id. `aria-pressed="true"` is the selected one. |

Palette index 0 is Transparent. Caelestis's own palette indices are Wplace's minus one ([`wplace-dom.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-dom.ts)).

Decorating swatches, for example with a count of pixels left, is safe as long as you don't change their ids or labels' meaning. Caelestis adds counts to swatch labels and restores the originals ([`palette-decoration.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/palette-decoration.ts)).

## The drawer

The drawer is the smallest ancestor of the swatches that holds Undo and Redo buttons. Find those by their translated labels, `undo` and `redo` in the [message catalog](Message-catalog). The drawer's Close button discards the draft. Its Paint button reads `Paint`, or `Paint (0:25)` with a countdown while charges refill.

When the drawer is closed, the bottom-centre dock holds a `button.btn-primary.btn-lg` that opens Paint. For a new signed-out visitor on 26 November 2026, that same dock button read "What is Wplace?" instead.

## The draft

The player's unsent pixels are readable from the [service worker messages](Service-worker-messages) and from the [draft canvases](Draft-canvases).

## What the server accepted

When the player presses Paint, the page sends [`POST /paint`](api/pixels/Paint-pixels) to `https://backend.wplace.live`, with a Pawtect token. A [fetch](Page-fetch) observer can read the response: `painted` is the number of pixels the server accepted. Read the request body from a clone if you need which pixels were sent, and wait for the response before treating them as painted.

Never modify, delay, replay or send this request yourself. The token is tied to the exact body, and a mod that sends paints is painting for the player. Caelestis observes only accepted paints, to update its template progress ([`paint-requests.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/paint-requests.ts)).

## Tools

The colour picker and eraser are buttons labelled `color_picker` and `eraser` in the catalog. The active tool has `btn-primary` or `aria-pressed="true"`. The picker's icon path starts with `M120-120v-190` (or `M3 21h2v2H1v-4h2v2Z` in Legacy UI). Both paths are in the live client.

## Related

- [Keyboard input](Keyboard-input)
- [DOM landmarks](DOM-landmarks)
- [Pawtect safety](Pawtect-safety)
