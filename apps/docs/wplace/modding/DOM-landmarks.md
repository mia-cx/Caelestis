---
title: DOM landmarks
description: Stable ids, classes, labels and attributes for finding Wplace's map, buttons, dialogs, settings panels and palette in the page's markup.
order: 8
tags: [source/caelestis, source/client, pawtect/flag]
---

**Pawtect:** flag risk. Reading the DOM is invisible to Pawtect. Calling `.click()` or `dispatchEvent` on palette swatches or the Paint button sets a flag. On the map, a synthetic click, touch or pointer-down marks automated clicks in every later token. Clicking other controls from script is not checked ([Anti-cheat](Anti-cheat)).

Wplace's markup is Svelte with Tailwind and DaisyUI classes. Layout classes change often. Ids, ARIA attributes and the MapLibre classes change least. Everything below was seen on the live client on 26 November 2026 unless marked.

## Find controls by label, in the player's language

Most of Wplace's buttons have an `aria-label` or `title`, and those are translated. Look the text up in the [message catalog](Message-catalog) rather than matching English. Signed out, the page showed buttons labelled Info, Refresh, Settings, Favorite places, Log in, Leaderboard and Search.

## Landmarks

| Selector | What | Stability |
| --- | --- | --- |
| `div#map` | MapLibre's container | Stable |
| `canvas.maplibregl-canvas` | The map canvas. Exists only once the app has started. | MapLibre's class |
| `.maplibregl-canvas-container` | Holds the canvas, and catches map input | MapLibre's class |
| `.maplibregl-marker` | DOM markers, such as alliance headquarters pins | MapLibre's class |
| `h1#map-unsupported-title` | Shown instead of a map when WebGL is unavailable | Wplace id |
| `span.hidden` with text `Version: {build}` | The client build number | Wplace markup |
| `svg filter#wplace-colorblind` | The colour-blindness filter | Wplace id |
| `section[aria-label^="Notifications"]` | The toast region. Its label includes the shortcut, `alt+T`. | Toast library |
| `nav[aria-label="Wplace guides"]` | Skip links to the guide pages | Label is English only (unverified in other locales) |
| `div#svelte-announcer` | Svelte's route announcer | Svelte |

## Settings

The Settings dialog has tabs with ids `settings-tab-{id}` and panels with ids `settings-panel-{id}`, linked by `aria-controls`. Tab ids include `interface`, `accessibility`, `privacy` and `sounds`. The open tab is [WplaceState](Wplace-state) `playerSettingsTab`. Caelestis adds its own rows to `#settings-panel-accessibility` ([`wplace-settings.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-settings.ts)).

## Dialogs and the pixel card

Wplace's modals are native `<dialog>` elements. Use `dialog[open]` to find one: closed dialogs stay in the DOM. The alliance headquarters, picture and banner editors are dialogs too ([Alliance editors](Alliance-editors)). The card that opens when a player clicks a pixel is not a dialog. Its close control is a round button labelled with the catalog's `close` message.

## Page-wide attributes

`<html>` carries `data-theme`, `lang`, `data-game-ui` on game routes, `data-standard-ui` with Legacy UI on, and `data-native-cursor` with native cursors on ([Theme](Theme)).

## The paint controls

The palette, the paint drawer and the Paint button have their own note: [Reading the paint UI](Reading-the-paint-UI).

## Telling your nodes from Wplace's

A `MutationObserver` on the document sees your own changes too. Give your elements a common id or tag prefix, and skip records whose nodes are all yours. Caelestis uses `caelestis-` for ids and custom elements ([`wplace-dom.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-dom.ts)).

Observe the `document` node, not `document.body`, if you start at document start: `<body>` does not exist yet.

## Related

- [Message catalog](Message-catalog)
- [Reading the paint UI](Reading-the-paint-UI)
- [Theme](Theme)
