---
title: Modding Wplace
description: Every place in the wplace.live web client that a mod, userscript or browser extension can hook into, and where to start.
order: 1
tags: [source/caelestis, source/client]
---

This section maps the wplace.live web client for mod authors. It covers the map, the page's requests, the WebGL canvas, the service worker, the DOM, storage, the URL and the page's globals. Each hook has its own note, with how to reach it, when it appears, what it gives you, and how likely it is to break.

It was checked against the live client on 26 November 2026 (build `1795650326331`, shown in a hidden `Version:` span in the page) and against a copy of the client from 20 November 2026. [Caelestis](https://github.com/mia-cx/Caelestis), an open-source overlay and template mod, is the worked example: notes tagged `source/caelestis` describe hooks it uses, and notes tagged `source/client` describe hooks found only in the client.

Wplace does not offer a mod API. Every hook here reads or wraps code Wplace wrote for itself, and any release can move it. Minified names change with every build, so these notes never rely on them.

## Start here

1. [Getting into page context](Getting-into-page-context): where your script has to run to see Wplace's objects.
2. [Page load timeline](Page-load-timeline): when each hook appears, in milliseconds after document start.
3. [Pawtect safety](Pawtect-safety): which hooks Wplace's anti-cheat can see, and which ones flag your users.

## Guides

| I want to… | Read |
| --- | --- |
| Get the MapLibre map | [Finding the map](Finding-the-map) |
| Turn a place into a tile and pixel | [Coordinates](Coordinates) |
| Know when tiles load or change | [Watching tiles](Watching-tiles) |
| Draw my own layer on the map | [Drawing overlays](Drawing-overlays) |
| Know what the player is painting with | [Reading the paint UI](Reading-the-paint-UI) |
| Find a button, panel or dialog | [DOM landmarks](DOM-landmarks) |
| Use Wplace's own code from my mod | [Importing Wplace's modules](Importing-Wplace-modules) |
| Know what Wplace keeps in the browser | [Storage keys](Storage-keys) |
| Know which globals are safe to add | [Globals and page events](Globals-and-page-events) |

## Reference

| Hook | Note |
| --- | --- |
| The MapLibre map instance | [map](Map) |
| The map's sources and layers | [Map sources and layers](Map-sources-and-layers) |
| Wplace's app-wide state object | [WplaceState](Wplace-state) |
| The page's `fetch` and its wrappers | [fetch](Page-fetch) |
| The map's WebGL context | [getContext](WebGL-context) |
| Draft canvases | [CanvasRenderingContext2D](Draft-canvases) |
| Service worker messages | [ServiceWorkerMessage](Service-worker-messages) |
| Live notifications | [Live notifications](Live-notifications) |
| Map position in the URL | [MapUrlState](URL-parameters) |
| Light and dark theme | [Theme](Theme) |
| Language and translations | [Message catalog](Message-catalog) |
| Keyboard shortcuts and the paint key | [Keyboard input](Keyboard-input) |

## Ground rules

Read Wplace's state, draw on your own layers, and leave the player's input to the player. A mod that paints for the player, or sends input to Wplace's paint controls, breaks Wplace's rules and gets its users flagged. [Anti-cheat](Anti-cheat) lists what Wplace checks.
