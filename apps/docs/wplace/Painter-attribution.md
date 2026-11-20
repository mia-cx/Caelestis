---
title: Painter attribution
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

The response names the last account to paint that pixel. One call covers one pixel.

## Rate limits

Cloudflare configures the request counting period and the mitigation timeout separately. The Wplace measurements suggest a counting period of about 15 seconds and show a 60-second block after the rate limit trips. Blocked API requests returned HTTP `429` with `error code: 1015`. The `Retry-After` header counted down from 60 to 53 seconds, showing the time left on the block. Requests that failed with HTTP `400` counted toward the limit. [Cloudflare rate limiting parameters](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/#for-duration)

| Steady rate | Result |
| --- | --- |
| 5 requests per second | 300 requests over 60 seconds without a block |
| 6 requests per second | blocked after about 18 seconds |
| 7 or more requests per second | blocked within 15 seconds |

Map tiles under `/files/` are not part of this limit: 300 tile requests in 7 seconds all went through, and tiles stayed reachable while the API was blocked. These numbers were measured from one IP address on 20 November 2026.

## Where painting changes

Map tiles are public PNGs:

```http
GET https://backend.wplace.live/files/s0/tiles/{x}/{y}.png
```

The CDN caches a tile for 5 seconds (`s-maxage=5`). Each tile carries an `ETag` and `Last-Modified`, so an app can tell when a tile changed without comparing images.

`GET /map/hotspots` needs no account. It lists the regions with the most painting right now, with a latitude, longitude and pixel count for each.

## Putting them together

None of these endpoints tracks a player on its own. Combined, they build a full painter history:

1. Watch the tiles in active areas, using `/map/hotspots` to find them.
2. When a tile changes, compare it with the last copy to find the changed pixels.
3. Look up each changed pixel's painter.
4. Store pixel, painter, alliance and time.

Index that store by player id and it lists every pixel a player painted. Index it by alliance id and it covers an alliance. The method needs no access to Wplace's servers beyond what the website itself uses, and it sends nothing that could be mistaken for painting.

## Privacy settings

`POST /me/privacy` saves four settings. None of them is a "private profile":

| Setting | What it changes |
| --- | --- |
| `showLastPixel` | Whether your alliance's leaderboard shows your last painted pixel location |
| `showDiscord` | Whether leaderboards and profiles show your Discord handle |
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

Hotspots and region leaderboards can point at one player. In two of three samples, a hotspot's pixel count matched exactly one player's daily count on that region's leaderboard. That gives a location and a name together. `hotspotsOptOut` is the only guard, and it is off by default.

Some leaderboard entries carry a numeric `discordId` with no `discord` handle. If those players turned `showDiscord` off, the setting hides the handle but not the ID. This is unconfirmed.

## For app authors

A painter history is personal data about real people, and players often paint near where they live. If you build attribution, keep it to the artwork your users asked you to track, such as their own alliance's templates. Don't run a map-wide index of individual players.
