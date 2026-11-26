---
title: Painter attribution
description: Which public Wplace endpoints reveal who painted a pixel, and what an app can learn by combining them.
---

Wplace shows the painter of any pixel to anyone who clicks it. This page lists the public endpoints that tie painters to places, and what they let an app work out. Checked on 20 November 2026.

## Who painted a pixel

```http
GET https://backend.wplace.live/s0/pixel/{tileX}/{tileY}?x={x}&y={y}
```

The request needs no account and no cookies. `s0` is the current season. `tileX` and `tileY` pick a 1000 × 1000 tile, and `x` and `y` pick a pixel inside it.

```json
{
  "paintedBy": {
    "id": 8300772,
    "name": "…",
    "allianceId": 275715,
    "allianceName": "…",
    "equippedFlag": 0,
    "banned": true
  },
  "region": { "id": 85779, "cityId": 699, "name": "Berlin", "number": 7, "countryId": 82 }
}
```

The response names the last account to paint that pixel. It also carries cosmetics, such as `avatarSeed` and `equippedBadges`, and the painter's Discord handle and id (`discord`, `discordId`) when they show them. It carries no paint time, so an app that records changes knows only when it saw them. One call covers one pixel.

Pixel lookups count toward the API [rate limit](Rate-limits): about 80 requests per 16 seconds per IP address.

## Where painting changes

Map tiles are public PNGs:

```http
GET https://backend.wplace.live/files/s0/tiles/{x}/{y}.png
```

The CDN caches a tile for 5 seconds (`s-maxage=5`), then revalidates it with Wplace's server on the next request. Tiles have their own, higher [rate limit](Rate-limits). Each tile carries an `ETag` and `Last-Modified`, so an app can tell when a tile changed without comparing images.

`GET /map/hotspots` needs no account. It lists the regions with the most painting right now, with a latitude, longitude and pixel count for each.

The canvas is a Web Mercator map at zoom 11: 2048 × 2048 tiles of 1000 × 1000 pixels. To find the tile and pixel under a latitude and longitude:

```ts
const WORLD_PIXELS = 2048 * 1000
const lat = (latitude * Math.PI) / 180
const px = ((longitude + 180) / 360) * WORLD_PIXELS
const py = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * WORLD_PIXELS

const tileX = Math.floor(px / 1000), x = Math.floor(px) % 1000
const tileY = Math.floor(py / 1000), y = Math.floor(py) % 1000
```

Berlin, at 52.52° N 13.40° E, falls on tile 1100/671.

## Putting them together

None of these endpoints tracks a player on its own. Combined, they build a full painter history:

1. Watch the tiles in active areas, using `/map/hotspots` to find them.
2. When a tile changes, compare it with the last copy to find the changed pixels.
3. Look up each changed pixel's painter.
4. Store pixel, painter, alliance and time.

Index that store by player id and it lists every pixel a player painted. Index it by alliance id and it covers an alliance.

Step 3 is the bottleneck. Each changed pixel needs its own lookup, and the API limit allows about 18,000 lookups an hour from one IP address.

The method needs no access to Wplace's servers beyond what the website itself uses, and it sends nothing that could be mistaken for painting.

## Privacy settings

`POST /me/privacy` saves four settings. None of them is a "private profile":

| Setting | What it changes |
| --- | --- |
| `showLastPixel` | Whether your alliance's leaderboard shows your last painted pixel location |
| `showDiscord` | Whether leaderboards, profiles and pixel lookups show your Discord handle |
| `hotspotsOptOut` | Whether your painting counts toward the public hotspots list |
| `hideAllianceHqPins` | Whether your own map shows alliance headquarters pins |

None of them hides you on the pixel endpoint above. Anyone who clicks a pixel you painted sees your name, so a painter history like the one above includes every player.

## Other attribution data

| Endpoint | Who can call it | What it ties together |
| --- | --- | --- |
| `GET /map/hotspots` | anyone | the busiest regions, with coordinates and pixel counts |
| `GET /leaderboard/region/players/{regionId}/{period}` | anyone | the top painters in one region |
| `GET /leaderboard/player/{period}` | anyone | the top painters, with pixel counts, alliance and Discord handle if shown |
| `GET /alliances/{id}/members` | anyone | an alliance's member names and roles |
| `GET /alliances/{id}/headquarters` | anyone | an alliance's headquarters location, if the alliance makes it visible |
| `GET /alliance/leaderboard/{period}` | alliance members | each member's last painted pixel location, unless they turned `showLastPixel` off |
| staff area, pixel and wayback tools | Wplace staff only | the painters of every pixel in an area, and each tile's paint history |

Hotspots and region leaderboards can point at one player. Each hotspot carries a `regionId` and a pixel count. In 3 of the 10 hotspots listed on 21 November 2026, the region's daily leaderboard (`/leaderboard/region/players/{regionId}/today`) had a single painter whose count matched the hotspot's exactly. That gives a location and a name together. `hotspotsOptOut` is the only guard, and it is off by default.

A leaderboard entry carries both `discord` (the handle) and `discordId`, or neither. Of 50 entries on the daily player leaderboard, 17 had both, 32 had neither, and 1 had a `discordId` with no handle, for an unknown reason.

## For app authors

A painter history is personal data about real people, and players often paint near where they live. If you build attribution, keep it to the artwork your users asked you to track, such as their own alliance's templates. Don't run a map-wide index of individual players.
