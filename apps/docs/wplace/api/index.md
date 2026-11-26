---
title: API reference
description: Every Wplace backend endpoint the web client calls, with auth, Pawtect use and rate limits.
order: 10
---

Wplace's backend lives at `https://backend.wplace.live`. This reference lists every endpoint the wplace.live web client calls, as of 26 November 2026, plus a few found elsewhere. Wplace publishes no API docs, and any of this can change without notice.

## Reading a page

Each page starts with two lines:

- **Pawtect** says whether the client sends an `x-pawtect-token` with the request, and whether a mod can trip a [[Anti-cheat|Pawtect flag]] through it. Tags: `pawtect/token`, `pawtect/flag`, `pawtect/none`.
- **Source** says how the endpoint is known. Tags: `source/client` (called by the current client), `source/bundle` (in the bundle, never called by the player UI), `source/community` (seen in community tools), `source/guess`, and `source/probe` (confirmed with an anonymous request).

Anything not confirmed live is marked **Unverified** on its page.

## Auth

Most reads need no account. Account endpoints use the `j` session cookie, which Wplace sets on `.wplace.live` at [[Sign-in|sign-in]]; a userscript running on wplace.live sends it with `credentials: 'include'`. Staff routes need a staff account.

Errors carry a small JSON body; see [[Error]].

## Limits

Every endpoint except map tiles shares one API [[Rate-limits|rate limit]] of about 80 requests per 16 seconds per IP address. Tiles have their own, higher limit.

## Contents

[[Discovered-routes|Discovered routes]] lists what Wplace's hosts answered to direct requests.

- [Pixels and tiles](pixels/): Read the canvas: tiles, single pixels, hotspots and the paint request.
- [Map, search and status](map/): The base map, place search, client version and backend health endpoints.
- [Leaderboards](leaderboards/): Player, alliance, country and region leaderboards for today, this week, this month and all time.
- [Alliances](alliances/): Public alliance data: the gallery, profiles, members, awards and headquarters.
- [My alliance](my-alliance/): Endpoints for the signed-in player's own alliance, from settings to templates.
- [My account](me/): The signed-in player's account, settings, profile, favourites and sign-in.
- [Notifications](notifications/): In-app notifications, their live stream, and browser push.
- [Store](store/): The droplet store: catalogue, offers, colours, flags, frames and name cosmetics.
- [Payments](payments/): Real-money checkouts through Stripe, FastSpring, Google Play and the App Store.
- [Reports and appeals](reports/): Report players and alliances, and appeal bans.
- [Support tickets](support/): The player side of Wplace support: open, read and reply to tickets.
- [Anti-cheat](anticheat/): The requests behind Wplace's challenges, listed so mods recognise them.
- [Google Drive](drive/): Link Google Drive to save and load templates.
- [Telemetry](telemetry/): Analytics pings the client sends on its own.
- [Models](models/): The JSON objects the endpoints return, field by field.
- [Staff routes](staff/): Staff-only routes found in the client bundle, listed so mod authors recognise them.
