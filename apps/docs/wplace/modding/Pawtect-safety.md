---
title: Pawtect safety
description: Which Wplace mod hooks can trip a Pawtect anti-cheat flag, which ones show up in its tokens, and which ones it never sees.
order: 3
tags: [source/caelestis, source/client]
---

Pawtect is Wplace's client-side anti-cheat. [Anti-cheat](Anti-cheat) explains what it collects. This page maps it onto each hook in this section, so you can see what your mod risks for its users.

Every hook note starts with a **Pawtect:** line and carries one of three tags:

- `pawtect/flag`: using the hook the wrong way can set a flag, or put a bad value in the token.
- `pawtect/visible`: the hook shows up in tokens, but sets no flag.
- `pawtect/none`: Pawtect does not see the hook.

## What Pawtect checks

| Check | Tripped by |
| --- | --- |
| Untrusted paint hold | A synthetic key or mouse event for paint-hold or erase-hold |
| Untrusted pointer | A synthetic pointer move while a paint-hold, erase-hold or drag-paint is active |
| Untrusted palette | A script click on a palette colour |
| Untrusted paint submit | A script click on the Paint button |
| Automated clicks | A synthetic `click`, `touchstart` or `pointerdown` on the map. Not a flag bit, but sent in every token. |
| Tampered response | An own `json` or `text` property on a response from Wplace's API client |
| Tampered profile limits | A `/me` profile claiming unlimited favourite locations |
| Automation globals | A global on `window` or `document` with a name automation tools use |
| Multi-account records | `ui_layout_v3`, `nav.cursor` and `_pf_uid`. Clearing them can look like dodging the check. |
| URL log | Every absolute URL fetched through `window.fetch` after Pawtect loads, up to 64, goes into the next token |

The flags stay set until the page reloads.

## Every hook

| Hook | Status | Why |
| --- | --- | --- |
| [Page context](Getting-into-page-context) | none | Where your code runs is invisible |
| [Page load timeline](Page-load-timeline) | visible | Pawtect wraps `fetch` during load |
| [map](Map) | none | Camera and layer calls are not checked. Synthetic map clicks are. |
| [Finding the map](Finding-the-map) | none | A short-lived `Object.prototype` setter |
| [Map sources and layers](Map-sources-and-layers) | none | Styles are not checked |
| [WplaceState](Wplace-state) | flag | `automatedClicks` and `captcha` are anti-cheat state. Never write them. |
| [fetch](Page-fetch) | visible | URLs are logged. Patching `json` or `text` on API responses sets Tampered response. |
| [Watching tiles](Watching-tiles) | none | Tile responses are not checked for tampering |
| [getContext](WebGL-context) | none | The map's context is not inspected |
| [CanvasRenderingContext2D](Draft-canvases) | none | Canvas writes are not watched |
| [Drawing overlays](Drawing-overlays) | none | Your own layers are not checked |
| [Layers versus tile compositing](Layers-versus-tile-compositing) | none | Tile responses are not checked; a layer touches none |
| [How Wplace renders the map](Map-rendering) | none | Render state is not in any token |
| [Palette](Palette) | none | Reading is safe. Script clicks on swatches are not. |
| [Alliance editors](Alliance-editors) | none | Reading the editors and drawing on your own canvas are not checked |
| [ServiceWorkerMessage](Service-worker-messages) | none | Worker messages are not in any token |
| [Live notifications](Live-notifications) | none | Not a `fetch`, not in any token |
| [MapUrlState](URL-parameters) | none | Read once on load |
| [Theme](Theme) | none | Not in any token |
| [Message catalog](Message-catalog) | none | Not in any token |
| [Keyboard input](Keyboard-input) | flag | Synthetic paint-hold keys set Untrusted paint hold |
| [Reading the paint UI](Reading-the-paint-UI) | flag | Script clicks on swatches or Paint set Untrusted palette or Untrusted paint submit |
| [DOM landmarks](DOM-landmarks) | flag | Reading is safe. Script clicks on paint controls or the map are not. |
| [Importing Wplace's modules](Importing-Wplace-modules) | visible | Fetching module sources adds `wplace.live` URLs to the log |
| [Storage keys](Storage-keys) | flag | The multi-account records |
| [Globals and page events](Globals-and-page-events) | flag | Automation global names |

## What Caelestis does

Caelestis is a worked example of a mod that stays read-only by default:

- Its hooks observe and return every native result unchanged ([`page-hooks.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/page-hooks.ts)).
- It shadows `arrayBuffer` and `blob` on tile responses only, never `json` or `text` ([Watching tiles](Watching-tiles)).
- It filters the player's real input but dispatches none by default. Each feature that would send input to Wplace's controls is off until the player turns it on, and its setting names the flag it trips ([`simulated-input.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/simulated-input.ts)).
- Its own server requests go out from the page, so its server's host can appear in Pawtect's URL log ([fetch](Page-fetch)).

## Related

- [Anti-cheat](Anti-cheat)
- [Modding Wplace](modding/index)
