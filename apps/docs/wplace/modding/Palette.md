---
title: Palette
description: Wplace's 64 colour ids, their RGB values, which are free or premium, and how tile PNGs, swatches and paint requests encode them.
tags: [source/caelestis, source/client, pawtect/none]
---

**Pawtect:** none. Reading the palette sets nothing. Clicking a swatch from script sets **Untrusted palette** ([Reading the paint UI](Reading-the-paint-UI)).

Wplace paints with 64 colours. A colour's id is its position in the client's palette array. Read from the client config in chunk `BcgqpPa1.js` on 26 November 2026, and cross-checked against Caelestis's palette ([`palette.ts`](https://github.com/mia-cx/Caelestis/blob/main/packages/shared/src/palette.ts)).

## Where the id appears

| Place | Encoding |
| --- | --- |
| [Paint requests](api/models/Paint-request) | `colors` holds ids |
| World palette swatches | `id="color-{id}"` ([Reading the paint UI](Reading-the-paint-UI)) |
| `extraColorsBitmap` on [`/me`](api/models/Me) | Bit `id - 32` is set when the player owns premium colour `id` |
| Tile PNGs | Not the id. See [Tile PNGs](#tile-pngs). |

The client's ownership test is `id < 32 || (extraColorsBitmap & (1 << (id - 32))) !== 0`. Ids 1 to 31 are free. Ids 32 to 63 are premium.

## Transparent

Id 0 is Transparent. The player can paint it, which erases a pixel. Its RGB is `#000000`, the same as Black, so tell them apart by alpha: Transparent is fully transparent, and every other colour is opaque.

On a [draft canvas](Draft-canvases), a pixel drafted as Transparent writes alpha 0, which looks exactly like no draft. Caelestis notices these only because Wplace's crosshair marks them.

## The colours

| Id | Name | RGB | Kind |
| --- | --- | --- | --- |
| 0 | Transparent | `#000000` | — |
| 1 | Black | `#000000` | free |
| 2 | Dark Gray | `#3C3C3C` | free |
| 3 | Gray | `#787878` | free |
| 4 | Light Gray | `#D2D2D2` | free |
| 5 | White | `#FFFFFF` | free |
| 6 | Deep Red | `#600018` | free |
| 7 | Red | `#ED1C24` | free |
| 8 | Orange | `#FF7F27` | free |
| 9 | Gold | `#F6AA09` | free |
| 10 | Yellow | `#F9DD3B` | free |
| 11 | Light Yellow | `#FFFABC` | free |
| 12 | Dark Green | `#0EB968` | free |
| 13 | Green | `#13E67B` | free |
| 14 | Light Green | `#87FF5E` | free |
| 15 | Dark Teal | `#0C816E` | free |
| 16 | Teal | `#10AEA6` | free |
| 17 | Light Teal | `#13E1BE` | free |
| 18 | Dark Blue | `#28509E` | free |
| 19 | Blue | `#4093E4` | free |
| 20 | Cyan | `#60F7F2` | free |
| 21 | Indigo | `#6B50F6` | free |
| 22 | Light Indigo | `#99B1FB` | free |
| 23 | Dark Purple | `#780C99` | free |
| 24 | Purple | `#AA38B9` | free |
| 25 | Light Purple | `#E09FF9` | free |
| 26 | Dark Pink | `#CB007A` | free |
| 27 | Pink | `#EC1F80` | free |
| 28 | Light Pink | `#F38DA9` | free |
| 29 | Dark Brown | `#684634` | free |
| 30 | Brown | `#95682A` | free |
| 31 | Beige | `#F8B277` | free |
| 32 | Medium Gray | `#AAAAAA` | premium |
| 33 | Dark Red | `#A50E1E` | premium |
| 34 | Light Red | `#FA8072` | premium |
| 35 | Dark Orange | `#E45C1A` | premium |
| 36 | Light Tan | `#D6B594` | premium |
| 37 | Dark Goldenrod | `#9C8431` | premium |
| 38 | Goldenrod | `#C5AD31` | premium |
| 39 | Light Goldenrod | `#E8D45F` | premium |
| 40 | Dark Olive | `#4A6B3A` | premium |
| 41 | Olive | `#5A944A` | premium |
| 42 | Light Olive | `#84C573` | premium |
| 43 | Dark Cyan | `#0F799F` | premium |
| 44 | Light Cyan | `#BBFAF2` | premium |
| 45 | Light Blue | `#7DC7FF` | premium |
| 46 | Dark Indigo | `#4D31B8` | premium |
| 47 | Dark Slate Blue | `#4A4284` | premium |
| 48 | Slate Blue | `#7A71C4` | premium |
| 49 | Light Slate Blue | `#B5AEF1` | premium |
| 50 | Light Brown | `#DBA463` | premium |
| 51 | Dark Beige | `#D18051` | premium |
| 52 | Light Beige | `#FFC5A5` | premium |
| 53 | Dark Peach | `#9B5249` | premium |
| 54 | Peach | `#D18078` | premium |
| 55 | Light Peach | `#FAB6A4` | premium |
| 56 | Dark Tan | `#7B6352` | premium |
| 57 | Tan | `#9C846B` | premium |
| 58 | Dark Slate | `#333941` | premium |
| 59 | Slate | `#6D758D` | premium |
| 60 | Light Slate | `#B3B9D1` | premium |
| 61 | Dark Stone | `#6D643F` | premium |
| 62 | Stone | `#948C6B` | premium |
| 63 | Light Stone | `#CDC59E` | premium |

Read the palette from the client rather than copying it from another tool. Caelestis twice took a palette from elsewhere. One copy had 31 colours at the wrong ids and Teal as `#10AE82`. The other was rebuilt from a template's pixels, with colours off by 1 or 2 and ten missing. Both looked right on screen, because a wrong table still round-trips.

## Tile PNGs

Tiles are indexed PNGs, but each tile carries its own palette. Its indices are not colour ids. Checked on 26 November 2026:

| Tile content | PNG |
| --- | --- |
| One colour | 1-bit, 2 palette entries |
| A few colours | 4-bit, 11 entries in one sample |
| Many colours | 8-bit, 64 entries |

A `tRNS` chunk marks the transparent entry. It is usually entry 0, but not always: one busy tile had opaque black at entry 0 and transparent at entry 1. Decode to RGBA and match by RGB, with alpha 0 as unpainted. A decoder that only handles 8-bit PNGs fails on every sparse tile. Caelestis's backend did, until it learned 1-, 2- and 4-bit tiles ([#882](https://github.com/mia-cx/Caelestis/issues/882)).

No two colours share both red and blue. A 65,536-entry table keyed by red and blue, with green stored for checking, finds any colour exactly in 256 KiB ([`rgb-index.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/rgb-index.ts)).

## Canvas noise

Some browsers add noise to canvas readback as fingerprinting protection. In Helium, every `getImageData` came back a little off the palette, so exact matching found nothing (Caelestis, October 2026). Match to the nearest colour instead, or allow a small per-channel tolerance. Caelestis allows ±2 on each channel. A PNG decoder that does not use a canvas avoids the problem.

## Related

- [Reading the paint UI](Reading-the-paint-UI)
- [Watching tiles](Watching-tiles)
- [Layers versus tile compositing](Layers-versus-tile-compositing)
