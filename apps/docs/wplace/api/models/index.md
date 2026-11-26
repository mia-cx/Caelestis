---
title: Models
description: The JSON objects the endpoints return, field by field.
order: 20
---

Shared response shapes. Example values are placeholders.

- [[Error|Error]]: The JSON error body Wplace returns with most 4xx responses.
- [[Name-cosmetic|Name cosmetic]]: The font and style a player has equipped on their display name.
- [[Painter|Painter]]: The player who last painted a pixel, as the pixel endpoint returns them.
- [[Region|Region]]: A named map region, such as a city district, used by pixels and region leaderboards.
- [[Pixel-info|Pixel info]]: The painter and region of one pixel, as returned by the pixel lookup.
- [[Hotspot|Hotspot]]: One of the busiest map regions right now, with a coordinate and pixel count.
- [[Random-tile|Random tile]]: A tile and pixel the client jumps to when a player asks for a random place.
- [[Player-leaderboard-entry|Player leaderboard entry]]: One player row on a player leaderboard, with pixel count and profile fields.
- [[Alliance-leaderboard-entry|Alliance leaderboard entry]]: One alliance row on an alliance leaderboard, with its pixel count.
- [[Country-leaderboard-entry|Country leaderboard entry]]: One country row on the country leaderboard: a country id and its pixel count.
- [[Region-leaderboard-entry|Region leaderboard entry]]: One region row on the region leaderboard, with pixel count and last painted spot.
- [[Player-regions-page|Player regions page]]: A page of regions in one country, for the region filter on the player leaderboard.
- [[Featured-award|Featured award]]: An award an alliance pins to its profile, as a key and tier.
- [[Alliance-summary|Alliance summary]]: The short alliance card shown in the alliance gallery.
- [[Alliance-gallery-page|Alliance gallery page]]: One page of the public alliance gallery, 20 alliances at a time.
- [[Alliance-profile|Alliance profile]]: An alliance's public profile: name, description, members, awards and headquarters.
- [[Alliance-member|Alliance member]]: One member in an alliance's public member list, with their role.
- [[Alliance-members-page|Alliance members page]]: One page of an alliance's public member list, 50 members at a time.
- [[Alliance-award|Alliance award]]: One alliance award with its current tier, progress and tier thresholds.
- [[Alliance-awards-page|Alliance awards page]]: One page of an alliance's awards, with how many it has earned.
- [[Headquarters|Headquarters]]: An alliance headquarters: its anchor on the map, its canvas bounds and visibility.
- [[Headquarters-manifest|Headquarters manifest]]: The list of a headquarters canvas's tiles, each with a URL and version.
- [[Headquarters-pin|Headquarters pin]]: An alliance headquarters marker on the world map.
- [[Health|Health]]: The backend health check body.
- [[App-version|App version]]: The build version of the wplace.live web app, which the client polls to prompt a reload.
- [[Paint-request|Paint request]]: The body the client sends to paint pixels: colours grouped by season and tile.
- [[Store-catalog|Store catalog]]: The store's product list: droplet packs, bundles and their prices.
- [[Store-offers|Store offers]]: Current store promotions and per-provider prices, keyed by product id.
- [[Me|Me]]: The signed-in player's account: charges, droplets, owned colours and profile.
