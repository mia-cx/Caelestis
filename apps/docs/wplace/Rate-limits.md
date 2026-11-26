---
title: Rate limits
description: How many requests Wplace's API and map tiles allow per IP address, what a block looks like, and how IPv6 is counted.
---

Wplace's backend has two Cloudflare rate limits: one for the API, and a higher one for map tiles. Each counts requests per IP address over a sliding window. Going over either limit blocks the address for 60 seconds with HTTP `429` and `error code: 1015`, and `Retry-After` counts down the time left on the block. [Cloudflare rate limiting parameters](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/#for-duration)

| Limit | Covers | Allows |
| --- | --- | --- |
| API | every endpoint except tiles | about 80 requests per 16 seconds, or 5 per second sustained |
| Tiles | `/files/` | about 600 requests per 21 seconds, or 28.5 per second sustained |

The two limits block separately. Tiles stay reachable from an address the API has blocked, and the API keeps answering an address the tile limit has blocked. Over IPv6, Wplace's own server also limits the API, per network rather than per address (see [IPv6](#ipv6)).

Measured on 20 November 2026, and the API limit rechecked on 25 November 2026. Every test asked for a different URL on each request, and no response came from Cloudflare's cache.

## API

Every API endpoint shares one counter. Pixel lookups, `/alliances/{id}`, and the two alternating were all blocked at the same point. Requests that fail, such as a `400` or a `404`, still count. A block covers every API endpoint, including `/me`.

| Requests per second | Result |
| --- | --- |
| 5 | 300 requests over 60 seconds without a block |
| 5.06 | blocked on request 99, after 19 seconds |
| 5.5 | blocked on request 121, after 22 seconds |
| 10 | blocked between request 81 and 95 |
| 20 or 40 | blocked on request 81 |

### IPv6

Over IPv6, Wplace's own server adds a second API limit, which counts a whole `/64` network as one client. It blocks sooner than Cloudflare's: at 10 requests per second, on request 67. Every address in the `/64` is then blocked too.

Its block is short. The `429` has a JSON body, `{"error":"Too Many Requests","status":429}`, and `Retry-After: 1`. Its sustained rate, and whether it groups wider networks than a `/64`, are not measured yet.

## Tiles

The CDN caches a tile for 5 seconds. After that, the next request for it goes back to Wplace's server to revalidate.

| Requests per second | Result |
| --- | --- |
| 28.2 | no block over 75 seconds |
| 28.8 | blocked on request 913, after 32 seconds |
| 33.2 | blocked on request 844, after 25 seconds |
| 58.4 | blocked on request 698, after 12 seconds |
| 97.9 | blocked on request 609, after 6 seconds |
