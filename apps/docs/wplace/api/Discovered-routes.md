---
title: Discovered routes
description: What Wplace's hosts and backend routes answered to anonymous requests on 26 November 2026.
order: 0
tags: [source/probe]
---

This page records what Wplace answered when asked directly, without an account. It covers which hosts exist and which backend routes answer what. Checked on 26 November 2026.

All requests were anonymous `GET` or `HEAD`, sent at most once per second, with no cookies. Placeholders stand in for real ids.

## Hosts

Certificate transparency (crt.sh) and public DNS list these hosts. All resolve to Cloudflare.

| Host | What it serves |
| --- | --- |
| `wplace.live`, `www.wplace.live` | The web client, its [[Get-app-version\|version file]] at `/_app/version.json`, and `/site.webmanifest` |
| `backend.wplace.live` | The API in this reference, and map tiles under `/files/` |
| `maps.wplace.live` | The base map: [[Get-map-style\|style]], [[Get-map-tilejson\|vector tiles]], fonts, sprites and relief |
| `geocoding.wplace.live` | [[Search-places\|Place search]], a Pelias geocoder |
| `files.wplace.live` | Cosmetic images, such as profile frames under `/img/frames/` and `/img/uploads/` |
| `staging.wplace.live`, `staging-v2.wplace.live`, `backend-staging.wplace.live`, `maps-staging.wplace.live` | Staging copies; not requested |
| `map.wplace.live` | Has a certificate, but no DNS record |

`geocoding.wplace.live` has no certificate of its own in the logs; the wildcard `*.wplace.live` covers it.

## Backend routes

Every route that answered something other than `404`. "Session" means the route needs the `j` cookie.

| Method | Path | Status | Auth | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/health` | 200 | none | `{ up }`; see [[Get-health]] |
| `GET` | `/me` | 401 | session | [[Error]] |
| `GET` | `/map/hotspots` | 200 | none | Ten [[Hotspot\|hotspots]], not cached |
| `GET` | `/s0/tile/random` | 200 | none | A [[Random-tile]] |
| `GET` | `/s1/tile/random`, `/s2/tile/random` | 400 | none | [[Error]]: unknown season |
| `GET` | `/s0/pixel/{tileX}/{tileY}?x=&y=` | 200 | none | [[Pixel-info]] |
| `GET` | `/s0/pixel/{tileX}/{tileY}` | 200 | none | Pixel (0, 0) of the tile |
| `GET` | `/s0/pixel/{tileX}/{tileY}?x=1000&y=0` | 400 | none | [[Error]]: out of range |
| `GET` | `/s1/pixel/{tileX}/{tileY}?x=&y=` | 400 | none | A short error body that is not valid JSON |
| `HEAD` | `/files/s0/tiles/{tileX}/{tileY}.png` | 200 | none | PNG, `Cache-Control: s-maxage=5, must-revalidate, no-store` |
| `GET` | `/leaderboard/player/{period}` | 200 | none | 50 [[Player-leaderboard-entry\|players]]; `?country=` works |
| `GET` | `/leaderboard/player/all-time?region={regionId}` | 400 | none | [[Error]] |
| `GET` | `/leaderboard/player/year`, `/yesterday` | 400 | none | [[Error]]: unknown period |
| `GET` | `/leaderboard/player/{period}/me` | 401 | session | [[Error]] |
| `GET` | `/leaderboard/alliance/{period}` | 200 | none | 50 [[Alliance-leaderboard-entry\|alliances]] |
| `GET` | `/leaderboard/alliance/{period}/me` | 401 | session | [[Error]] |
| `GET` | `/leaderboard/country/{period}` | 200 | none | 50 [[Country-leaderboard-entry\|countries]] |
| `GET` | `/leaderboard/region/{period}/{countryId}` | 200 | none | 50 [[Region-leaderboard-entry\|regions]] |
| `GET` | `/leaderboard/region/players/{regionId}/{period}` | 200 | none | Up to 50 players |
| `GET` | `/leaderboard/region/alliances/{regionId}/{period}` | 200 | none | Up to 50 alliances |
| `GET` | `/leaderboard/player-regions?country=` | 200 | none | [[Player-regions-page]] |
| `GET` | `/alliances?sort=&page=` | 200 | none | [[Alliance-gallery-page]]; `q` and `joinPolicy` work |
| `GET` | `/alliances/{allianceId}` | 200 | none | [[Alliance-profile]] |
| `GET` | `/alliances/{allianceId}/members?page=&role=&sort=` | 200 | none | [[Alliance-members-page]] |
| `GET` | `/alliances/{allianceId}/awards?page=` | 200 | none | [[Alliance-awards-page]] |
| `GET` | `/alliances/{allianceId}/headquarters` | 200 | none | [[Headquarters]], not cached |
| `GET` | `/alliances/{allianceId}/headquarters/manifest` | 200 | none | [[Headquarters-manifest]], not cached |
| `GET` | `/alliances/{allianceId}/viewer` | 401 | session | [[Error]] |
| `GET` | `/alliances/headquarters/pins?minLat=&maxLat=&minLng=&maxLng=` | 200 | none | [[Headquarters-pin\|Pins]] |
| `GET` | `/store/catalog?platform=web` | 200 | none | [[Store-catalog]], cached 30 s |
| `GET` | `/store/offers?platform=web` | 200 | none | [[Store-offers]], cached 30 s |
| `GET` | `/store/catalog/me`, `/store/frames`, `/store/name` | 401 | session | [[Error]] |
| `GET` | `/notification/count`, `/notification/push/config` | 401 | session | [[Error]] |
| `GET` | `/alliance`, `/alliance/templates`, `/alliance/leaderboard/{period}` | 401 | session | [[Error]] |
| `GET` | `/me/settings`, `/payment/history` | 401 | session | [[Error]] |
| `GET` | `/paint` | 403 | challenge | A Cloudflare challenge page |
| `GET` | `/report-user` | 403 | challenge | A Cloudflare challenge page |

These answered `404`: `/files/s1/tiles/…`, tiles at column 2048, `/alliances/{allianceId}/headquarters/image`, `/assets/picture` and `/assets/banner` without `?v=`, `GET` on `/alliances/{allianceId}/headquarters/snapshot`, and an unknown alliance id.

No response carried CORS headers, because no request sent an `Origin`. Session routes answer `401` with the JSON [[Error]] body, never a redirect.

## Not checked

Cloudflare challenged `GET /paint` and then `GET /report-user`, and probing stopped there, as planned. These were not checked:

- `405` and `Allow` headers on the other POST-only routes
- `OPTIONS` and CORS preflight answers
- common operations paths: `/status`, `/version`, `/metrics`, `/openapi.json`, `/swagger`, `/docs`, `/graphql`, `/robots.txt`, `/sitemap.xml` and `/.well-known/*`
- any staff route
- the staging hosts

Related: [[Rate-limits]], [[Painter-attribution]].
