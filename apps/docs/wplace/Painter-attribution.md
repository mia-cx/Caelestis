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

The response names the last account to paint that pixel. The endpoint sent no rate-limit headers, and 30 requests in a row all succeeded.

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

The privacy setting "Show last painted pixel on alliance" (`showLastPixel`, saved with `POST /me/privacy`) controls one thing. It decides whether your alliance's admins see a button that jumps to your last painted pixel in the member list.

It does not hide you on the pixel endpoint above. No privacy setting does. Anyone who clicks a pixel you painted sees your name, so a painter history like the one above includes players with the setting off.

## Other attribution data

| Endpoint | Who can call it | What it ties together |
| --- | --- | --- |
| `GET /leaderboard/player/{period}` | anyone | top painters, with pixel counts, alliance and any linked Discord account the player chose to show |
| `GET /leaderboard/region/players/{regionId}/{period}` | anyone | top painters in one region |
| `GET /alliances/{id}/members` | anyone | an alliance's member names and roles |
| `GET /alliances/{id}/headquarters` | anyone | an alliance's headquarters location |
| alliance member list, admin view | alliance admins | each member's last painted pixel location, unless the member turned `showLastPixel` off |
| staff area and pixel tools | Wplace staff only | the painters of every pixel in an area |

## For app authors

A painter history is personal data about real people, and players often paint near where they live. If you build attribution, keep it to the artwork your users asked you to track, such as their own alliance's templates. Don't run a map-wide index of individual players.
